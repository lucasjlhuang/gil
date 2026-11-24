import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { app, nativeImage } from 'electron'
import { newAssetId, type Asset } from '../shared/asset'
import {
  BRIDGE_HOST,
  BRIDGE_PATHS,
  BRIDGE_PORT,
  MAX_UPLOAD_BYTES,
  META_HEADER,
  type CaptureMeta,
} from '../shared/bridge'
import type { BridgeStatus } from '../shared/channels'
import { rectToVideoCrop } from '../shared/geometry'
import { checkRequest, decodeMeta, isRejection, type Rejection } from './bridgeRequest'
import { saveRecording, saveScreenshot } from './saveCapture'
import { writeFileAtomic } from './storage'

const TOKEN_FILE = 'bridge-token'

class UploadTooLarge extends Error {}

/**
 * The local bridge the Chrome extension sends captures to. Listens on the loopback address only
 * and accepts nothing without the pairing code (see bridgeRequest.ts). The body is the whole
 * visible tab; it is written to a temp file outside the library, cropped into an asset, and
 * always deleted.
 */
export class Bridge {
  private server: Server | null = null
  private token = ''
  private state: Pick<BridgeStatus, 'state'> & { error?: string } = { state: 'starting' }

  constructor(
    private readonly deps: { libraryRoot: () => string; onSaved: (asset: Asset) => void },
  ) {}

  async init(): Promise<void> {
    this.token = await loadOrCreateToken()
    // Page styles travel in the metadata header, which can pass Node's default 16 KB limit (boxes and motion included, up to about 60 KB).
    const server = createServer({ maxHeaderSize: 128 * 1024 }, (request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        console.error('Bridge request failed', error)
        if (!response.headersSent) send(response, 500, { error: 'gil could not save the capture' })
      })
    })
    server.on('error', (error: NodeJS.ErrnoException) => {
      const message =
        error.code === 'EADDRINUSE'
          ? `Port ${BRIDGE_PORT} is in use by another app, so the Chrome extension cannot reach gil.`
          : error.message
      console.error(`Bridge: ${message}`)
      this.state = { state: 'failed', error: message }
    })
    server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
      this.state = { state: 'listening' }
    })
    this.server = server
  }

  getStatus(): BridgeStatus {
    const common = {
      port: BRIDGE_PORT,
      pairingCode: this.token,
      // Loaded unpacked in Chrome: inside the packaged app's resources, or `pnpm build` output.
      extensionFolder: app.isPackaged
        ? join(process.resourcesPath, 'extension')
        : join(app.getAppPath(), 'out', 'extension'),
    }
    return this.state.state === 'failed'
      ? { ...common, state: 'failed', error: this.state.error ?? 'The bridge failed' }
      : { ...common, state: this.state.state }
  }

  close(): void {
    this.server?.close()
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rejected = checkRequest(
      {
        host: request.headers.host,
        origin: request.headers.origin,
        authorization: request.headers.authorization,
      },
      { port: BRIDGE_PORT, token: this.token },
    )
    if (rejected) return reject(request, response, rejected)

    const path = new URL(request.url ?? '/', `http://${BRIDGE_HOST}`).pathname
    if (request.method === 'GET' && path === BRIDGE_PATHS.ping) {
      return send(response, 200, { app: 'gil', version: app.getVersion() })
    }
    if (request.method !== 'POST' || path !== BRIDGE_PATHS.captures) {
      return reject(request, response, { status: 404, error: 'Not found' })
    }

    const header = request.headers[META_HEADER]
    const meta = decodeMeta(typeof header === 'string' ? header : undefined)
    if (isRejection(meta)) return reject(request, response, meta)
    const declared = Number(request.headers['content-length'] ?? NaN)
    if (declared > MAX_UPLOAD_BYTES) {
      return reject(request, response, { status: 413, error: 'Capture is too large' })
    }

    const id = newAssetId()
    const uploadPath = join(app.getPath('temp'), `gil-${id}.upload`)
    try {
      await receive(request, uploadPath)
      const asset = await this.save(id, meta, uploadPath)
      send(response, 201, { name: asset.name })
      this.deps.onSaved(asset)
    } catch (error) {
      if (error instanceof UploadTooLarge) {
        return send(response, 413, { error: 'Capture is too large' })
      }
      const message = error instanceof Error ? error.message : String(error)
      send(response, 422, { error: message })
    } finally {
      // The upload is the whole tab and can contain anything; never keep it.
      await rm(uploadPath, { force: true })
    }
  }

  private async save(id: string, meta: CaptureMeta, uploadPath: string): Promise<Asset> {
    const common = {
      id,
      root: this.deps.libraryRoot(),
      context: meta.context,
      source: { app: meta.browser, windowTitle: meta.title, url: meta.url },
      ...(meta.pageStyles ? { pageStyles: meta.pageStyles } : {}),
    }
    if (meta.mode === 'recording') {
      const { crop, scale } = rectToVideoCrop(meta.region, meta.viewport, meta.frame)
      return saveRecording({ ...common, crop, scale, recordingPath: uploadPath, durationMs: Math.round(meta.durationMs) })
    }
    const image = nativeImage.createFromBuffer(await readFile(uploadPath))
    if (image.isEmpty()) throw new Error('The screenshot is not a readable image')
    const { crop, scale } = rectToVideoCrop(meta.region, meta.viewport, image.getSize(), { even: false })
    return saveScreenshot({ ...common, crop, scale, png: image.crop(crop).toPNG() })
  }
}

async function loadOrCreateToken(): Promise<string> {
  const path = join(app.getPath('userData'), TOKEN_FILE)
  const existing = await readFile(path, 'utf8').catch(() => '')
  if (existing.trim()) return existing.trim()
  const token = randomBytes(18).toString('base64url')
  await writeFileAtomic(path, token)
  return token
}

/** Streams the request body to a file, failing once it passes the size limit. */
async function receive(request: IncomingMessage, path: string): Promise<void> {
  let total = 0
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      callback(total > MAX_UPLOAD_BYTES ? new UploadTooLarge() : null, chunk)
    },
  })
  await pipeline(request, limit, createWriteStream(path))
  if (total === 0) throw new Error('The capture was empty')
}

function send(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** Answers without reading the body, and closes the connection so an unread upload stops. */
function reject(request: IncomingMessage, response: ServerResponse, rejection: Rejection): void {
  response.setHeader('Connection', 'close')
  send(response, rejection.status, { error: rejection.error })
  request.resume()
}
