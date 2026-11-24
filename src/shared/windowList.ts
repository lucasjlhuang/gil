import { z } from 'zod'
import { clampRect, isSelectable, translateRect, type Rect } from './geometry'

/**
 * The on-screen window list (from macOS CGWindowListCopyWindowInfo) and picking the window a
 * selection belongs to. Pure; main fetches the list.
 */

export interface WindowInfo {
  /** CGWindowID. Matches the number in an Electron desktopCapturer source id `window:<id>:0`. */
  id: number
  pid: number
  app: string
  /** Only readable with Screen Recording permission. */
  title: string | null
  /** Global CSS pixels. */
  bounds: Rect
  layer: number
  alpha: number
}

const rawWindowSchema = z.object({
  kCGWindowNumber: z.number().int(),
  kCGWindowOwnerPID: z.number().int(),
  kCGWindowOwnerName: z.string().optional(),
  kCGWindowName: z.string().optional(),
  kCGWindowLayer: z.number(),
  kCGWindowAlpha: z.number().optional(),
  kCGWindowBounds: z.object({
    X: z.number(),
    Y: z.number(),
    Width: z.number(),
    Height: z.number(),
  }),
})

/** Parses the raw list, front to back as macOS returns it. Malformed entries are dropped. */
export function parseWindowList(raw: unknown): WindowInfo[] {
  if (!Array.isArray(raw)) return []
  const windows: WindowInfo[] = []
  for (const entry of raw) {
    const parsed = rawWindowSchema.safeParse(entry)
    if (!parsed.success) continue
    const w = parsed.data
    windows.push({
      id: w.kCGWindowNumber,
      pid: w.kCGWindowOwnerPID,
      app: w.kCGWindowOwnerName ?? 'Unknown app',
      title: w.kCGWindowName ? w.kCGWindowName : null,
      bounds: {
        x: w.kCGWindowBounds.X,
        y: w.kCGWindowBounds.Y,
        width: w.kCGWindowBounds.Width,
        height: w.kCGWindowBounds.Height,
      },
      layer: w.kCGWindowLayer,
      alpha: w.kCGWindowAlpha ?? 1,
    })
  }
  return windows
}

/** Windows smaller than this are palettes, tooltips or invisible helpers, not capture targets. */
const MIN_WINDOW_SIZE = 40

/**
 * The frontmost ordinary app window under the centre of `selection` (global space).
 * Ignores menu bar items, the Dock, overlays and other non-zero layers, transparent windows,
 * and windows belonging to `excludePid` (gil itself). `windows` must be front to back.
 */
export function pickWindow(
  selection: Rect,
  windows: readonly WindowInfo[],
  excludePid: number,
): WindowInfo | null {
  const cx = selection.x + selection.width / 2
  const cy = selection.y + selection.height / 2
  for (const window of windows) {
    if (window.layer !== 0 || window.alpha <= 0) continue
    if (window.pid === excludePid) continue
    const { x, y, width, height } = window.bounds
    if (width < MIN_WINDOW_SIZE || height < MIN_WINDOW_SIZE) continue
    if (cx >= x && cx < x + width && cy >= y && cy < y + height) return window
  }
  return null
}

/**
 * The part of `selection` (global space) inside `windowBounds`, relative to the window's
 * top-left corner. Null if too little of it is inside the window to record.
 */
export function regionInWindow(selection: Rect, windowBounds: Rect): Rect | null {
  const inside = clampRect(selection, windowBounds)
  if (!isSelectable(inside)) return null
  return translateRect(inside, { x: -windowBounds.x, y: -windowBounds.y })
}
