import type { Motion, MotionSegment } from './motion'

/**
 * The accuracy gate agreed on 2026-11-16: from the first analysis, with no Refine, every motion
 * step is within two frames of the clip, every still within 2 px, and no state or transition is
 * missing. (The last condition, that the user judges it the same thing, stays with the user.)
 * Pure checks for the parts that can be measured; main renders and decodes.
 */

/** Two frames of the clip at 30 fps. */
export const TIMING_TOLERANCE_MS = 67
/** CSS pixels a still may be off by. */
export const POSITION_TOLERANCE_PX = 2

export interface TimingCheck {
  /** One entry per movement in the capture, with the recreation's matching movement. */
  steps: { startMs: number; endMs: number; startOffMs: number | null; endOffMs: number | null }[]
  /** Capture movements with nothing in the recreation at that time. */
  missing: number
  /** Recreation movements with nothing in the capture at that time. */
  extra: number
  /** The largest start or end difference among matched movements, ms. */
  worstMs: number
  pass: boolean
}

function overlap(a: MotionSegment, b: MotionSegment): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs))
}

/**
 * Pairs each movement in the capture with the recreation's movement that overlaps it most (each
 * used once), and checks starts and ends against the tolerance. Ends cut off by the end of the
 * clip are not compared, since the real end is unknown.
 */
export function checkTiming(capture: Motion, recreation: Motion, toleranceMs = TIMING_TOLERANCE_MS): TimingCheck {
  const used = new Set<number>()
  const steps = capture.segments.map((segment) => {
    let best = -1
    let bestOverlap = 0
    recreation.segments.forEach((candidate, i) => {
      const amount = overlap(segment, candidate)
      if (!used.has(i) && amount > bestOverlap) {
        best = i
        bestOverlap = amount
      }
    })
    if (best < 0) return { startMs: segment.startMs, endMs: segment.endMs, startOffMs: null, endOffMs: null }
    used.add(best)
    const match = recreation.segments[best] as MotionSegment
    return {
      startMs: segment.startMs,
      endMs: segment.endMs,
      startOffMs: segment.cutAtStart ? 0 : match.startMs - segment.startMs,
      endOffMs: segment.cutAtEnd ? 0 : match.endMs - segment.endMs,
    }
  })
  const missing = steps.filter((step) => step.startOffMs === null).length
  const extra = recreation.segments.length - used.size
  const worstMs = Math.max(0, ...steps.flatMap((step) => [Math.abs(step.startOffMs ?? 0), Math.abs(step.endOffMs ?? 0)]))
  return { steps, missing, extra, worstMs, pass: missing === 0 && extra === 0 && worstMs <= toleranceMs }
}

export interface GrayImage {
  width: number
  height: number
  data: Uint8Array
}

/** A 4-byte-per-pixel image (RGBA or BGRA) as grayscale. */
export function toGray(width: number, height: number, data: Uint8Array): GrayImage {
  const gray = new Uint8Array(width * height)
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(((data[i * 4] as number) + (data[i * 4 + 1] as number) + (data[i * 4 + 2] as number)) / 3)
  }
  return { width, height, data: gray }
}

/**
 * How far the recreation is shifted from the original, in pixels of these images: the shift
 * (within ±maxShift on each axis) that makes them most alike, by mean absolute difference over
 * the overlapping area. Returns the shift's length. Measures the design's overall placement, not
 * each element's.
 */
export function bestShift(original: GrayImage, recreation: GrayImage, maxShift: number): { dx: number; dy: number; distance: number } {
  if (original.width !== recreation.width || original.height !== recreation.height) {
    throw new Error('Images must be the same size')
  }
  const { width, height } = original
  let best = { dx: 0, dy: 0, error: Infinity }
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let total = 0
      let count = 0
      for (let y = Math.max(0, dy); y < Math.min(height, height + dy); y++) {
        const row = y * width
        const shiftedRow = (y - dy) * width
        for (let x = Math.max(0, dx); x < Math.min(width, width + dx); x++) {
          total += Math.abs((original.data[row + x] as number) - (recreation.data[shiftedRow + x - dx] as number))
          count++
        }
      }
      const error = count ? total / count : Infinity
      // Prefer the smaller shift when two are equally good (flat areas).
      if (error < best.error - 1e-9 || (Math.abs(error - best.error) <= 1e-9 && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy))) {
        best = { dx, dy, error }
      }
    }
  }
  return { dx: best.dx, dy: best.dy, distance: Math.hypot(best.dx, best.dy) }
}

/** The gate's measurable parts for one capture. */
export interface GateResult {
  /** Null for captures with no motion. */
  timing: TimingCheck | null
  /** The largest placement offset over the compared frames, CSS px. */
  offsetPx: number
  pass: boolean
}

export function gateResult(timing: TimingCheck | null, offsetPx: number): GateResult {
  return { timing, offsetPx, pass: (timing?.pass ?? true) && offsetPx <= POSITION_TOLERANCE_PX }
}
