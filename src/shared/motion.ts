import { z } from 'zod'

/**
 * Measured motion: timing and easing worked out on the Mac from every frame of a clip, so the
 * model is given facts instead of guessing them from two dozen samples. Pure: main decodes the
 * clip into small grayscale frames at MOTION_FPS and hands the bytes here.
 *
 * The frame is divided into a grid. For each step between frames, the change in every cell is
 * measured, and the clip's activity at that step is the average of its most active cells, so a
 * small button moving on a large page is not drowned out by the still parts. Stretches of
 * activity become motion segments. For each segment:
 *
 * - start, end and duration come straight from the frames (±1 frame);
 * - where it happens is the box around the cells that changed;
 * - stagger is when separate patches of change start, and in which direction that spreads;
 * - easing: activity is roughly speed, so its running total over the segment is progress over
 *   time, and the CSS cubic-bezier closest to that progress curve is the measured easing.
 *
 * A small wandering patch, such as a mouse pointer shown in the clip, is left out when there is
 * larger motion to measure (see `withoutPointer`).
 *
 * Limits: activity has no direction, so overshoot and springiness cannot be seen (fitted curves
 * stay within 0–1); very slow sub-pixel motion looks like stillness; one segment can hold
 * several elements moving at once; staggered items that touch look like one patch, so their
 * stagger is missed.
 */

/** Frames per second the clip is decoded at for measuring. */
export const MOTION_FPS = 30
/** Side of the square grayscale frames measured. */
export const MOTION_SIZE = 96
const GRID = 8
/** Share of grid cells averaged into the activity at each step. */
const TOP_SHARE = 0.06
/** Activity (0–255) always counted as noise, from compression and anti-aliasing. */
const NOISE_FLOOR = 1
/** Quiet gaps this short (ms) inside motion are part of it. */
const MERGE_GAP_MS = 100
/** Patches of change this many cells or smaller can be the mouse pointer (see `withoutPointer`). */
const POINTER_CELLS = 2
/**
 * Change (0–255) that counts when looking for the pointer: low, because a pointer is small and
 * changes little of each cell, but above compression noise.
 */
const POINTER_THRESHOLD = 3

export const easingSchema = z.object({
  /** cubic-bezier(x1, y1, x2, y2) */
  bezier: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** The closest CSS keyword: linear, ease, ease-in, ease-out or ease-in-out. */
  nearest: z.string(),
  /** Root mean square distance of the fitted curve from the measured progress, 0–1. */
  fitError: z.number(),
})
export type Easing = z.infer<typeof easingSchema>

export const motionSegmentSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  durationMs: z.number(),
  /** True if it was already moving when the clip starts, so the real start is earlier. */
  cutAtStart: z.boolean(),
  /** True if it is still moving when the clip ends. */
  cutAtEnd: z.boolean(),
  /** Where the change happens, as fractions (0–1) of the captured region. */
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  /** Null for segments too short to fit a curve to. */
  easing: easingSchema.nullable(),
  /**
   * When the movement was 0%, 10%, … 100% done, in ms from the clip's start (11 values), so
   * frames can be taken where the most changes. Missing in files from before it was recorded.
   */
  progressMs: z.array(z.number()).optional(),
  /** Null if every part starts together. */
  stagger: z
    .object({
      spreadMs: z.number(),
      direction: z.enum(['left-to-right', 'right-to-left', 'top-to-bottom', 'bottom-to-top']).nullable(),
    })
    .nullable(),
})
export type MotionSegment = z.infer<typeof motionSegmentSchema>

export const motionSchema = z.object({
  fps: z.number(),
  /**
   * Set when page content scrolls behind the captured thing along this axis and was left out of
   * the measurement (see `cellChanges`).
   */
  backdrop: z.enum(['x', 'y']).optional(),
  segments: z.array(motionSegmentSchema),
})
export type Motion = z.infer<typeof motionSchema>

/** The direction page content scrolls behind the captured thing, if it does. */
export type Backdrop = 'x' | 'y'

/** A scroll is looked for up to this share of the frame per step. */
const MAX_SCROLL = 0.4

/**
 * How far (whole pixels along `axis`) most of frame `a` moved to become frame `b`: the shift
 * that leaves the least difference. 0 when staying put explains the step as well.
 */
export function scrollBetween(a: Uint8Array, b: Uint8Array, size: number, axis: Backdrop): number {
  const reach = Math.floor(size * MAX_SCROLL)
  const cost = (shift: number) => {
    let sum = 0
    let count = 0
    // Every other pixel is plenty to find the shift.
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const sx = axis === 'x' ? x - shift : x
        const sy = axis === 'y' ? y - shift : y
        if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue
        sum += Math.abs((b[y * size + x] as number) - (a[sy * size + sx] as number))
        count++
      }
    }
    return count ? sum / count : Infinity
  }
  const still = cost(0)
  let best = 0
  let least = still
  for (let shift = -reach; shift <= reach; shift++) {
    const value = cost(shift)
    if (value < least) [least, best] = [value, shift]
  }
  // A shift has to explain the step clearly better than no shift at all.
  return least < still * 0.7 ? best : 0
}

/**
 * Per step between frames, the mean absolute change of each grid cell (0–255). With `backdrop`,
 * page content scrolling behind the captured thing is left out: each step's scroll is found, and
 * a pixel only counts as changed if it differs both from where it was and from what scrolled
 * into its place.
 */
export function cellChanges(frames: readonly Uint8Array[], size: number, grid = GRID, backdrop: Backdrop | null = null, scrolls: number[] = []): Float64Array[] {
  const cell = size / grid
  const steps: Float64Array[] = []
  for (let f = 1; f < frames.length; f++) {
    const a = frames[f - 1] as Uint8Array
    const b = frames[f] as Uint8Array
    if (a.length !== size * size || b.length !== size * size) throw new Error('Frames must be size × size')
    const shift = backdrop ? scrollBetween(a, b, size, backdrop) : 0
    scrolls.push(shift)
    const sums = new Float64Array(grid * grid)
    const counts = new Float64Array(grid * grid)
    for (let y = 0; y < size; y++) {
      const gy = Math.min(grid - 1, Math.floor(y / cell))
      for (let x = 0; x < size; x++) {
        const c = gy * grid + Math.min(grid - 1, Math.floor(x / cell))
        const p = y * size + x
        let change = Math.abs((a[p] as number) - (b[p] as number))
        if (shift !== 0 && change > 0) {
          // The scroll is rarely a whole number of pixels: one pixel either side also counts.
          for (let near = shift - 1; near <= shift + 1 && change > 0; near++) {
            const sx = backdrop === 'x' ? x - near : x
            const sy = backdrop === 'y' ? y - near : y
            // Content that scrolled in from outside the frame has nothing to compare with: it is backdrop.
            change = sx < 0 || sy < 0 || sx >= size || sy >= size ? 0 : Math.min(change, Math.abs((b[p] as number) - (a[sy * size + sx] as number)))
          }
        }
        sums[c] = (sums[c] as number) + change
        counts[c] = (counts[c] as number) + 1
      }
    }
    for (let c = 0; c < sums.length; c++) sums[c] = (sums[c] as number) / Math.max(1, counts[c] as number)
    steps.push(sums)
  }
  return steps
}

/** The mean of the most active cells at each step. */
export function activityCurve(steps: readonly Float64Array[]): number[] {
  return steps.map((cells) => {
    const sorted = [...cells].sort((a, b) => b - a)
    const top = Math.max(1, Math.round(sorted.length * TOP_SHARE))
    return sorted.slice(0, top).reduce((sum, value) => sum + value, 0) / top
  })
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number
}

/**
 * A step with no change between two steps with change is a repeated frame (screen recordings
 * drop and repeat frames), not a pause: it gets the mean of its neighbours.
 */
export function fillRepeatedFrames(activity: readonly number[], threshold: number): number[] {
  return activity.map((value, i) => {
    const before = activity[i - 1]
    const after = activity[i + 1]
    if (value < threshold && before !== undefined && after !== undefined && before >= threshold && after >= threshold) {
      return (before + after) / 2
    }
    return value
  })
}

/** Inclusive step ranges where something moves. */
export function activeRanges(activity: readonly number[], threshold: number, mergeGap: number): [number, number][] {
  const ranges: [number, number][] = []
  for (let i = 0; i < activity.length; i++) {
    if ((activity[i] as number) < threshold) continue
    const last = ranges[ranges.length - 1]
    if (last && i - last[1] - 1 <= mergeGap) last[1] = i
    else ranges.push([i, i])
  }
  return ranges.filter(([start, end]) => end - start >= 1)
}

/** y of a CSS cubic-bezier at x, solving x(t) = x by bisection (x(t) always rises). */
export function bezierAt(bezier: readonly [number, number, number, number], x: number): number {
  const [x1, y1, x2, y2] = bezier
  const curve = (t: number, p1: number, p2: number) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t
  let lo = 0
  let hi = 1
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (curve(mid, x1, x2) < x) lo = mid
    else hi = mid
  }
  return curve((lo + hi) / 2, y1, y2)
}

const NAMED: [string, [number, number, number, number]][] = [
  ['linear', [0, 0, 1, 1]],
  ['ease', [0.25, 0.1, 0.25, 1]],
  ['ease-in', [0.42, 0, 1, 1]],
  ['ease-out', [0, 0, 0.58, 1]],
  ['ease-in-out', [0.42, 0, 0.58, 1]],
]

function fitError(bezier: readonly [number, number, number, number], points: readonly [number, number][]): number {
  let sum = 0
  for (const [x, y] of points) sum += (bezierAt(bezier, x) - y) ** 2
  return Math.sqrt(sum / points.length)
}

/**
 * The cubic-bezier closest to progress points (time 0–1, progress 0–1): a coarse search over
 * control points in 0–1, then a finer one around the best.
 */
export function fitEasing(points: readonly [number, number][]): Easing {
  const round = (value: number) => Math.round(value * 100) / 100
  let best: [number, number, number, number] = [0, 0, 1, 1]
  let bestError = fitError(best, points)
  const search = (center: [number, number, number, number], radius: number, step: number) => {
    const range = (c: number) => {
      const values: number[] = []
      for (let v = Math.max(0, c - radius); v <= Math.min(1, c + radius) + 1e-9; v += step) values.push(round(v))
      return values
    }
    const [cx1, cy1, cx2, cy2] = center
    for (const x1 of range(cx1)) {
      for (const y1 of range(cy1)) {
        for (const x2 of range(cx2)) {
          for (const y2 of range(cy2)) {
            const candidate: [number, number, number, number] = [x1, y1, x2, y2]
            const error = fitError(candidate, points)
            if (error < bestError) {
              best = candidate
              bestError = error
            }
          }
        }
      }
    }
  }
  search([0.5, 0.5, 0.5, 0.5], 0.5, 0.1)
  search([...best], 0.1, 0.02)
  const nearest = NAMED.map(([name, curve]) => ({ name, error: fitError(curve, points) })).sort((a, b) => a.error - b.error)[0]
  return { bezier: best, nearest: nearest?.name ?? 'linear', fitError: Math.round(bestError * 1000) / 1000 }
}

/** Progress over a segment from its activity: the running total, both axes scaled to 0–1. */
export function progressPoints(activity: readonly number[]): [number, number][] {
  const total = activity.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return []
  const points: [number, number][] = [[0, 0]]
  let running = 0
  activity.forEach((value, i) => {
    running += value
    points.push([(i + 1) / activity.length, running / total])
  })
  return points
}

/** The times at which progress reaches 0%, 10%, … 100%, between `startMs` and `endMs`. */
export function progressTimes(points: readonly [number, number][], startMs: number, endMs: number): number[] {
  const at = (target: number) => {
    for (let i = 1; i < points.length; i++) {
      const [t0, p0] = points[i - 1] as [number, number]
      const [t1, p1] = points[i] as [number, number]
      if (p1 >= target) return p1 === p0 ? t0 : t0 + ((target - p0) / (p1 - p0)) * (t1 - t0)
    }
    return 1
  }
  return Array.from({ length: 11 }, (_, k) => Math.round(startMs + (points.length ? at(k / 10) : k / 10) * (endMs - startMs)))
}

/** Pearson correlation, or 0 when either side does not vary. */
function correlation(a: readonly number[], b: readonly number[]): number {
  const n = a.length
  const ma = a.reduce((s, v) => s + v, 0) / n
  const mb = b.reduce((s, v) => s + v, 0) / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    cov += ((a[i] as number) - ma) * ((b[i] as number) - mb)
    va += ((a[i] as number) - ma) ** 2
    vb += ((b[i] as number) - mb) ** 2
  }
  return va === 0 || vb === 0 ? 0 : cov / Math.sqrt(va * vb)
}

/** Groups grid cells into patches of neighbours (sharing an edge or a corner). */
export function connectedPatches(cells: readonly number[], grid: number): number[][] {
  const remaining = new Set(cells)
  const patches: number[][] = []
  for (const start of cells) {
    if (!remaining.has(start)) continue
    remaining.delete(start)
    const patch = [start]
    for (let i = 0; i < patch.length; i++) {
      const c = patch[i] as number
      const cx = c % grid
      const cy = Math.floor(c / grid)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx
          const ny = cy + dy
          const n = ny * grid + nx
          if (nx >= 0 && nx < grid && ny >= 0 && ny < grid && remaining.has(n)) {
            remaining.delete(n)
            patch.push(n)
          }
        }
      }
    }
    patches.push(patch)
  }
  return patches
}

/**
 * The mouse pointer, when a clip shows it, is a small patch of change that wanders around and
 * would stretch every measured movement. When a clip also has a larger patch of change
 * somewhere, patches of POINTER_CELLS cells or fewer are dropped from each step. A clip whose
 * only motion is small (a tiny spinner) is left as it is.
 */
export function withoutPointer(steps: readonly Float64Array[], threshold: number, grid: number): Float64Array[] {
  const patchesAt = steps.map((cells) => {
    const active = [...cells.keys()].filter((c) => (cells[c] as number) >= threshold)
    return connectedPatches(active, grid)
  })
  const largest = Math.max(0, ...patchesAt.flatMap((patches) => patches.map((patch) => patch.length)))
  if (largest <= POINTER_CELLS + 1) return [...steps]
  return steps.map((cells, s) => {
    const kept = Float64Array.from(cells)
    for (const patch of patchesAt[s] ?? []) {
      if (patch.length <= POINTER_CELLS) for (const c of patch) kept[c] = 0
    }
    return kept
  })
}

/**
 * How much changes at each step between frames (the mean of the most active cells, 0–255), with
 * the pointer left out and repeated frames filled in, and the level above which it is motion.
 */
export function activityOf(frames: readonly Uint8Array[], size: number, grid = GRID, backdrop: Backdrop | null = null): { steps: Float64Array[]; activity: number[]; threshold: number } {
  const scrolls: number[] = []
  const steps = withoutPointer(dropScrollJumps(cellChanges(frames, size, grid, backdrop, scrolls), scrolls), POINTER_THRESHOLD, grid)
  const raw = activityCurve(steps)
  // Quiet steps set the noise level; a clip that never stops moving is judged against its peak.
  const threshold = Math.max(NOISE_FLOOR, Math.min(3 * quantile(raw, 0.2), 0.25 * Math.max(...raw)))
  return { steps, activity: fillRepeatedFrames(raw, threshold), threshold }
}

/** A step near a scroll changing at least this much (0–255), and far more than the scroll steps, is the page jumping. */
const JUMP_LEVEL = 30
/** How many steps before or after a found scroll a jump can be. */
const JUMP_STEPS = 5

/**
 * When the page behind scrolls faster than a frame can follow (a short region is crossed in a
 * frame or two), whole new content appears at once and no scroll can be found for that step.
 * Such steps sit at the start or end of a scroll that was found; what they show is the page,
 * not the captured thing, so they take the level of the steps around them.
 */
export function dropScrollJumps(steps: readonly Float64Array[], scrolls: readonly number[]): Float64Array[] {
  if (!scrolls.some((shift) => shift !== 0)) return [...steps]
  const levels = activityCurve(steps)
  const scrolled = levels.filter((_, i) => scrolls[i] !== 0).sort((a, b) => a - b)
  const usual = scrolled[Math.floor(scrolled.length / 2)] ?? 0
  const jump = steps.map((_, i) => {
    if (scrolls[i] !== 0 || (levels[i] as number) <= Math.max(JUMP_LEVEL, usual * 5)) return false
    for (let k = 1; k <= JUMP_STEPS; k++) if ((scrolls[i - k] ?? 0) !== 0 || (scrolls[i + k] ?? 0) !== 0) return true
    return false
  })
  return steps.map((cells, i) => {
    if (!jump[i]) return cells
    let before = i - 1
    while (before >= 0 && jump[before]) before--
    let after = i + 1
    while (after < steps.length && jump[after]) after++
    const a = steps[before]
    const b = steps[after]
    return Float64Array.from(cells, (_, c) => (((a?.[c] ?? b?.[c] ?? 0) as number) + ((b?.[c] ?? a?.[c] ?? 0) as number)) / 2)
  })
}

/** Measures the motion in frames decoded at `fps`, each `size` × `size` grayscale. */
export function measureMotion(frames: readonly Uint8Array[], size: number, fps: number, grid = GRID, backdrop: Backdrop | null = null): Motion {
  if (frames.length < 2) return { fps, segments: [] }
  const { steps, activity, threshold } = activityOf(frames, size, grid, backdrop)
  const stepMs = 1000 / fps
  const ranges = activeRanges(activity, threshold, Math.round(MERGE_GAP_MS / stepMs))

  const segments = ranges.map(([start, end]): MotionSegment => {
    const cells = Array.from({ length: grid * grid }, (_, c) => c)
    // Cells that changed in this segment, with the step each started changing at.
    const onsets = cells.flatMap((c) => {
      for (let s = start; s <= end; s++) {
        if (((steps[s] as Float64Array)[c] as number) >= threshold) return [{ c, onset: s }]
      }
      return []
    })
    const xs = onsets.map(({ c }) => c % grid)
    const ys = onsets.map(({ c }) => Math.floor(c / grid))
    const bounds = onsets.length
      ? {
          x: Math.min(...xs) / grid,
          y: Math.min(...ys) / grid,
          width: (Math.max(...xs) - Math.min(...xs) + 1) / grid,
          height: (Math.max(...ys) - Math.min(...ys) + 1) / grid,
        }
      : { x: 0, y: 0, width: 1, height: 1 }

    // Separate moving things are separate patches of changed cells. Each patch starts when its
    // first cell does; patches starting at different times are a stagger. (One patch on its own
    // also changes cell by cell as it travels, which is not a stagger.)
    const onsetOf = new Map(onsets.map(({ c, onset }) => [c, onset]))
    const patches = connectedPatches([...onsetOf.keys()], grid).map((patch) => ({
      onset: Math.min(...patch.map((c) => onsetOf.get(c) as number)),
      x: patch.reduce((sum, c) => sum + (c % grid), 0) / patch.length,
      y: patch.reduce((sum, c) => sum + Math.floor(c / grid), 0) / patch.length,
    }))
    let stagger: MotionSegment['stagger'] = null
    const patchOnsets = patches.map((patch) => patch.onset)
    const spreadSteps = patches.length > 1 ? Math.max(...patchOnsets) - Math.min(...patchOnsets) : 0
    if (spreadSteps >= 2) {
      const byX = correlation(
        patches.map((patch) => patch.x),
        patchOnsets,
      )
      const byY = correlation(
        patches.map((patch) => patch.y),
        patchOnsets,
      )
      const strongest = Math.abs(byX) >= Math.abs(byY) ? byX : byY
      const direction =
        Math.abs(strongest) < 0.6
          ? null
          : strongest === byX
            ? byX > 0
              ? 'left-to-right'
              : 'right-to-left'
            : byY > 0
              ? 'top-to-bottom'
              : 'bottom-to-top'
      stagger = { spreadMs: Math.round(spreadSteps * stepMs), direction }
    }

    const points = progressPoints(activity.slice(start, end + 1))
    return {
      startMs: Math.round(start * stepMs),
      endMs: Math.round((end + 1) * stepMs),
      durationMs: Math.round((end - start + 1) * stepMs),
      cutAtStart: start === 0,
      cutAtEnd: end === activity.length - 1,
      bounds,
      // Fewer than four steps cannot tell one curve from another.
      easing: end - start + 1 >= 4 && points.length ? fitEasing(points) : null,
      progressMs: progressTimes(points, start * stepMs, (end + 1) * stepMs),
      stagger,
    }
  })
  return backdrop ? { fps, backdrop, segments } : { fps, segments }
}

/**
 * The part of a capture the user asked for, when that is not all of it (`capture/focus.json`):
 * a span of the clip (ms) and, when it is also part of the picture, a box (fractions of the
 * capture). gil cuts the capture to it (`capture/focus.mp4`, `focus.png`) and builds from that.
 */
export const focusSchema = z.object({
  fromMs: z.number(),
  toMs: z.number(),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
})
export type Focus = z.infer<typeof focusSchema>

/** A span shorter than the clip by less than this at both ends is the whole clip. */
const FOCUS_SLACK_MS = 150
/** A box that leaves out less than this share of the picture on every side is the whole picture. */
const FOCUS_SLACK_BOX = 0.04

/**
 * The part of a capture the plan says the user asked for, or null when that is all of it or
 * the answer is unusable. `durationMs` is 0 for a screenshot, which can only be focused in area.
 */
export function focusFrom(
  answer: { fromMs: number; toMs: number; x: number; y: number; width: number; height: number },
  durationMs: number,
): Focus | null {
  const finite = Object.values(answer).every((value) => Number.isFinite(value))
  if (!finite) return null
  const from = Math.max(0, Math.round(answer.fromMs))
  const to = Math.min(durationMs, Math.round(answer.toMs > 0 ? answer.toMs : durationMs))
  const inTime = durationMs > 0 && to - from >= 200 && (from >= FOCUS_SLACK_MS || durationMs - to >= FOCUS_SLACK_MS)
  const x = Math.min(1, Math.max(0, answer.x))
  const y = Math.min(1, Math.max(0, answer.y))
  const width = Math.min(1 - x, Math.max(0, answer.width))
  const height = Math.min(1 - y, Math.max(0, answer.height))
  const whole = x <= FOCUS_SLACK_BOX && y <= FOCUS_SLACK_BOX && x + width >= 1 - FOCUS_SLACK_BOX && y + height >= 1 - FOCUS_SLACK_BOX
  const inArea = !whole && width >= 0.05 && height >= 0.05
  if (!inTime && !inArea) return null
  const round = (value: number) => Math.round(value * 1000) / 1000
  return {
    fromMs: inTime ? from : 0,
    toMs: inTime ? to : durationMs,
    ...(inArea ? { box: { x: round(x), y: round(y), width: round(width), height: round(height) } } : {}),
  }
}

/** The CSS size and length of the focused part of a capture. */
export function focusedSize(capture: { width: number; height: number; durationMs: number }, focus: Focus): { width: number; height: number; durationMs: number } {
  return {
    width: Math.max(1, Math.round(capture.width * (focus.box?.width ?? 1))),
    height: Math.max(1, Math.round(capture.height * (focus.box?.height ?? 1))),
    durationMs: capture.durationMs > 0 ? focus.toMs - focus.fromMs : 0,
  }
}

/**
 * How far the page has scrolled at each moment of the clip, from the page content moving across
 * the frame: the shift found between each pair of frames (see `scrollBetween`), added up. In the
 * units of the frames (`size` px across); empty when nothing scrolled.
 */
export function scrollTimeline(frames: readonly Uint8Array[], size: number, fps: number, axis: Backdrop): { atMs: number; px: number }[] {
  let total = 0
  let moved = false
  const timeline = [{ atMs: 0, px: 0 }]
  for (let f = 1; f < frames.length; f++) {
    // Content moving up means the page scrolled down.
    const shift = -scrollBetween(frames[f - 1] as Uint8Array, frames[f] as Uint8Array, size, axis)
    if (shift !== 0) moved = true
    total += shift
    timeline.push({ atMs: Math.round((f * 1000) / fps), px: total })
  }
  return moved ? timeline : []
}

/** The scroll timeline as prompt lines, in CSS px, at its turning points; '' if nothing scrolled. */
export function describeScroll(timeline: readonly { atMs: number; px: number }[], pxPerUnit: number): string {
  if (timeline.length === 0) return ''
  // Keep the moments where scrolling starts, stops or turns, and one every 200 ms between.
  const kept = timeline.filter((point, i) => {
    const before = timeline[i - 1]
    const after = timeline[i + 1]
    if (!before || !after) return true
    const turning = Math.sign(point.px - before.px) !== Math.sign(after.px - point.px)
    return turning || point.atMs % 200 < 1000 / 30
  })
  return [
    'Measured scroll: gil followed the page content moving across the region and added up how far the page had scrolled at each moment (CSS px, down is positive; about ±1 frame and a few px). Use it to turn the measured timings into scroll positions: say where in the scroll each effect starts and ends, not when.',
    kept.map((point) => `${point.atMs} ms: ${Math.round(point.px * pxPerUnit)} px`).join(', '),
  ].join('\n')
}

/** Whether two measurements describe the same movements: as many, starting and ending within `toleranceMs`. */
export function sameTimeline(a: Motion, b: Motion, toleranceMs = 70): boolean {
  if (a.segments.length !== b.segments.length) return false
  return a.segments.every((segment, i) => {
    const other = b.segments[i] as MotionSegment
    return Math.abs(segment.startMs - other.startMs) <= toleranceMs && Math.abs(segment.endMs - other.endMs) <= toleranceMs
  })
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`
const fixed = (value: number) => String(Math.round(value * 100) / 100)

/** The measurement as lines for the model's prompt; empty if nothing moved. */
export function describeMotion(motion: Motion, cssWidth: number, cssHeight: number): string {
  if (motion.segments.length === 0) return ''
  const precision = Math.round(1000 / motion.fps)
  const lines = [
    `Measured motion: gil measured every frame of the clip at ${motion.fps} fps. Times are accurate to about ±${precision} ms, so trust them over what the sampled frames suggest, and mark values taken from here as "measured". Overshoot and springiness cannot be measured this way; judge those from the frames.`,
  ]
  motion.segments.forEach((segment, i) => {
    const { bounds } = segment
    const area = `x ${Math.round(bounds.x * cssWidth)}–${Math.round((bounds.x + bounds.width) * cssWidth)} px, y ${Math.round(bounds.y * cssHeight)}–${Math.round((bounds.y + bounds.height) * cssHeight)} px (${percent(bounds.width)} × ${percent(bounds.height)} of the region)`
    const parts = [`- Motion ${i + 1}: ${segment.startMs}–${segment.endMs} ms (${segment.durationMs} ms), in the area ${area}.`]
    if (segment.cutAtStart) parts.push('Already moving when the clip starts, so it began earlier.')
    if (segment.cutAtEnd) parts.push('Still moving when the clip ends.')
    if (segment.easing) {
      const [x1, y1, x2, y2] = segment.easing.bezier
      parts.push(
        `Overall easing: cubic-bezier(${fixed(x1)}, ${fixed(y1)}, ${fixed(x2)}, ${fixed(y2)}), closest keyword ${segment.easing.nearest}${segment.easing.fitError > 0.08 ? ' (a loose fit: several movements may overlap here)' : ''}.`,
      )
    }
    if (segment.stagger) {
      parts.push(
        `Parts of it start up to ${segment.stagger.spreadMs} ms apart${segment.stagger.direction ? `, spreading ${segment.stagger.direction}` : ''}, which suggests a stagger.`,
      )
    }
    lines.push(parts.join(' '))
  })
  return lines.join('\n')
}

/**
 * Frame differences for `selectFrames` built from measured motion instead of whole-frame change:
 * `frameCount` frames sampled at `sampleFps`, where a frame inside a measured segment counts as
 * moving. So the frames the model sees fall on the movements, not on the pointer or noise.
 */
export function differencesFromMotion(motion: Motion, frameCount: number, sampleFps: number): number[] {
  return Array.from({ length: Math.max(0, frameCount - 1) }, (_, i) => {
    // diffs[i] is the change from frame i to frame i + 1.
    // The step from frame i to frame i + 1 moves if it overlaps a measured segment at all, so a
    // one-frame change (a colour swap with no transition) between two samples is not missed.
    const from = (i * 1000) / sampleFps
    const to = ((i + 1) * 1000) / sampleFps
    return motion.segments.some((segment) => segment.startMs < to && segment.endMs > from) ? 255 : 0
  })
}

/**
 * Which of `frameCount` frames (sampled at `sampleFps`) to show the model, within `budget`:
 * the resting state of each quiet stretch, the frame before and the last frame of each
 * movement, and the rest of the budget inside the movements at even steps of progress, so
 * more frames land where the most changes. Null if the motion has no progress times (older
 * files), for the caller to fall back on.
 */
export function framesForMotion(motion: Motion, frameCount: number, sampleFps: number, budget: number): number[] | null {
  const segments = motion.segments
  if (frameCount <= 0 || segments.length === 0 || segments.some((segment) => !segment.progressMs)) return null
  const last = frameCount - 1
  const frameAt = (ms: number) => Math.min(last, Math.max(0, Math.round((ms * sampleFps) / 1000)))
  const chosen = new Set<number>()
  // Resting states: the middle of each quiet stretch, including before the first and after the last.
  let quietFrom = 0
  for (const segment of segments) {
    if (segment.startMs > quietFrom) chosen.add(frameAt((quietFrom + segment.startMs) / 2))
    quietFrom = segment.endMs
  }
  const clipEnd = (last * 1000) / sampleFps
  if (clipEnd > quietFrom) chosen.add(frameAt((quietFrom + clipEnd) / 2))
  for (const segment of segments) {
    chosen.add(Math.max(0, frameAt(segment.startMs) - 1))
    chosen.add(frameAt(segment.endMs))
  }
  const left = Math.max(0, budget - chosen.size)
  const total = segments.reduce((sum, segment) => sum + segment.durationMs, 0)
  for (const segment of segments) {
    const times = segment.progressMs as number[]
    // At least two frames inside each movement, however short.
    const share = Math.max(2, Math.floor((left * segment.durationMs) / Math.max(1, total)))
    for (let k = 1; k <= share; k++) {
      // Progress k/(share+1), read off the 10% steps.
      const position = (k / (share + 1)) * 10
      const low = Math.floor(position)
      const t0 = times[low] as number
      const t1 = times[Math.min(10, low + 1)] as number
      chosen.add(frameAt(t0 + (position - low) * (t1 - t0)))
    }
  }
  let indices = [...chosen].sort((a, b) => a - b)
  if (indices.length > budget) {
    const step = (indices.length - 1) / (budget - 1)
    indices = [...new Set(Array.from({ length: budget }, (_, i) => indices[Math.round(i * step)] as number))]
  }
  return indices
}
