import { embedFonts } from '../fonts'
import { BrowserWindow, session, type NativeImage } from 'electron'
import { RECREATION_CSP, verifyDocument } from '../../shared/recreation'

/**
 * Renders a recreation frame by frame for the verify step, in a hidden window that is as
 * unprivileged as the library's preview: sandboxed, no Node, no preload, its own in-memory
 * session that refuses every request except the document itself, no permissions, no pop-ups or
 * navigation, and the recreation's no-network policy. The recreation's clock is virtual (see
 * `verifyDocument`), so each frame shows exactly the requested moment.
 */

const PARTITION = 'gil-verify'
const LOAD_TIMEOUT_MS = 15_000
const STEP_TIMEOUT_MS = 10_000

let sessionReady = false

function verifySession(): Electron.Session {
  const verify = session.fromPartition(PARTITION)
  if (!sessionReady) {
    verify.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith('data:') })
    })
    verify.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    sessionReady = true
  }
  return verify
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

export interface RenderOptions {
  /** CSS size of the capture. */
  width: number
  height: number
  /** Pixels per CSS pixel to render at (Chromium supports up to about 4). */
  scale: number
  /** Moments to capture, in ms from the start of `window.replay()`. Ascending. */
  timestamps: readonly number[]
}

/**
 * Renders a static page once, after its fonts have loaded, in the same unprivileged window as
 * the verify step (fonts must be data: URLs; nothing else loads). For font identification.
 */
export async function renderStill(html: string, width: number, height: number): Promise<NativeImage> {
  const window = new BrowserWindow({
    show: false,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    useContentSize: true,
    frame: false,
    webPreferences: {
      session: verifySession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: true,
      backgroundThrottling: false,
      offscreen: { deviceScaleFactor: 1 },
    },
  })
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  try {
    html = await embedFonts(html)
    const page = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${RECREATION_CSP}">${html}`
    await withTimeout(contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`), LOAD_TIMEOUT_MS, 'The page did not load')
    await withTimeout(contents.executeJavaScript('document.fonts.ready.then(() => true)'), STEP_TIMEOUT_MS, 'The fonts did not load')
    return await contents.capturePage()
  } finally {
    window.destroy()
  }
}

/**
 * Loads a page in the same unprivileged, offline window, lets it settle, runs `script` in it and
 * returns what the script evaluates to. The page is untrusted: the caller validates the answer.
 */
export async function probePage(html: string, width: number, height: number, script: string): Promise<unknown> {
  const window = new BrowserWindow({
    show: false,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    useContentSize: true,
    frame: false,
    webPreferences: {
      session: verifySession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: true,
      backgroundThrottling: false,
      offscreen: { deviceScaleFactor: 1 },
    },
  })
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  try {
    const page = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${RECREATION_CSP}">${(await embedFonts(html)).replace(/^\s*<!doctype html>/i, '')}`
    await withTimeout(contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`), LOAD_TIMEOUT_MS, 'The page did not load')
    await withTimeout(contents.executeJavaScript('document.fonts.ready.then(() => true)'), STEP_TIMEOUT_MS, 'The fonts did not load')
    return await withTimeout(contents.executeJavaScript(script), STEP_TIMEOUT_MS, 'The page did not answer')
  } finally {
    window.destroy()
  }
}

/**
 * Plays a recreation in real time, as the library's preview and any browser would, and captures
 * it at the given moments (ms after load, ascending). The verify step's virtual clock makes
 * frames exact but cannot show what only goes wrong with a real clock: timers that race, a
 * replay called twice, transitions that never start. `replayAt` calls `window.replay()` again
 * at those moments, the way a Replay button does.
 */
export async function renderRealTime(
  html: string,
  options: { width: number; height: number; scale: number; timestamps: readonly number[]; replayAt?: readonly number[] },
): Promise<NativeImage[]> {
  const window = new BrowserWindow({
    show: false,
    width: Math.max(1, Math.round(options.width)),
    height: Math.max(1, Math.round(options.height)),
    useContentSize: true,
    frame: false,
    webPreferences: {
      session: verifySession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: true,
      backgroundThrottling: false,
      offscreen: { deviceScaleFactor: Math.min(4, Math.max(1, options.scale)) },
    },
  })
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  try {
    html = await embedFonts(html)
    const page = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${RECREATION_CSP}">${html.replace(/^\s*<!doctype html>/i, '')}`
    await withTimeout(contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`), LOAD_TIMEOUT_MS, 'The recreation did not load')
    const started = Date.now()
    const events = [
      ...options.timestamps.map((at) => ({ at, shot: true })),
      ...(options.replayAt ?? []).map((at) => ({ at, shot: false })),
    ].sort((a, b) => a.at - b.at)
    const images: NativeImage[] = []
    for (const event of events) {
      const wait = event.at - (Date.now() - started)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      if (event.shot) images.push(await contents.capturePage())
      else await contents.executeJavaScript("typeof window.replay === 'function' && window.replay(); true")
    }
    return images
  } finally {
    window.destroy()
  }
}

/** One image per timestamp, in order. `keep` turns each frame into what is kept (a small copy, for long clips). */
export async function renderFrames(html: string, options: RenderOptions, keep: (image: NativeImage) => NativeImage = (image) => image): Promise<NativeImage[]> {
  const window = new BrowserWindow({
    show: false,
    width: Math.max(1, Math.round(options.width)),
    height: Math.max(1, Math.round(options.height)),
    useContentSize: true,
    frame: false,
    webPreferences: {
      session: verifySession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: true,
      backgroundThrottling: false,
      offscreen: { deviceScaleFactor: Math.min(4, Math.max(1, options.scale)) },
    },
  })
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  try {
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(verifyDocument(await embedFonts(html)))}`
    await withTimeout(contents.loadURL(url), LOAD_TIMEOUT_MS, 'The recreation did not load')
    await withTimeout(
      contents.executeJavaScript('window.__gilStart()'),
      STEP_TIMEOUT_MS,
      'The recreation did not start',
    )
    const images: NativeImage[] = []
    for (const timestamp of options.timestamps) {
      await withTimeout(
        contents.executeJavaScript(`window.__gilSeek(${Math.max(0, Math.round(timestamp))})`),
        STEP_TIMEOUT_MS,
        'The recreation stopped responding',
      )
      images.push(keep(await contents.capturePage()))
    }
    return images
  } finally {
    window.destroy()
  }
}
