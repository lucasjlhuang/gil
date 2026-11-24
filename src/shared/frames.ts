/**
 * Motion detection and keyframe selection for analysis. Pure: main decodes the clip into small
 * grayscale thumbnails at a fixed rate and hands the bytes here.
 *
 * Frames are what the model sees, and their number is the main cost lever, so a clip is split
 * into quiet and active stretches: one frame per quiet stretch, dense samples inside active
 * ones, all within a fixed budget.
 */

/** Mean absolute difference (0–255) between consecutive grayscale frames of equal size. */
export function frameDifferences(frames: readonly Uint8Array[]): number[] {
  const diffs: number[] = []
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1] as Uint8Array
    const b = frames[i] as Uint8Array
    if (a.length !== b.length || a.length === 0) throw new Error('Frames must be the same size')
    let total = 0
    for (let p = 0; p < a.length; p++) total += Math.abs((a[p] as number) - (b[p] as number))
    diffs.push(total / a.length)
  }
  return diffs
}

/** Splits a buffer of concatenated raw frames into frames of `frameBytes` each. */
export function splitFrames(buffer: Uint8Array, frameBytes: number): Uint8Array[] {
  if (frameBytes <= 0) throw new Error('Frame size must be positive')
  const frames: Uint8Array[] = []
  for (let offset = 0; offset + frameBytes <= buffer.length; offset += frameBytes) {
    frames.push(buffer.subarray(offset, offset + frameBytes))
  }
  return frames
}

export interface FrameSelectionOptions {
  /** Most frames to keep. */
  budget: number
  /** A difference above this (0–255) counts as motion rather than noise. */
  noiseThreshold: number
  /** Quiet gaps this many frames long or shorter inside motion are treated as motion. */
  mergeGap: number
}

/**
 * 24 frames: enough to follow a shape morph through its intermediate shapes. The pause merge
 * scales with the 20 fps sampling (four frames is 200 ms).
 */
export const DEFAULT_SELECTION: FrameSelectionOptions = { budget: 24, noiseThreshold: 1.2, mergeGap: 4 }

export interface FrameSelection {
  isStill: boolean
  /** Indices into the sampled frames, ascending. */
  indices: number[]
}

interface Segment {
  start: number
  end: number
  active: boolean
}

/** Frame i is moving if it differs from frame i - 1. */
function segmentsOf(moving: boolean[]): Segment[] {
  const segments: Segment[] = []
  moving.forEach((active, index) => {
    const last = segments[segments.length - 1]
    if (last && last.active === active) last.end = index
    else segments.push({ start: index, end: index, active })
  })
  return segments
}

function evenlySpaced(start: number, end: number, count: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [Math.round((start + end) / 2)]
  const step = (end - start) / (count - 1)
  return Array.from({ length: count }, (_, i) => Math.round(start + i * step))
}

/**
 * Chooses which of `frameCount` sampled frames to send. `diffs[i]` is the difference between
 * frame i and frame i + 1 (as from `frameDifferences`).
 */
export function selectFrames(
  frameCount: number,
  diffs: readonly number[],
  options: FrameSelectionOptions = DEFAULT_SELECTION,
): FrameSelection {
  if (frameCount <= 0) return { isStill: true, indices: [] }
  const budget = Math.max(1, Math.floor(options.budget))

  // moving[i]: frame i changed since frame i - 1. Frame 0 never counts as moving.
  const moving = Array.from(
    { length: frameCount },
    (_, i) => i > 0 && (diffs[i - 1] ?? 0) > options.noiseThreshold,
  )
  if (!moving.some(Boolean)) {
    return { isStill: true, indices: [Math.floor((frameCount - 1) / 2)] }
  }
  // Short pauses inside an animation belong to it.
  for (const segment of segmentsOf(moving)) {
    const inside = segment.start > 0 && segment.end < frameCount - 1
    if (!segment.active && inside && segment.end - segment.start + 1 <= options.mergeGap) {
      for (let i = segment.start; i <= segment.end; i++) moving[i] = true
    }
  }

  const segments = segmentsOf(moving)
  const chosen = new Set<number>()
  // One frame per quiet stretch: its resting state.
  for (const segment of segments) {
    if (!segment.active) chosen.add(Math.round((segment.start + segment.end) / 2))
  }
  // Each active stretch keeps the frame before it starts (the state it moved from) and its last.
  const active = segments.filter((segment) => segment.active)
  for (const segment of active) {
    chosen.add(Math.max(0, segment.start - 1))
    chosen.add(segment.end)
  }
  // Whatever budget is left is spread over the motion, in proportion to its length.
  const activeFrames = active.reduce((sum, segment) => sum + segment.end - segment.start + 1, 0)
  const left = Math.max(0, budget - chosen.size)
  for (const segment of active) {
    const length = segment.end - segment.start + 1
    const share = Math.floor((left * length) / activeFrames)
    for (const index of evenlySpaced(segment.start, segment.end, share)) chosen.add(index)
  }

  let indices = [...chosen].sort((a, b) => a - b)
  if (indices.length > budget) {
    // Too many stretches for the budget: keep an even spread of what was chosen.
    indices = evenlySpaced(0, indices.length - 1, budget).map((i) => indices[i] as number)
    indices = [...new Set(indices)]
  }
  return { isStill: false, indices }
}

/**
 * Indices of the frames to keep so their total size stays within `limit` bytes: drops frames
 * evenly, always keeping the first and last. Returns every index if they already fit.
 */
export function thinToFit(sizes: readonly number[], limit: number): number[] {
  let keep = sizes.map((_, i) => i)
  const total = () => keep.reduce((sum, i) => sum + (sizes[i] ?? 0), 0)
  while (keep.length > 2 && total() > limit) {
    const target = keep.length - 1
    keep = [...new Set(evenlySpaced(0, keep.length - 1, target).map((i) => keep[i] as number))]
  }
  return keep
}
