import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell } from 'electron'
import {
  LibraryChannel,
  type LibraryItem,
  type LibraryListing,
  type ActionResult,
  type ApiKeyResult,
  type AppInfo,
  type AssetDetails,
  type ScreenPermission,
} from '../shared/channels'
import type { Asset } from '../shared/asset'
import { parseRange } from '../shared/httpRange'
import {
  apiKeyInputSchema,
  assetIdSchema,
  copyTextSchema,
  glossaryInputSchema,
  importPathsSchema,
  designSystemRequestSchema,
  membersRequestSchema,
  noteRequestSchema,
  focusRequestSchema,
  notesRequestSchema,
  runLensRequestSchema,
  refineRequestSchema,
  renameRequestSchema,
  saveEditsRequestSchema,
  tagsRequestSchema,
} from '../shared/ipc'
import { applyEdits, EDITABLE_PROPERTIES } from '../shared/edits'
import { promptSnippet } from '../shared/promptSnippet'
import { RECREATION_CSP, RECREATION_SCHEME, wrapRecreation } from '../shared/recreation'
import { isValidSlug } from '../shared/slug'
import { versionLabel } from '../shared/version'
import { migrateSpec, specSchema, type Spec } from '../shared/spec'
import { checkApiKey } from './analysis/claude'
import type { AnalysisQueue } from './analysis/queue'
import { clearApiKey, hasApiKey, loadApiKey, saveApiKey } from './apiKey'
import { readRecreation, renameAndRetitle, saveEdits, setTags, trashAsset } from './assets'
import type { Bridge } from './bridge'
import { duplicateForLens, makeColorSystem } from './colorLens'
import { makeSpacingSystem } from './spacingLens'
import { identifyFont } from './fontIdentify'
import { importClipboardImage, importImageFile, IMAGE_EXTENSIONS } from './importImage'
import { createDesignSystem, createNote, exportAsset, readGlossary, readMembers, readNotes, saveGlossary, saveNotes, setFocus, setMembers } from './libraryFiles'
import { connectClaudeDesktop, installSkill, mcpStatus } from './mcpConnect'
import {
  openScreenRecordingSettings,
  requestScreenPermission,
  screenPermission,
} from './permissions'
import {
  CAPTURE_DIR,
  CLIP_FILE,
  POSTER_FILE,
  RECREATION_DIR,
  RECREATION_FILE,
  scanLibrary,
  SPEC_FILE,
  SPEC_MD_FILE,
} from './storage'
import { loadRenderer, lockNavigation, rendererPreferences } from './windows'

export const ASSET_SCHEME = 'gil-asset'

/** The only files the library window can load, by the last segment of the URL. */
const SERVED_FILES: Record<string, { path: string[]; type: string }> = {
  clip: { path: [CAPTURE_DIR, CLIP_FILE], type: 'video/mp4' },
  poster: { path: [CAPTURE_DIR, POSTER_FILE], type: 'image/png' },
}

export function appInfo(): AppInfo {
  const version = app.getVersion()
  return { version, commit: __GIL_COMMIT__, label: versionLabel(version, __GIL_COMMIT__) }
}

export function libraryRoot(): string {
  return join(homedir(), 'Documents', 'gil')
}

/** Where the library was before the app was renamed from Gilbert to gil. */
export function legacyLibraryRoot(): string {
  return join(homedir(), 'Documents', 'Gilbert')
}

/** Must run before the app is ready. */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, stream: true } },
    // Its own scheme, so a recreation is never served from the asset protocol or the app.
    { scheme: RECREATION_SCHEME, privileges: { standard: true, secure: true } },
  ])
}

/**
 * Serves `gil-recreation://asset/<name>/` (only that asset's recreation/index.html) with a
 * Content-Security-Policy that blocks all network access. The library shows it in an iframe
 * sandboxed to scripts only, so it has no same-origin access to anything.
 */
function handleRecreationRequest(root: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const [name, ...rest] = url.pathname.split('/').filter(Boolean)
    const file = rest.length === 0 || (rest.length === 1 && rest[0] === RECREATION_FILE)
    if (url.hostname !== 'asset' || !name || !isValidSlug(name) || !file) {
      return new Response(null, { status: 404 })
    }
    const html = await readFile(join(root, name, RECREATION_DIR, RECREATION_FILE), 'utf8').catch(
      () => null,
    )
    if (html === null) return new Response(null, { status: 404 })
    return new Response(wrapRecreation(html, EDITABLE_PROPERTIES), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': RECREATION_CSP,
        'Cache-Control': 'no-store',
      },
    })
  }
}

async function readDetails(root: string, name: string): Promise<AssetDetails> {
  const empty: AssetDetails = { spec: null, specMarkdown: null, base: null, edits: null, html: null, prompt: '', notes: '', members: [] }
  if (!isValidSlug(name)) return empty
  const dir = join(root, name)
  const [specText, specMarkdown, recreation, notes] = await Promise.all([
    readFile(join(dir, SPEC_FILE), 'utf8').catch(() => null),
    readFile(join(dir, SPEC_MD_FILE), 'utf8').catch(() => null),
    readRecreation(root, name),
    readNotes(root, name),
  ])
  const members = await readMembers(root, name)
  let spec: Spec | null
  try {
    const parsed = specText ? specSchema.safeParse(migrateSpec(JSON.parse(specText))) : null
    spec = parsed?.success ? parsed.data : null
  } catch {
    spec = null
  }
  const html = recreation ? applyEdits(recreation.base, recreation.edits) : null
  return {
    spec,
    specMarkdown,
    base: recreation?.base ?? null,
    edits: recreation?.edits ?? null,
    html,
    prompt: promptSnippet({ name, specMarkdown, html }),
    notes,
    members,
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  )
}

/**
 * Serves `gil-asset://asset/<name>/clip|poster` read-only from the library folder.
 * The name must be a valid slug, so a URL can never reach outside the library.
 */
function handleAssetRequest(root: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const [name, kind, ...rest] = url.pathname.split('/').filter(Boolean)
    const served = kind ? SERVED_FILES[kind] : undefined
    if (url.hostname !== 'asset' || !name || !isValidSlug(name) || !served || rest.length > 0) {
      return new Response(null, { status: 404 })
    }
    const path = join(root, name, ...served.path)
    const stats = await stat(path).catch(() => null)
    if (!stats?.isFile()) return new Response(null, { status: 404 })

    const result = parseRange(request.headers.get('range'), stats.size)
    const headers = new Headers({
      'Content-Type': served.type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    })
    if (result.kind === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${stats.size}`)
      return new Response(null, { status: 416, headers })
    }
    const range = result.kind === 'partial' ? result.range : null
    const start = range?.start ?? 0
    const end = range?.end ?? stats.size - 1
    headers.set('Content-Length', String(stats.size === 0 ? 0 : end - start + 1))
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${stats.size}`)
    if (stats.size === 0) return new Response(null, { status: 200, headers })

    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>
    return new Response(body, { status: range ? 206 : 200, headers })
  }
}

async function listLibrary(root: string): Promise<LibraryListing> {
  const { assets, skipped } = await scanLibrary(root)
  const items = await Promise.all(
    assets.map(async (asset): Promise<LibraryItem> => {
      const base = `${ASSET_SCHEME}://asset/${asset.name}`
      const version = encodeURIComponent(asset.updatedAt)
      const [hasPoster, hasClip, hasRecreation] = await Promise.all([
        exists(join(root, asset.name, CAPTURE_DIR, POSTER_FILE)),
        exists(join(root, asset.name, CAPTURE_DIR, CLIP_FILE)),
        exists(join(root, asset.name, RECREATION_DIR, RECREATION_FILE)),
      ])
      return {
        asset,
        posterUrl: hasPoster ? `${base}/poster?v=${version}` : null,
        clipUrl: hasClip ? `${base}/clip?v=${version}` : null,
        recreationUrl: hasRecreation
          ? `${RECREATION_SCHEME}://asset/${asset.name}/?v=${version}`
          : null,
      }
    }),
  )
  return { root, items, skipped }
}

export class LibraryWindow {
  private window: BrowserWindow | null = null
  /** Called with each new library window. */
  onWindowCreated: ((window: BrowserWindow) => void) | null = null
  /** Assets whose font is being identified. */
  private readonly identifying = new Set<string>()
  /** The Chrome extension's bridge, for Settings. */
  bridge: Bridge | null = null
  /** An image was imported; analyzed like a new capture. */
  onImported: ((asset: Asset) => void) | null = null

  /** `startCapture` is injected to avoid a dependency cycle with the capture controller. */
  /** Set once the analysis queue exists. */
  analysis: AnalysisQueue | null = null

  constructor(
    private readonly startCapture: (force: boolean) => void,
  ) {}

  init(): void {
    const root = libraryRoot()
    protocol.handle(ASSET_SCHEME, handleAssetRequest(root))
    protocol.handle(RECREATION_SCHEME, handleRecreationRequest(root))

    const fromLibrary = (sender: Electron.WebContents) =>
      this.window !== null && !this.window.isDestroyed() && sender === this.window.webContents
    const handle = <T>(channel: string, handler: (arg: unknown) => T | Promise<T>) => {
      ipcMain.handle(channel, (event, arg: unknown) => {
        if (!fromLibrary(event.sender)) throw new Error('Unexpected sender')
        return handler(arg)
      })
    }
    handle(LibraryChannel.list, () => listLibrary(root))
    handle(LibraryChannel.appInfo, () => appInfo())
    handle(LibraryChannel.permission, (): ScreenPermission => screenPermission())
    handle(LibraryChannel.requestPermission, () => requestScreenPermission())
    handle(LibraryChannel.openPermissionSettings, () => openScreenRecordingSettings())
    handle(LibraryChannel.relaunch, () => {
      app.relaunch()
      app.exit(0)
    })
    handle(LibraryChannel.capture, (force) => this.startCapture(force === true))
    handle(LibraryChannel.analyze, async (id) => {
      const parsed = assetIdSchema.safeParse(id)
      if (parsed.success) await this.analysis?.enqueue(parsed.data)
    })
    handle(LibraryChannel.refine, async (payload) => {
      const parsed = refineRequestSchema.safeParse(payload)
      if (parsed.success) await this.analysis?.enqueue(parsed.data.id, parsed.data.instruction)
    })
    handle(LibraryChannel.details, (name) =>
      readDetails(root, typeof name === 'string' ? name : ''),
    )
    handle(LibraryChannel.copy, (text) => {
      const parsed = copyTextSchema.safeParse(text)
      if (parsed.success) clipboard.writeText(parsed.data)
    })
    const action = async (work: () => Promise<unknown>): Promise<ActionResult> => {
      try {
        await work()
        this.notifyChanged()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    handle(LibraryChannel.rename, (payload) => {
      const parsed = renameRequestSchema.safeParse(payload)
      if (!parsed.success) return { ok: false, error: 'Invalid request' }
      return action(() => renameAndRetitle(root, parsed.data.id, parsed.data))
    })
    handle(LibraryChannel.setTags, (payload) => {
      const parsed = tagsRequestSchema.safeParse(payload)
      if (!parsed.success) return { ok: false, error: 'Invalid request' }
      return action(() => setTags(root, parsed.data.id, parsed.data.tags))
    })
    handle(LibraryChannel.saveEdits, (payload) => {
      const parsed = saveEditsRequestSchema.safeParse(payload)
      if (!parsed.success) return { ok: false, error: 'Those edits are not valid' }
      return action(() => saveEdits(root, parsed.data.id, parsed.data.edits))
    })
    handle(LibraryChannel.trash, (id) => {
      const parsed = assetIdSchema.safeParse(id)
      if (!parsed.success) return { ok: false, error: 'Invalid request' }
      return action(() => trashAsset(root, parsed.data))
    })
    handle(LibraryChannel.hasApiKey, () => hasApiKey())
    handle(LibraryChannel.mcpStatus, () => mcpStatus())
    handle(LibraryChannel.bridgeStatus, () => this.bridge?.getStatus() ?? null)
    handle(LibraryChannel.revealExtension, () => {
      const folder = this.bridge?.getStatus().extensionFolder
      if (folder) shell.showItemInFolder(folder)
    })
    handle(LibraryChannel.connectClaudeDesktop, () => action(() => connectClaudeDesktop()))
    handle(LibraryChannel.installSkill, () => action(() => installSkill()))
    handle(LibraryChannel.getGlossary, () => readGlossary(root))
    handle(LibraryChannel.saveGlossary, (terms) => {
      const parsed = glossaryInputSchema.safeParse(terms)
      if (!parsed.success) return { ok: false, error: 'Those terms are not valid' }
      return action(() => saveGlossary(root, parsed.data))
    })
    // New images are analyzed like captures when there is an API key.
    const imported = async (assets: Promise<Asset>[]): Promise<ActionResult> => {
      const results = await Promise.allSettled(assets)
      this.notifyChanged()
      for (const result of results) if (result.status === 'fulfilled') this.onImported?.(result.value)
      const failed = results.flatMap((result) => (result.status === 'rejected' ? [String(result.reason?.message ?? result.reason)] : []))
      return failed.length ? { ok: false, error: failed.join('\n') } : { ok: true }
    }
    handle(LibraryChannel.importFiles, (paths) => {
      const parsed = importPathsSchema.safeParse(paths)
      if (!parsed.success) return { ok: false, error: 'Nothing to import' }
      return imported(parsed.data.map((path) => importImageFile(root, path)))
    })
    handle(LibraryChannel.importClipboard, () => imported([importClipboardImage(root)]))
    handle(LibraryChannel.importDialog, async () => {
      const choice = await dialog.showOpenDialog({
        title: 'Import images',
        buttonLabel: 'Import',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS.map((extension) => extension.slice(1)) }],
      })
      if (choice.canceled || choice.filePaths.length === 0) return { ok: true }
      return imported(choice.filePaths.map((path) => importImageFile(root, path)))
    })
    handle(LibraryChannel.createNote, (payload) => {
      const parsed = noteRequestSchema.safeParse(payload)
      if (!parsed.success) return { ok: false, error: 'That note is not valid' }
      return action(() => createNote(root, parsed.data.title, parsed.data.text))
    })
    handle(LibraryChannel.runLens, (payload) => {
      const parsed = runLensRequestSchema.safeParse(payload)
      if (!parsed.success) return { ok: false, error: 'Invalid request' }
      const { id, lens } = parsed.data
      if (lens === 'color') return action(() => makeColorSystem(root, id))
      if (lens === 'spacing') return action(() => makeSpacingSystem(root, id))
      if (lens === 'font') {
        // One identification per asset at a time; it takes a model call and many downloads.
        if (this.identifying.has(id)) return { ok: false, error: 'gil is already identifying this font' }
        this.identifying.add(id)
        return action(async () => {
          const apiKey = await loadApiKey()
          if (!apiKey) throw new Error('Add your Anthropic API key in Settings first')
          await identifyFont(root, id, apiKey)
        }).finally(() => this.identifying.delete(id))
      }
      return action(async () => {
        const copy = await duplicateForLens(root, id, lens)
        if (await hasApiKey()) await this.analysis?.enqueue(copy.id)
      })
    })
    handle(LibraryChannel.createDesignSystem, (payload) => {
      const parsed = designSystemRequestSchema.safeParse(payload)
      if (!parsed.success) return { ok: false, error: 'That design system is not valid' }
      return action(() => createDesignSystem(root, parsed.data.title, parsed.data.memberIds))
    })
    handle(LibraryChannel.setMembers, (payload) => {
      const parsed = membersRequestSchema.safeParse(payload)
      if (!parsed.success) return { ok: false, error: 'Invalid request' }
      return action(() => setMembers(root, parsed.data.id, parsed.data.memberIds))
    })
    handle(LibraryChannel.saveNotes, (payload) => {
      const parsed = notesRequestSchema.safeParse(payload)
      if (!parsed.success) return { ok: false, error: 'Those notes are not valid' }
      return action(() => saveNotes(root, parsed.data.id, parsed.data.text))
    })
    handle(LibraryChannel.setFocus, (payload) => {
      const parsed = focusRequestSchema.safeParse(payload)
      if (!parsed.success) return { ok: false, error: 'That note is too long' }
      return action(() => setFocus(root, parsed.data.id, parsed.data.text))
    })
    handle(LibraryChannel.exportAsset, async (id) => {
      const parsed = assetIdSchema.safeParse(id)
      if (!parsed.success) return { ok: false, error: 'Invalid request' }
      const choice = await dialog.showOpenDialog({
        title: 'Export to a folder',
        buttonLabel: 'Export Here',
        properties: ['openDirectory', 'createDirectory'],
      })
      const folder = choice.filePaths[0]
      if (choice.canceled || !folder) return { ok: false, error: '' }
      try {
        return { ok: true, path: await exportAsset(root, parsed.data, folder) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
    // The key only ever travels this way, renderer to main; nothing sends it back.
    handle(LibraryChannel.setApiKey, async (input): Promise<ApiKeyResult> => {
      const parsed = apiKeyInputSchema.safeParse(input)
      if (!parsed.success) return { ok: false, error: 'That does not look like an API key.' }
      try {
        await checkApiKey(parsed.data)
      } catch (error) {
        const status = (error as { status?: unknown } | null)?.status
        return {
          ok: false,
          error:
            status === 401
              ? 'Anthropic rejected this key.'
              : 'Could not reach the Anthropic API to check the key.',
        }
      }
      await saveApiKey(parsed.data)
      return { ok: true }
    })
    handle(LibraryChannel.clearApiKey, () => clearApiKey())
  }

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show()
      this.window.focus()
    } else {
      const window = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 560,
        minHeight: 400,
        title: 'gil',
        show: false,
        webPreferences: rendererPreferences('library'),
      })
      lockNavigation(window)
      window.once('ready-to-show', () => window.show())
      window.on('closed', () => {
        if (this.window === window) this.window = null
      })
      void loadRenderer(window, 'library')
      this.window = window
      this.onWindowCreated?.(window)
    }
    // gil has no Dock icon, so it has to bring itself forward.
    app.focus({ steal: true })
  }

  notifyChanged(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(LibraryChannel.changed)
    }
  }
}
