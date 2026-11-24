import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, session } from 'electron'
import { createCaptureAsset, newAssetId, type Asset, type AssetLens } from '../shared/asset'
import { writeFileAtomic, writeAssetJson, CAPTURE_DIR, CLIP_FILE, POSTER_FILE } from './storage'
import { runFfmpeg } from './ffmpeg'

/**
 * For tests only (the benchmark's `grab`): captures part of a public web page the way gil's
 * overlay captures part of the screen, in a hidden window, so a test can be set up with no one at
 * the screen. The page runs in its own throwaway session with no permissions; nothing from the
 * user's own browser is used.
 */

const SCALE = 2
const FPS = 30
const SETTLE_MS = 2500

function hiddenWindow(width: number, height: number): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    webPreferences: {
      session: session.fromPartition(`gil-grab-${Date.now()}`),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      backgroundThrottling: false,
      offscreen: { deviceScaleFactor: SCALE },
    },
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return window
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A picture of a page's top at a width, to choose what to grab. */
export async function peekPage(url: string, width: number, height: number): Promise<Buffer> {
  const window = hiddenWindow(width, height)
  try {
    await window.loadURL(url)
    await wait(SETTLE_MS)
    return (await window.webContents.capturePage()).toPNG()
  } finally {
    window.destroy()
  }
}

export async function grabPage(input: {
  url: string
  root: string
  name: string
  /** CSS px of the page, from its top left. */
  rect: { x: number; y: number; width: number; height: number }
  lens: AssetLens
  /** 0 for a screenshot. */
  seconds: number
  note: string | null
}): Promise<Asset> {
  const { rect } = input
  // The window is the page's viewport; the region is cut from it.
  // The same size as `peekPage` uses, so a region chosen from a peek is the same region.
  const viewWidth = Math.max(rect.x + rect.width, 1280)
  const viewHeight = Math.max(rect.y + rect.height, 900)
  const window = hiddenWindow(viewWidth, viewHeight)
  const dir = join(input.root, input.name)
  const temp = await mkdtemp(join(tmpdir(), 'gil-grab-'))
  try {
    await window.loadURL(input.url)
    await wait(SETTLE_MS)
    const crop = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    await mkdir(join(dir, CAPTURE_DIR), { recursive: true })
    if (input.seconds <= 0) {
      const image = await window.webContents.capturePage(crop)
      await writeFileAtomic(join(dir, CAPTURE_DIR, POSTER_FILE), image.toPNG())
    } else {
      const frames = Math.round(input.seconds * FPS)
      const started = Date.now()
      for (let i = 0; i < frames; i++) {
        const due = started + (i * 1000) / FPS
        if (due > Date.now()) await wait(due - Date.now())
        const image = await window.webContents.capturePage(crop)
        await writeFileAtomic(join(temp, `${String(i).padStart(5, '0')}.png`), image.toPNG())
      }
      const count = (await readdir(temp)).length
      // Frames can come slower than asked; the clip's rate is what really came.
      const rate = Math.max(1, Math.round((count * 1000) / Math.max(1, Date.now() - started)))
      await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(rate), '-i', join(temp, '%05d.png'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, CAPTURE_DIR, CLIP_FILE)])
      await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', join(temp, '00000.png'), join(dir, CAPTURE_DIR, POSTER_FILE)])
    }
    const asset = createCaptureAsset({
      id: newAssetId(),
      name: input.name,
      title: input.name.replace(/-/g, ' '),
      userContext: input.note,
      lens: input.lens,
      source: { app: 'gil test grab', windowTitle: null, url: input.url },
      capture:
        input.seconds <= 0
          ? { mode: 'screenshot', width: rect.width, height: rect.height, scale: SCALE, durationMs: 0, isStill: true }
          : { mode: 'recording', width: rect.width, height: rect.height, scale: SCALE, durationMs: Math.round(input.seconds * 1000), isStill: false },
      now: new Date(),
    })
    await writeAssetJson(dir, asset)
    return asset
  } finally {
    window.destroy()
    await rm(temp, { recursive: true, force: true })
  }
}
