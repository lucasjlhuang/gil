import { createWriteStream, type WriteStream } from 'node:fs'
import { once } from 'node:events'
import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
  type Display,
} from 'electron'
import {
  RecorderChannel,
  type RecorderStartOptions,
  type RecorderStarted,
  type RecorderStopped,
} from '../shared/channels'
import { recorderFailedSchema, recorderStartedSchema, recorderStoppedSchema } from '../shared/ipc'
import { loadRenderer, lockNavigation, rendererPreferences } from './windows'

const PARTITION = 'gil-recorder'
const FRAME_RATE = 60
const START_TIMEOUT_MS = 8000
const STOP_TIMEOUT_MS = 8000

interface Deferred<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

/** What to record: one app window (independent of what covers it), or a display. */
export type RecordSource =
  | { kind: 'window'; windowId: number; pixelWidth: number; pixelHeight: number }
  | { kind: 'display'; display: Display }

/**
 * Records one window or display to a file through a hidden renderer (getDisplayMedia +
 * MediaRecorder). Only this window's session can capture the screen, and only the source
 * main has chosen for the current recording.
 */
export class Recorder {
  private window: BrowserWindow | null = null
  private ready: Promise<void> = Promise.resolve()
  private pendingSource: RecordSource | null = null
  private output: WriteStream | null = null
  private starting: Deferred<RecorderStarted> | null = null
  private stopping: Deferred<RecorderStopped> | null = null
  /** Set when the recording ended by itself with its data intact (for example a display was unplugged). */
  private endedEarly: RecorderStopped | null = null
  /** Called if the recording fails after it started. */
  onUnexpectedEnd: ((error: Error) => void) | null = null
  /** Called if the recording ended by itself; `stop()` then returns what was recorded. */
  onEndedEarly: (() => void) | null = null

  init(): void {
    const recorderSession = session.fromPartition(PARTITION)
    recorderSession.setDisplayMediaRequestHandler((request, callback) => {
      const source = this.pendingSource
      this.pendingSource = null
      const mainFrame = this.window?.webContents.mainFrame
      const fromRecorder =
        mainFrame !== undefined &&
        request.frame?.processId === mainFrame.processId &&
        request.frame.routingId === mainFrame.routingId
      if (!source || !fromRecorder) return callback(null)
      desktopCapturer
        .getSources({
          types: [source.kind === 'window' ? 'window' : 'screen'],
          thumbnailSize: { width: 0, height: 0 },
        })
        .then((sources) => {
          const match =
            source.kind === 'window'
              ? // Window source ids are `window:<CGWindowID>:<n>`.
                sources.find((candidate) => candidate.id.split(':')[1] === String(source.windowId))
              : (sources.find((candidate) => candidate.display_id === String(source.display.id)) ??
                (sources.length === 1 ? sources[0] : undefined))
          callback(match ? { video: match } : null)
        })
        .catch(() => callback(null))
    })

    this.window = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      webPreferences: {
        ...rendererPreferences('recorder'),
        partition: PARTITION,
        // A hidden window is throttled by default, which would starve the recorder.
        backgroundThrottling: false,
      },
    })
    lockNavigation(this.window)
    this.ready = loadRenderer(this.window, 'recorder')

    const fromRecorder = (sender: Electron.WebContents) =>
      this.window !== null && !this.window.isDestroyed() && sender === this.window.webContents

    ipcMain.on(RecorderChannel.started, (event, payload: unknown) => {
      if (!fromRecorder(event.sender)) return
      const parsed = recorderStartedSchema.safeParse(payload)
      if (parsed.success) this.starting?.resolve(parsed.data)
      else this.fail(new Error('The recorder reported an invalid frame size'))
    })
    ipcMain.on(RecorderChannel.chunk, (event, payload: unknown) => {
      if (!fromRecorder(event.sender) || !(payload instanceof Uint8Array)) return
      this.output?.write(payload)
    })
    ipcMain.on(RecorderChannel.stopped, (event, payload: unknown) => {
      if (!fromRecorder(event.sender)) return
      const parsed = recorderStoppedSchema.safeParse(payload)
      const info = { durationMs: parsed.success ? Math.round(parsed.data.durationMs) : 0 }
      if (this.stopping) {
        this.stopping.resolve(info)
      } else if (this.output && !this.starting) {
        this.endedEarly = info
        this.onEndedEarly?.()
      }
    })
    ipcMain.on(RecorderChannel.failed, (event, payload: unknown) => {
      if (!fromRecorder(event.sender)) return
      const parsed = recorderFailedSchema.safeParse(payload)
      this.fail(new Error(parsed.success ? parsed.data : 'Recording failed'))
    })
  }

  private fail(error: Error): void {
    if (this.starting) this.starting.reject(error)
    else if (this.stopping) this.stopping.reject(error)
    else if (this.output) this.onUnexpectedEnd?.(error)
  }

  /** Starts recording `source` into `outputPath`. Resolves once frames are being recorded. */
  async start(source: RecordSource, outputPath: string): Promise<RecorderStarted> {
    const window = this.window
    if (!window || window.isDestroyed()) throw new Error('The recorder is not available')
    if (this.output) throw new Error('A recording is already in progress')
    await this.ready

    this.output = createWriteStream(outputPath)
    this.endedEarly = null
    this.pendingSource = source
    const options: RecorderStartOptions =
      source.kind !== 'display'
        ? { width: source.pixelWidth, height: source.pixelHeight, frameRate: FRAME_RATE }
        : {
            width: Math.round(source.display.size.width * source.display.scaleFactor),
            height: Math.round(source.display.size.height * source.display.scaleFactor),
            frameRate: FRAME_RATE,
          }
    try {
      const started = new Promise<RecorderStarted>((resolve, reject) => {
        this.starting = { resolve, reject }
      })
      // Handled below; this only stops an early failure from counting as unhandled.
      started.catch(() => undefined)
      // getDisplayMedia needs a user gesture; the second argument supplies one.
      await window.webContents.executeJavaScript(
        `window.__gilStartRecording(${JSON.stringify(options)})`,
        true,
      )
      return await withTimeout(started, START_TIMEOUT_MS, 'The recording did not start')
    } catch (error) {
      await this.closeOutput()
      throw error
    } finally {
      this.starting = null
      this.pendingSource = null
    }
  }

  /** Stops recording and resolves when the file is complete on disk. */
  async stop(): Promise<RecorderStopped> {
    const window = this.window
    if (!this.output || !window || window.isDestroyed()) {
      throw new Error('No recording is in progress')
    }
    try {
      if (this.endedEarly) return this.endedEarly
      const stopped = new Promise<RecorderStopped>((resolve, reject) => {
        this.stopping = { resolve, reject }
      })
      stopped.catch(() => undefined)
      window.webContents.send(RecorderChannel.stop)
      return await withTimeout(stopped, STOP_TIMEOUT_MS, 'The recording did not finish')
    } finally {
      this.stopping = null
      await this.closeOutput()
    }
  }

  /** Abandons a recording after a failure. */
  async abort(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(RecorderChannel.stop)
    }
    await this.closeOutput()
  }

  private async closeOutput(): Promise<void> {
    const output = this.output
    this.output = null
    if (!output) return
    output.end()
    await once(output, 'close').catch(() => undefined)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
