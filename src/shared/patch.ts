import { connectedPatches, type Motion, type MotionSegment } from './motion'
import type { GrayImage } from './gate'

/**
 * Fixing a recreation without the model: when the local check finds that the whole thing sits a
 * few pixels off, or that every movement runs too fast or too slow by the same factor, the
 * numbers are corrected directly in the code. Pure; main renders and re-checks, and keeps a
 * patch only if the check improves.
 */

/** Custom properties that hold a time: `--pill-duration`, `--row-delay`, `--stagger`… */
const TIME_NAME = /(dur|delay|time|stagger|speed|interval)/i

/**
 * Multiplies every time value (`ms` or `s`) declared in a custom property with a time-like name.
 * Returns the html unchanged if there is nothing to scale.
 */
export function scaleTimeVars(html: string, factor: number): string {
  if (!Number.isFinite(factor) || factor <= 0) return html
  return html.replace(/(--[\w-]+)(\s*:\s*)(-?\d*\.?\d+)(ms|s)\b(?=\s*(?:[;}"']|!|$))/g, (whole, name: string, colon: string, value: string, unit: string) => {
    if (!TIME_NAME.test(name)) return whole
    const scaled = Number(value) * factor
    return `${name}${colon}${unit === 'ms' ? Math.round(scaled) : Math.round(scaled * 1000) / 1000}${unit}`
  })
}

const FIX_STYLE = /<style data-gil-fix>[^<]*<\/style>\s*/g

/**
 * Moves the whole recreation by (dx, dy) CSS px, with the separate `translate` property so it
 * rides on top of whatever the recreation does itself. Replaces an earlier shift.
 */
export function shiftPage(html: string, dx: number, dy: number): string {
  // The measured offset is what is left after any earlier shift, so the two add up.
  const earlier = /<style data-gil-fix>body\{translate:(-?[\d.]+)px (-?[\d.]+)px\}<\/style>/.exec(html)
  const clean = html.replace(FIX_STYLE, '')
  dx = Math.round((dx + Number(earlier?.[1] ?? 0)) * 10) / 10
  dy = Math.round((dy + Number(earlier?.[2] ?? 0)) * 10) / 10
  if (dx === 0 && dy === 0) return clean
  const style = `<style data-gil-fix>body{translate:${dx}px ${dy}px}</style>\n`
  return /<\/head>/i.test(clean) ? clean.replace(/<\/head>/i, `${style}</head>`) : `${style}${clean}`
}

/**
 * The factor that best maps the recreation's movement times onto the capture's (least squares
 * through zero: replay starts both at 0). Null when there is too little to go on or the times
 * already agree to within 3%.
 */
export function timeFactor(capture: Motion, recreation: Motion): number | null {
  // Movements are paired in order, which still holds when everything runs at the wrong speed;
  // with a different number of movements there is nothing safe to scale.
  if (capture.segments.length === 0 || capture.segments.length !== recreation.segments.length) return null
  let top = 0
  let bottom = 0
  capture.segments.forEach((segment, i) => {
    const other = recreation.segments[i] as MotionSegment
    const points: [number, number][] = []
    if (!segment.cutAtStart) points.push([segment.startMs, other.startMs])
    if (!segment.cutAtEnd) points.push([segment.endMs, other.endMs])
    for (const [c, r] of points) {
      top += c * r
      bottom += r * r
    }
  })
  if (bottom === 0) return null
  const factor = top / bottom
  return Math.abs(factor - 1) < 0.03 || factor < 0.2 || factor > 5 ? null : Math.round(factor * 1000) / 1000
}

/** The middle value, so one odd frame does not decide the shift. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] as number
}

export interface RegionDifference {
  kind: 'missing' | 'extra'
  /** Fractions (0–1) of the image. */
  x: number
  y: number
  width: number
  height: number
}

/** Most cells per side; small images get fewer, so a cell is never under MIN_CELL pixels. */
const MAX_GRID = 12
const MIN_CELL = 16
/** A pixel this far from the image's background grey is content. */
const CONTENT = 28
/** A cell with at least this share of content has something in it; below EMPTY it is blank. */
const BUSY = 0.06
const EMPTY = 0.008

const gridFor = (pixels: number) => Math.max(2, Math.min(MAX_GRID, Math.floor(pixels / MIN_CELL)))

function busyCells(image: GrayImage, gx: number, gy_: number): Float64Array {
  const histogram = new Array<number>(256).fill(0)
  for (const value of image.data) histogram[value] = (histogram[value] as number) + 1
  const background = histogram.indexOf(Math.max(...histogram))
  const busy = new Float64Array(gx * gy_)
  const counts = new Float64Array(gx * gy_)
  for (let y = 0; y < image.height; y++) {
    const gy = Math.min(gy_ - 1, Math.floor((y * gy_) / image.height))
    for (let x = 0; x < image.width; x++) {
      const cell = gy * gx + Math.min(gx - 1, Math.floor((x * gx) / image.width))
      counts[cell] = (counts[cell] as number) + 1
      if (Math.abs((image.data[y * image.width + x] as number) - background) > CONTENT) busy[cell] = (busy[cell] as number) + 1
    }
  }
  return busy.map((value, i) => value / Math.max(1, counts[i] as number))
}

/**
 * Where one image has something and the other has nothing: parts of the capture missing from
 * the recreation, and parts of the recreation that are not in the capture. It compares whether
 * there is content in each cell of a grid, not what the content is, so placeholder text in
 * place of real text does not count as a difference.
 */
/** Groups cells of a gx × gy grid into patches of neighbours. */
function patchesOf(cells: readonly number[], gx: number, gy: number): number[][] {
  // connectedPatches works on a square grid; map onto one wide enough for both sides.
  const side = Math.max(gx, gy)
  const toSquare = (cell: number) => Math.floor(cell / gx) * side + (cell % gx)
  const fromSquare = (cell: number) => Math.floor(cell / side) * gx + (cell % side)
  return connectedPatches(cells.map(toSquare), side).map((patch) => patch.map(fromSquare))
}

export function regionDifferences(original: GrayImage, recreation: GrayImage): RegionDifference[] {
  const gx = gridFor(original.width)
  const gy = gridFor(original.height)
  const a = busyCells(original, gx, gy)
  const b = busyCells(recreation, gx, gy)
  const result: RegionDifference[] = []
  for (const kind of ['missing', 'extra'] as const) {
    const [has, lacks] = kind === 'missing' ? [a, b] : [b, a]
    // Blank there and all around, so a part that is only a few pixels off is not "missing".
    const blankAround = (i: number) => {
      const cx = i % gx
      const cy = Math.floor(i / gx)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx
          const y = cy + dy
          if (x >= 0 && x < gx && y >= 0 && y < gy && (lacks[y * gx + x] as number) > EMPTY) return false
        }
      }
      return true
    }
    const cells = [...has.keys()].filter((i) => (has[i] as number) >= BUSY && blankAround(i))
    for (const patch of patchesOf(cells, gx, gy)) {
      const xs = patch.map((cell) => cell % gx)
      const ys = patch.map((cell) => Math.floor(cell / gx))
      result.push({
        kind,
        x: Math.min(...xs) / gx,
        y: Math.min(...ys) / gy,
        width: (Math.max(...xs) - Math.min(...xs) + 1) / gx,
        height: (Math.max(...ys) - Math.min(...ys) + 1) / gy,
      })
    }
  }
  return result
}

/** A step in brightness this large between a pixel's neighbours is an edge. */
const EDGE = 48

/**
 * The outlines in an image: pixels where brightness changes sharply. Outlines do not depend on
 * which colour counts as background, so a button that is dark at rest and red when hovered is
 * compared the same way.
 */
function edgesOf(image: GrayImage): Uint8Array {
  const { width, height, data } = image
  const edges = new Uint8Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gx = Math.abs((data[i + 1] as number) - (data[i - 1] as number))
      const gy = Math.abs((data[i + width] as number) - (data[i - width] as number))
      if (gx + gy > EDGE) edges[i] = 1
    }
  }
  return edges
}

/**
 * How well the shapes agree, 0–1: the share of each image's outline pixels that have an outline
 * within `reach` pixels in the other (after moving the recreation by dx, dy), taking the worse
 * of the two directions. A stroke drawn in the wrong place or a missing counter lowers it; soft
 * edges and a pixel of offset do not. 1 when neither image has outlines.
 */
export function shapeAgreement(
  original: GrayImage,
  recreation: GrayImage,
  dx = 0,
  dy = 0,
  reach = 2,
  /** `recreation`: only ask that what the recreation draws is in the capture, which may also show page content behind. */
  direction: 'both' | 'recreation' = 'both',
): number {
  const { width, height } = original
  const a = edgesOf(original)
  const raw = edgesOf(recreation)
  // The recreation, moved so it lines up with the capture.
  const b = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x - dx
      const sy = y - dy
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) b[y * width + x] = raw[sy * width + sx] as number
    }
  }
  const covered = (from: Uint8Array, by: Uint8Array): number => {
    let total = 0
    let hit = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!from[y * width + x]) continue
        total++
        let found = false
        for (let oy = -reach; oy <= reach && !found; oy++) {
          const ny = y + oy
          if (ny < 0 || ny >= height) continue
          for (let ox = -reach; ox <= reach; ox++) {
            const nx = x + ox
            if (nx >= 0 && nx < width && by[ny * width + nx]) {
              found = true
              break
            }
          }
        }
        if (found) hit++
      }
    }
    return total === 0 ? 1 : hit / total
  }
  // Nothing drawn where the capture has shapes is not agreement.
  if (direction === 'recreation' && !b.includes(1) && a.includes(1)) return 0
  return Math.round((direction === 'both' ? Math.min(covered(a, b), covered(b, a)) : covered(b, a)) * 1000) / 1000
}
