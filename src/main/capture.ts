import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, desktopCapturer, dialog, globalShortcut, ipcMain, Notification, screen, type NativeImage } from 'electron'
import { measureClip } from './analysis/analyze'
import { CAPTURE_DIR, CLIP_FILE } from './storage'
import { newAssetId, type Asset, type AssetLens } from '../shared/asset'
import { OverlayChannel, type OverlayTarget } from '../shared/channels'
import {
  clampRect,
  isSelectable,
  rectToVideoCrop,
  translateRect,
  windowRectToDisplayRect,
  type Rect,
  type Size,
} from '../shared/geometry'
import { recordRequestSchema, rectSchema } from '../shared/ipc'
import { pickWindow, regionInWindow, type WindowInfo } from '../shared/windowList'
import type { Overlay, OverlayManager } from './overlay'
import type { Recorder, RecordSource } from './recorder'
import { saveRecording, saveScreenshot } from './saveCapture'
import { listWindows } from './windowList'

export const MAX_DURATION_MS = 10_000
/** How long to wait for the overlay to confirm the dimming is off screen before recording anyway. */
const PAINT_TIMEOUT_MS = 500
/** How long hidden overlays get to leave the screen before a screenshot of the display. */
const HIDE_SETTLE_MS = 150

/** A selection resolved to what will be recorded and where in it to crop. */
interface Target {
  source: RecordSource
  /** Region to keep, in CSS pixels relative to the recorded window or display. */
  region: Rect
  /** Size of the recorded window or display in CSS pixels. */
  sourceSize: Size
  /** For asset.json `source`. */
  app: string | null
  windowTitle: string | null
  url: string | null
  /** What the overlay shows, in its own window's CSS pixels. */
  ui: OverlayTarget
}

interface ActiveCapture {
  id: string
  overlay: Overlay
  target: Target
  context: string
  lens: AssetLens
  tempPath: string
}

type Phase =
  | { name: 'idle' }
  | { name: 'selecting'; windows: Promise<WindowInfo[]> }
  | { name: 'arming'; capture: ActiveCapture; armed: () => void; stopRequested: boolean }
  | { name: 'recording'; capture: ActiveCapture; videoSize: Size; timer: NodeJS.Timeout }
  | { name: 'saving' }

export interface CaptureDeps {
  overlays: OverlayManager
  recorder: Recorder
  libraryRoot: () => string
  onSaved: (asset: Asset) => void
}

/**
 * The capture state machine: idle -> selecting -> arming -> recording -> saving -> idle.
 * Orchestration only; geometry, naming, schema and storage are in tested pure modules.
 */
export class CaptureController {
  private phase: Phase = { name: 'idle' }

  constructor(private readonly deps: CaptureDeps) {
    ipcMain.handle(OverlayChannel.resolveTarget, async (event, payload: unknown) => {
      const overlay = deps.overlays.find(event.sender)
      const rect = rectSchema.safeParse(payload)
      if (!overlay || !rect.success) return null
      return (await this.resolve(overlay, rect.data))?.ui ?? null
    })
    ipcMain.on(OverlayChannel.record, (event, payload: unknown) => {
      const overlay = deps.overlays.find(event.sender)
      const parsed = recordRequestSchema.safeParse(payload)
      if (overlay && parsed.success) void this.arm(overlay, parsed.data.rect, parsed.data.context, parsed.data.lens)
    })
    ipcMain.on(OverlayChannel.screenshot, (event, payload: unknown) => {
      const overlay = deps.overlays.find(event.sender)
      const parsed = recordRequestSchema.safeParse(payload)
      if (overlay && parsed.success) {
        void this.screenshot(overlay, parsed.data.rect, parsed.data.context, parsed.data.lens)
      }
    })
    ipcMain.on(OverlayChannel.cancel, (event) => {
      if (deps.overlays.find(event.sender)) this.cancelSelection()
    })
    ipcMain.on(OverlayChannel.focus, (event) => {
      const overlay = deps.overlays.find(event.sender)
      if (overlay && this.phase.name === 'selecting') overlay.window.focus()
    })
    ipcMain.on(OverlayChannel.painted, (event) => {
      if (this.phase.name === 'arming' && this.phase.capture.overlay.window.webContents === event.sender) {
        this.phase.armed()
      }
    })
    ipcMain.on(OverlayChannel.setInteractive, (event, interactive: unknown) => {
      const active = this.activeOverlay()
      if (!active || active.window.webContents !== event.sender) return
      if (interactive === true) active.window.setIgnoreMouseEvents(false)
      else active.window.setIgnoreMouseEvents(true, { forward: true })
    })
    ipcMain.on(OverlayChannel.stop, (event) => {
      if (this.activeOverlay()?.window.webContents === event.sender) this.stop()
    })
    deps.recorder.onEndedEarly = () => this.stop()
    deps.recorder.onUnexpectedEnd = (error) => {
      if (this.phase.name === 'recording') void this.finish(this.phase, error)
    }
  }

  get isIdle(): boolean {
    return this.phase.name === 'idle'
  }

  private activeOverlay(): Overlay | null {
    return this.phase.name === 'arming' || this.phase.name === 'recording'
      ? this.phase.capture.overlay
      : null
  }

  /** The global shortcut: start selecting, cancel a selection, or stop a recording. */
  toggle(): void {
    switch (this.phase.name) {
      case 'idle':
        return this.beginSelection()
      case 'selecting':
        return this.cancelSelection()
      case 'arming':
      case 'recording':
        return this.stop()
      case 'saving':
        return
    }
  }

  beginSelection(): void {
    if (this.phase.name !== 'idle') return
    this.deps.overlays.showForSelection()
    // Fetched now so it is ready by the time the drag ends.
    this.phase = { name: 'selecting', windows: listWindows() }
    // The overlay handles Esc itself when it has the keyboard; this covers the case where it does not.
    globalShortcut.register('Escape', () => this.cancelSelection())
  }

  cancelSelection(): void {
    if (this.phase.name !== 'selecting') return
    globalShortcut.unregister('Escape')
    this.deps.overlays.hideAllExcept(null)
    this.phase = { name: 'idle' }
  }

  /**
   * Works out what a selection records: the frontmost app window under it, recorded on its own
   * so the user can cover it or switch apps while recording, or, over the desktop, the display.
   */
  private async resolve(overlay: Overlay, rect: Rect): Promise<Target | null> {
    if (this.phase.name !== 'selecting') return null
    const overlayBounds = overlay.window.getBounds()
    const toOverlay = { x: -overlayBounds.x, y: -overlayBounds.y }
    const selection = clampRect(
      translateRect(rect, { x: overlayBounds.x, y: overlayBounds.y }),
      overlay.display.bounds,
    )
    if (!isSelectable(selection)) return null

    const picked = pickWindow(selection, await this.phase.windows, process.pid)

    const region = picked ? regionInWindow(selection, picked.bounds) : null
    if (picked && region) {
      const { scaleFactor } = screen.getDisplayMatching(picked.bounds)
      return {
        source: {
          kind: 'window',
          windowId: picked.id,
          pixelWidth: Math.round(picked.bounds.width * scaleFactor),
          pixelHeight: Math.round(picked.bounds.height * scaleFactor),
        },
        region,
        sourceSize: { width: picked.bounds.width, height: picked.bounds.height },
        app: picked.app,
        windowTitle: picked.title,
        url: null,
        ui: {
          kind: 'window',
          app: picked.app,
          title: picked.title,
          frame: translateRect(picked.bounds, toOverlay),
          region: translateRect(clampRect(selection, picked.bounds), toOverlay),
        },
      }
    }

    const { display } = overlay
    return {
      source: { kind: 'display', display },
      region: windowRectToDisplayRect(rect, overlayBounds, display.bounds),
      sourceSize: display.size,
      app: null,
      windowTitle: null,
      url: null,
      ui: { kind: 'display', region: translateRect(selection, toOverlay) },
    }
  }

  private async arm(overlay: Overlay, rect: Rect, context: string, lens: AssetLens): Promise<void> {
    const target = await this.resolve(overlay, rect)
    if (!target || this.phase.name !== 'selecting') return
    globalShortcut.unregister('Escape')
    const { window } = overlay
    const overlayRegion = target.ui.region

    const id = newAssetId()
    const capture: ActiveCapture = {
      id,
      overlay,
      target,
      context,
      lens,
      tempPath: join(app.getPath('temp'), `gil-${id}.recording`),
    }
    let armed: () => void = () => undefined
    const painted = new Promise<void>((resolve) => {
      armed = resolve
      setTimeout(resolve, PAINT_TIMEOUT_MS)
    })
    const arming: Extract<Phase, { name: 'arming' }> = {
      name: 'arming',
      capture,
      armed,
      stopRequested: false,
    }
    this.phase = arming

    this.deps.overlays.hideAllExcept(overlay)
    this.deps.overlays.send(overlay, { phase: 'arming', region: overlayRegion })
    // Wait until the dimming is off screen, so it cannot be in the first frames of a display
    // recording. (A window recording never contains gil's own windows.)
    await painted

    // From here the mouse belongs to whatever is under the overlay. Mouse moves are still
    // forwarded so the timer can make itself clickable on hover.
    window.setIgnoreMouseEvents(true, { forward: true })
    // Give keyboard focus back to the app being captured.
    window.blur()

    try {
      const started = await this.deps.recorder.start(target.source, capture.tempPath)
      const timer = setTimeout(() => this.stop(), MAX_DURATION_MS)
      this.phase = {
        name: 'recording',
        capture,
        videoSize: { width: started.width, height: started.height },
        timer,
      }
      this.deps.overlays.send(overlay, {
        phase: 'recording',
        region: overlayRegion,
        startedAt: Date.now(),
        maxDurationMs: MAX_DURATION_MS,
      })
      if (arming.stopRequested) this.stop()
    } catch (error) {
      await this.deps.recorder.abort()
      await rm(capture.tempPath, { force: true })
      this.deps.overlays.hideAllExcept(null)
      this.phase = { name: 'idle' }
      reportError('gil could not start recording', error)
    }
  }

  stop(): void {
    if (this.phase.name === 'arming') {
      // The recorder is still starting; stop as soon as it has.
      this.phase.stopRequested = true
      return
    }
    if (this.phase.name === 'recording') void this.finish(this.phase, null)
  }

  private async finish(
    recording: Extract<Phase, { name: 'recording' }>,
    failure: Error | null,
  ): Promise<void> {
    const { capture, videoSize, timer } = recording
    clearTimeout(timer)
    this.phase = { name: 'saving' }
    this.deps.overlays.hideAllExcept(null)

    try {
      if (failure) {
        await this.deps.recorder.abort()
        throw failure
      }
      const { durationMs } = await this.deps.recorder.stop()
      const { target } = capture
      const { crop, scale } = rectToVideoCrop(target.region, target.sourceSize, videoSize)
      const asset = await saveRecording({
        id: capture.id,
        root: this.deps.libraryRoot(),
        context: capture.context,
        lens: capture.lens,
        source: { app: target.app, windowTitle: target.windowTitle, url: target.url },
        crop,
        scale,
        recordingPath: capture.tempPath,
        durationMs,
      })
      this.deps.onSaved(asset)
      // The colour lens renames the capture straight away and does not care about motion.
      if (asset.lens !== 'color') void warnIfNothingMoved(this.deps.libraryRoot(), asset)
    } catch (error) {
      reportError('gil could not save the capture', error)
    } finally {
      // The uncropped recording can contain anything in that window or on screen; never keep it.
      await rm(capture.tempPath, { force: true })
      this.phase = { name: 'idle' }
    }
  }

  /** Saves a still of the selection straight away, without recording. */
  private async screenshot(overlay: Overlay, rect: Rect, context: string, lens: AssetLens): Promise<void> {
    const target = await this.resolve(overlay, rect)
    if (!target || this.phase.name !== 'selecting') return
    globalShortcut.unregister('Escape')
    this.phase = { name: 'saving' }
    this.deps.overlays.hideAllExcept(null)
    try {
      // A window grab never contains gil's windows; a display grab would.
      if (target.source.kind === 'display') await delay(HIDE_SETTLE_MS)
      const image = await grabStill(target.source)
      const { crop, scale } = rectToVideoCrop(target.region, target.sourceSize, image.getSize(), {
        even: false,
      })
      const asset = await saveScreenshot({
        id: newAssetId(),
        root: this.deps.libraryRoot(),
        context,
        lens,
        source: { app: target.app, windowTitle: target.windowTitle, url: target.url },
        crop,
        scale,
        png: image.crop(crop).toPNG(),
      })
      this.deps.onSaved(asset)
    } catch (error) {
      reportError('gil could not take the screenshot', error)
    } finally {
      this.phase = { name: 'idle' }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A recording where nothing moved is usually a hover that was never triggered. It is still
 * saved, but the user is told at once rather than finding out after analysis.
 */
async function warnIfNothingMoved(root: string, asset: Asset): Promise<void> {
  const motion = await measureClip(join(root, asset.name, CAPTURE_DIR, CLIP_FILE))
  if (!motion || motion.segments.length > 0) return
  if (Notification.isSupported()) {
    new Notification({
      title: 'Nothing moved in that recording',
      body: `It was saved as ${asset.name}. To capture a hover or animation, trigger it while gil records.`,
      silent: true,
    }).show()
  }
}

/** A full-resolution still of the whole page, window or display. */
async function grabStill(source: RecordSource): Promise<NativeImage> {
  const isWindow = source.kind === 'window'
  const size = isWindow
    ? { width: source.pixelWidth, height: source.pixelHeight }
    : {
        width: Math.round(source.display.size.width * source.display.scaleFactor),
        height: Math.round(source.display.size.height * source.display.scaleFactor),
      }
  const sources = await desktopCapturer.getSources({
    types: [isWindow ? 'window' : 'screen'],
    // A thumbnail at the source's own pixel size is a full-resolution still.
    thumbnailSize: size,
    fetchWindowIcons: false,
  })
  const match = isWindow
    ? sources.find((candidate) => candidate.id.split(':')[1] === String(source.windowId))
    : (sources.find((candidate) => candidate.display_id === String(source.display.id)) ??
      (sources.length === 1 ? sources[0] : undefined))
  if (!match || match.thumbnail.isEmpty()) {
    throw new Error(isWindow ? 'The window could not be captured' : 'The screen could not be captured')
  }
  return match.thumbnail
}

function reportError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`${title}: ${message}`)
  void dialog.showMessageBox({ type: 'error', message: title, detail: message })
}
