/**
 * All coordinate conversion for capture lives here. Nothing in this file touches Electron.
 *
 * Three coordinate spaces are involved:
 * - window space: CSS pixels relative to an overlay window's top-left corner
 * - global space: CSS pixels (DIPs / points) with the origin at the primary display's top-left,
 *   y down. Electron's screen API and macOS's window list both use it.
 * - display space / window space of the captured app: CSS pixels relative to that display's or
 *   that window's top-left corner
 * - video space: physical pixels of the recorded frame
 *
 * The overlay reports a rectangle relative to its own window. Main converts that to global
 * space with the overlay's real bounds (macOS may keep it below the menu bar), then to the space
 * of whatever is recorded (the window under the selection, or the display), then to video space
 * using the recorded frame size rather than a nominal scale factor, because the two do not
 * always agree (scaled display modes, windows on a display with a different scale).
 */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Point, Size {}

/** Selections smaller than this on either side are treated as an accidental click. */
export const MIN_SELECTION_SIZE = 8

/** Rectangle spanned by two drag points, in whatever order they were given. */
export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/** Intersection of `rect` with `bounds`. Width and height are zero when they do not overlap. */
export function clampRect(rect: Rect, bounds: Rect): Rect {
  const left = Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.width)
  const top = Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.height)
  const right = Math.max(Math.min(rect.x + rect.width, bounds.x + bounds.width), left)
  const bottom = Math.max(Math.min(rect.y + rect.height, bounds.y + bounds.height), top)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function isSelectable(rect: Size): boolean {
  return rect.width >= MIN_SELECTION_SIZE && rect.height >= MIN_SELECTION_SIZE
}

/**
 * Converts a rectangle from overlay-window space to display space and clips it to the display.
 * `windowBounds` and `displayBounds` are both in global screen DIPs.
 */
export function windowRectToDisplayRect(rect: Rect, windowBounds: Rect, displayBounds: Rect): Rect {
  const inDisplay: Rect = {
    x: rect.x + windowBounds.x - displayBounds.x,
    y: rect.y + windowBounds.y - displayBounds.y,
    width: rect.width,
    height: rect.height,
  }
  return clampRect(inDisplay, {
    x: 0,
    y: 0,
    width: displayBounds.width,
    height: displayBounds.height,
  })
}

export interface VideoCrop {
  /**
   * Crop rectangle in physical pixels of the recorded frame or image. Width and height are even
   * (required by H.264 4:2:0) unless `even: false` was asked for.
   */
  crop: Rect
  /** Video pixels per CSS pixel actually recorded, horizontally. */
  scale: number
}

/**
 * Maps a rectangle onto the recorded video frame. `rect` is relative to the recorded source
 * (a display or a window) in CSS pixels, and `sourceSize` is that source's size in CSS pixels.
 *
 * Edges are rounded to the nearest pixel independently so that adjacent selections tile, then
 * the size is reduced to even numbers (for video; screenshots pass `even: false`) and kept
 * inside the frame.
 */
export function rectToVideoCrop(
  rect: Rect,
  sourceSize: Size,
  videoSize: Size,
  options: { even?: boolean } = {},
): VideoCrop {
  if (sourceSize.width <= 0 || sourceSize.height <= 0) {
    throw new Error('Source size must be positive')
  }
  if (videoSize.width < 2 || videoSize.height < 2) {
    throw new Error('Video size must be at least 2x2')
  }
  const scaleX = videoSize.width / sourceSize.width
  const scaleY = videoSize.height / sourceSize.height

  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max)
  let left = clamp(Math.round(rect.x * scaleX), videoSize.width)
  let top = clamp(Math.round(rect.y * scaleY), videoSize.height)
  const right = clamp(Math.round((rect.x + rect.width) * scaleX), videoSize.width)
  const bottom = clamp(Math.round((rect.y + rect.height) * scaleY), videoSize.height)

  const even = options.even ?? true
  const fit = (value: number) => (even ? Math.max(2, value - (value % 2)) : Math.max(1, value))
  const width = fit(right - left)
  const height = fit(bottom - top)
  // A selection hard against the right or bottom edge may need to shift to fit the minimum size.
  left = Math.min(left, videoSize.width - width)
  top = Math.min(top, videoSize.height - height)

  return {
    crop: { x: left, y: top, width, height },
    scale: Math.round(scaleX * 1000) / 1000,
  }
}

/** Grows a rectangle outward by `by` on every side. */
export function expandRect(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + by * 2,
    height: rect.height + by * 2,
  }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
}

/**
 * Finds a spot for a box (the recording timer, the context panel) next to the selection but
 * never over it, fully inside the viewport. Tries below, above, right, then left.
 * Returns null when the selection leaves no room, for example a full-screen selection.
 */
export function placeOutside(
  region: Rect,
  box: Size,
  viewport: Size,
  gap: number,
): Point | null {
  const maxX = viewport.width - box.width
  const maxY = viewport.height - box.height
  if (maxX < 0 || maxY < 0) return null
  const alignX = Math.min(Math.max(region.x, 0), maxX)
  const alignY = Math.min(Math.max(region.y, 0), maxY)

  const candidates: Point[] = [
    { x: alignX, y: region.y + region.height + gap },
    { x: alignX, y: region.y - gap - box.height },
    { x: region.x + region.width + gap, y: alignY },
    { x: region.x - gap - box.width, y: alignY },
  ]
  for (const point of candidates) {
    const inside = point.x >= 0 && point.y >= 0 && point.x <= maxX && point.y <= maxY
    if (inside && !rectsIntersect({ ...point, ...box }, region)) return point
  }
  return null
}

export function translateRect(rect: Rect, by: Point): Rect {
  return { ...rect, x: rect.x + by.x, y: rect.y + by.y }
}
