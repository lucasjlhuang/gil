import type { Rect, Size } from '../shared/geometry'
import type { PageStyles } from '../shared/pageStyles'

/** Messages between the extension's parts. Every receiver checks `type` and the sender. */

/** A selection made by the in-page overlay. */
export interface Selection {
  /** In the tab's viewport, CSS pixels. */
  region: Rect
  /** `innerWidth` × `innerHeight`. */
  viewport: Size
  devicePixelRatio: number
  context: string
  /** Exact style values read from the page for the selection. */
  styles: PageStyles
}

export type CaptureResult = { ok: true; name: string } | { ok: false; error: string }

/** overlay -> background */
export type OverlayMessage =
  | { type: 'screenshot'; selection: Selection }
  | { type: 'record'; selection: Selection }
  | { type: 'stop' }
  | { type: 'cancel' }

/** background -> overlay */
export type ToOverlayMessage = { type: 'finished'; result: CaptureResult } | { type: 'cancel' }

/** background -> offscreen */
export type OffscreenMessage =
  | { target: 'offscreen'; type: 'start'; streamId: string; width: number; height: number }
  | { target: 'offscreen'; type: 'stop'; upload: UploadTarget; meta: RecordingMetaBase }
  | { target: 'offscreen'; type: 'abort' }

export type OffscreenStartReply = { ok: true } | { ok: false; error: string }

export interface UploadTarget {
  pairingCode: string
}

/** A recording's metadata, less what only the offscreen document knows (frame size, duration). */
export interface RecordingMetaBase {
  region: Rect
  viewport: Size
  context: string
  url: string | null
  title: string | null
  browser: string | null
  pageStyles: PageStyles | null
}
