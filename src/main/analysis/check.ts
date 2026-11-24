import { nativeImage } from 'electron'
import { bestShift, checkTiming, POSITION_TOLERANCE_PX, TIMING_TOLERANCE_MS, toGray, type GrayImage, type TimingCheck } from '../../shared/gate'
import { measureMotion, MOTION_FPS, MOTION_SIZE, type Motion } from '../../shared/motion'
import { median, regionDifferences, shapeAgreement, scaleTimeVars, shiftPage, timeFactor, type RegionDifference } from '../../shared/patch'
import type { Frame } from './claude'
import { renderFrames } from './render'

/**
 * The local check: renders a recreation on the Mac and compares it with the capture, with no
 * model call. It answers three things, the bar being 2 px, 2 frames and nothing missing:
 *
 * - placement: how far the recreation sits from the capture, per frame;
 * - timing: whether each movement starts and ends when the capture's does;
 * - regions: parts of the capture with nothing there in the recreation, and the reverse;
 * - shapes: whether the outlines line up at rest, so a mark or letter drawn wrong is caught.
 *
 * `patchNumbers` then corrects what is only a number (a uniform offset, a uniform speed) directly
 * in the code, keeping a patch only if the check improves.
 */

/** Longest side, in CSS pixels, frames are compared at for placement. */
const PLACEMENT_EDGE = 800
/** Largest shift searched for, in CSS pixels. */
const MAX_SHIFT_PX = 8

export interface CaptureSize {
  /** CSS px. */
  width: number
  height: number
  /** Frame pixels per CSS pixel for rendering. */
  scale: number
  durationMs: number
}

export interface FrameCheck {
  timestampMs: number
  /** How the recreation must move to line up with the capture, CSS px. */
  dx: number
  dy: number
  offsetPx: number
  regions: RegionDifference[]
  /** How well the shapes agree once lined up, 0–1 (see shapeAgreement). */
  shape: number
}

export interface CheckResult {
  frames: FrameCheck[]
  /** Null when the capture has no motion. */
  timing: TimingCheck | null
  recreationMotion: Motion | null
  /** The largest placement offset over the frames, CSS px. */
  offsetPx: number
  missing: number
  extra: number
  pass: boolean
  /** The lowest shape agreement over the resting frames, 0–1. */
  shape: number
  /** Shape agreement of the in-between frames of movements, judged more loosely. */
  moving: { timestampMs: number; shape: number }[]
  /** What is off, in plain words, for the model that fixes it. */
  problems: string[]
  /** Each original frame with the recreation at the same moment, at the frame's size. */
  pairs: { original: Frame; recreation: Frame }[]
}

/** An image at CSS size (capped at PLACEMENT_EDGE), grayscale. */
export function cssGray(image: Electron.NativeImage, cssWidth: number, cssHeight: number): { gray: GrayImage; pxPerCss: number } {
  const fit = Math.min(1, PLACEMENT_EDGE / Math.max(cssWidth, cssHeight))
  const width = Math.max(1, Math.round(cssWidth * fit))
  const height = Math.max(1, Math.round(cssHeight * fit))
  const small = image.resize({ width, height, quality: 'best' })
  return { gray: toGray(width, height, small.toBitmap()), pxPerCss: fit }
}

/**
 * Plays the recreation through at MOTION_FPS and measures its motion the same way as the
 * capture's, so the two timelines can be compared.
 */
export async function recreationMotion(html: string, size: CaptureSize): Promise<Motion> {
  const step = 1000 / MOTION_FPS
  const timestamps = Array.from({ length: Math.max(2, Math.ceil(size.durationMs / step)) }, (_, i) => Math.round(i * step))
  const images = await renderFrames(html, { width: size.width, height: size.height, scale: 1, timestamps })
  const frames = images.map((image) => {
    const small = image.resize({ width: MOTION_SIZE, height: MOTION_SIZE, quality: 'best' })
    return toGray(MOTION_SIZE, MOTION_SIZE, small.toBitmap()).data
  })
  return measureMotion(frames, MOTION_SIZE, MOTION_FPS)
}

const px = (fraction: number, total: number) => Math.round(fraction * total)

function describeRegion(region: RegionDifference, size: CaptureSize, at: number): string {
  const where = `x ${px(region.x, size.width)}–${px(region.x + region.width, size.width)}, y ${px(region.y, size.height)}–${px(region.y + region.height, size.height)} px`
  return region.kind === 'missing'
    ? `At ${at} ms, the capture has something at ${where} that the recreation leaves empty.`
    : `At ${at} ms, the recreation draws something at ${where} where the capture is empty.`
}

/**
 * Outlines must line up this well at rest. Set from real results: recreations judged accurate
 * score 0.96–1.0, ones with a visibly wrong mark or letterforms 0.77–0.90.
 */
export const SHAPE_OK = 0.93

/** In-between frames: outlines within this many CSS px count as the same, and this share must line up. */
const MOVING_REACH_PX = 2
export const MOVING_OK = 0.75

/** Shapes are compared at this many pixels per CSS pixel (small marks need the detail), up to SHAPE_EDGE. */
const SHAPE_SCALE = 3
const SHAPE_EDGE = 1600

/** Shape agreement of a frame pair, lined up by the measured shift (CSS px). */
function shapeOf(original: Electron.NativeImage, rendered: Electron.NativeImage, size: CaptureSize, dxCss: number, dyCss: number, reachCss = 0.7, direction: 'both' | 'recreation' = 'both'): number {
  const scale = Math.min(SHAPE_SCALE, SHAPE_EDGE / Math.max(size.width, size.height))
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.max(1, Math.round(size.height * scale))
  const gray = (image: Electron.NativeImage) => toGray(width, height, image.resize({ width, height, quality: 'best' }).toBitmap())
  // Within about two thirds of a CSS pixel counts as the same place.
  return shapeAgreement(gray(original), gray(rendered), Math.round(dxCss * scale), Math.round(dyCss * scale), Math.max(1, Math.round(scale * reachCss)), direction)
}

/** Frames compared for placement and regions; more would only repeat the same resting states. */
const MAX_RESTING = 6
/** Frames this close to a movement may still be settling. */
const SETTLE_MS = 100

/** Indices of the frames where nothing is moving (all of them for a still), spread evenly if many. */
export function restingFrames(frames: readonly Frame[], motion: Motion | null): Set<number> {
  const quiet = frames
    .map((frame, i) => ({ i, at: frame.timestampMs }))
    .filter(({ at }) => !(motion?.segments ?? []).some((segment) => at > segment.startMs - SETTLE_MS && at < segment.endMs + SETTLE_MS))
    .map(({ i }) => i)
  if (quiet.length <= MAX_RESTING) return new Set(quiet)
  return new Set(Array.from({ length: MAX_RESTING }, (_, k) => quiet[Math.round((k * (quiet.length - 1)) / (MAX_RESTING - 1))] as number))
}

/** Renders `html` at the frames' moments and through its whole length, and compares. */
export async function checkRecreation(
  html: string,
  size: CaptureSize,
  frames: readonly Frame[],
  capturedMotion: Motion | null,
): Promise<CheckResult> {
  const images = await renderFrames(html, {
    width: size.width,
    height: size.height,
    scale: size.scale,
    timestamps: frames.map((frame) => frame.timestampMs),
  })
  // Placement and regions are judged at rest only. Mid-movement, a timing difference well inside
  // the two-frame bar puts a fast element many pixels away, which is timing's business, not theirs.
  const resting = restingFrames(frames, capturedMotion)
  const pairs: CheckResult['pairs'] = []
  const checks: FrameCheck[] = []
  const moving: CheckResult['moving'] = []
  for (const [i, frame] of frames.entries()) {
    const original = nativeImage.createFromBuffer(Buffer.from(frame.data))
    const rendered = (images[i] as Electron.NativeImage).resize({ ...original.getSize(), quality: 'best' })
    pairs.push({ original: frame, recreation: { timestampMs: frame.timestampMs, data: rendered.toJPEG(92), mediaType: 'image/jpeg' } })
    // The comparison is heavy; let the app's windows breathe between frames.
    await new Promise((resolve) => setImmediate(resolve))
    if (!resting.has(i)) {
      // Mid-movement only the shape is judged, and loosely: a timing difference inside the bar
      // moves things a little, but a morph passing through the wrong shapes is far off. Only what
      // the recreation draws has to be in the capture: the capture may also show page content
      // passing behind, which the recreation rightly leaves out.
      moving.push({ timestampMs: frame.timestampMs, shape: shapeOf(original, rendered, size, 0, 0, MOVING_REACH_PX, 'recreation') })
      continue
    }
    const a = cssGray(original, size.width, size.height)
    const b = cssGray(rendered, size.width, size.height)
    const shift = bestShift(a.gray, b.gray, Math.max(1, Math.round(MAX_SHIFT_PX * a.pxPerCss)))
    const round = (value: number) => Math.round((value / a.pxPerCss) * 10) / 10
    checks.push({
      timestampMs: frame.timestampMs,
      dx: round(shift.dx),
      dy: round(shift.dy),
      offsetPx: round(shift.distance),
      regions: regionDifferences(a.gray, b.gray),
      shape: shapeOf(original, rendered, size, shift.dx / a.pxPerCss, shift.dy / a.pxPerCss),
    })
  }

  let timing: TimingCheck | null = null
  let played: Motion | null = null
  if (capturedMotion && capturedMotion.segments.length > 0) {
    played = await recreationMotion(html, size)
    timing = checkTiming(capturedMotion, played)
  }

  const offsetPx = Math.max(0, ...checks.map((frame) => frame.offsetPx))
  const missing = (timing?.missing ?? 0) + checks.reduce((sum, frame) => sum + frame.regions.filter((r) => r.kind === 'missing').length, 0)
  const extra = (timing?.extra ?? 0) + checks.reduce((sum, frame) => sum + frame.regions.filter((r) => r.kind === 'extra').length, 0)

  const problems: string[] = []
  for (const step of timing?.steps ?? []) {
    if (step.startOffMs === null) {
      problems.push(`The capture moves from ${step.startMs} to ${step.endMs} ms; the recreation does not move then at all. That movement is missing.`)
    } else if (Math.abs(step.startOffMs) > TIMING_TOLERANCE_MS || Math.abs(step.endOffMs ?? 0) > TIMING_TOLERANCE_MS) {
      problems.push(
        `The movement at ${step.startMs}–${step.endMs} ms (${step.endMs - step.startMs} ms long) runs from ${step.startMs + step.startOffMs} to ${step.endMs + (step.endOffMs ?? 0)} ms in the recreation. Make it start at ${step.startMs} ms and last ${step.endMs - step.startMs} ms.`,
      )
    }
  }
  if (timing && played && timing.extra > 0) {
    problems.push(`The recreation has ${timing.extra} movement${timing.extra > 1 ? 's' : ''} the capture does not have. Its movements run at: ${played.segments.map((s) => `${s.startMs}–${s.endMs} ms`).join(', ')}.`)
  }
  const dx = median(checks.map((frame) => frame.dx))
  const dy = median(checks.map((frame) => frame.dy))
  if (Math.hypot(dx, dy) > POSITION_TOLERANCE_PX) problems.push(`The whole recreation sits off: move it ${dx} px right and ${dy} px down to line up with the capture.`)
  // The same region is usually off in many frames; name each place once, at its first moment.
  const seen = new Set<string>()
  for (const frame of checks) {
    for (const region of frame.regions) {
      const key = `${region.kind}:${region.x}:${region.y}:${region.width}:${region.height}`
      if (seen.has(key) || seen.size >= 12) continue
      seen.add(key)
      problems.push(describeRegion(region, size, frame.timestampMs))
    }
  }

  // Shapes: outlines that do not line up, at rest.
  const shape = Math.min(1, ...checks.map((frame) => frame.shape))
  for (const frame of checks) {
    if (frame.shape >= SHAPE_OK) continue
    problems.push(
      `At ${frame.timestampMs} ms the shapes are drawn differently: only ${Math.round(frame.shape * 100)}% of the outlines line up with the capture. Compare that pair closely and redraw to match exactly: where each stroke starts and ends, its thickness and angle, the counters and gaps inside letters and marks, corner shapes, and the size and position of text.`,
    )
  }

  const wrongMoving = moving.filter((frame) => frame.shape < MOVING_OK)
  if (wrongMoving.length > 0) {
    problems.push(
      `Mid-movement the shapes differ from the capture at ${wrongMoving.map((frame) => `${frame.timestampMs} ms (${Math.round(frame.shape * 100)}% of outlines line up)`).join(', ')}. Compare those pairs: the in-between shapes must be the capture's in-between shapes at those moments, not a different route between the same start and end.`,
    )
  }

  return {
    frames: checks,
    shape,
    moving,
    timing,
    recreationMotion: played,
    offsetPx,
    missing,
    extra,
    pass: (timing?.pass ?? true) && offsetPx <= POSITION_TOLERANCE_PX && missing === 0 && extra === 0 && shape >= SHAPE_OK && wrongMoving.length === 0,
    problems,
    pairs,
  }
}

/**
 * Whether a failing check has something a model correction can act on. A movement that only
 * starts or ends a little off is not: the build was given the measured timings, and what is
 * left is usually the measurement itself (a pointer or page content moving in the capture), so
 * a paid round would chase a difference that is not in the design.
 */
export function worthCorrecting(check: CheckResult): boolean {
  if (check.pass || check.problems.length === 0) return false
  const wrongMoving = check.moving.some((frame) => frame.shape < MOVING_OK)
  return check.missing > 0 || check.extra > 0 || check.shape < SHAPE_OK || wrongMoving || check.offsetPx > POSITION_TOLERANCE_PX
}

/** Whether `a` is a better result than `b`: nothing missing first, then passing, timing, placement. */
export function better(a: CheckResult, b: CheckResult): boolean {
  // Whole movements first, then passing; region counts only break ties among equal timing, since
  // one region splitting in two is not a real change.
  const regions = (check: CheckResult) => check.frames.reduce((sum, frame) => sum + frame.regions.length, 0)
  const rank = (check: CheckResult) => [
    (check.timing?.missing ?? 0) + (check.timing?.extra ?? 0),
    check.pass ? 0 : 1,
    // In steps of 0.02, so noise does not decide.
    -Math.round(check.shape / 0.02),
    check.moving.filter((frame) => frame.shape < MOVING_OK).length,
    Math.round((check.timing?.worstMs ?? 0) / 34),
    regions(check),
    check.offsetPx,
  ]
  const [ra, rb] = [rank(a), rank(b)]
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return (ra[i] as number) < (rb[i] as number)
  }
  return false
}

/**
 * Corrects what is only a number, without the model: a uniform offset (the whole thing a few
 * pixels off) and a uniform speed (every movement too fast or slow by one factor). Each patch is
 * rendered and checked again, and kept only if the check got better.
 */
export async function patchNumbers(
  html: string,
  check: CheckResult,
  size: CaptureSize,
  frames: readonly Frame[],
  capturedMotion: Motion | null,
): Promise<{ html: string; check: CheckResult; patched: string[] }> {
  let current = { html, check }
  const patched: string[] = []
  const attempt = async (next: string, label: string) => {
    if (next === current.html) return
    try {
      const result = await checkRecreation(next, size, frames, capturedMotion)
      if (better(result, current.check)) {
        current = { html: next, check: result }
        patched.push(label)
      }
    } catch (error) {
      console.error(`Could not check the ${label} patch`, error)
    }
  }

  if (capturedMotion && current.check.recreationMotion && current.check.timing && !current.check.timing.pass) {
    const factor = timeFactor(capturedMotion, current.check.recreationMotion)
    if (factor !== null) await attempt(scaleTimeVars(current.html, factor), `timings × ${factor}`)
  }
  const dx = median(current.check.frames.map((frame) => frame.dx))
  const dy = median(current.check.frames.map((frame) => frame.dy))
  if (Math.hypot(dx, dy) > POSITION_TOLERANCE_PX) await attempt(shiftPage(current.html, dx, dy), `moved ${dx}, ${dy} px`)
  return { ...current, patched }
}

/** At most `limit` pairs for the fix call: the ones with something wrong first, the rest spread evenly. */
export function pairsForFix(check: CheckResult, limit: number): CheckResult['pairs'] {
  if (check.pairs.length <= limit) return check.pairs
  const off = new Set(
    check.frames.filter((frame) => frame.regions.length > 0 || frame.offsetPx > POSITION_TOLERANCE_PX || frame.shape < SHAPE_OK).map((frame) => frame.timestampMs),
  )
  for (const frame of check.moving) if (frame.shape < MOVING_OK) off.add(frame.timestampMs)
  const flagged = check.pairs.map((pair, i) => (off.has(pair.original.timestampMs) ? i : -1)).filter((i) => i >= 0)
  const chosen = new Set(flagged.slice(0, limit))
  for (let k = 0; chosen.size < limit && k < limit; k++) chosen.add(Math.round((k * (check.pairs.length - 1)) / (limit - 1)))
  return [...chosen].sort((a, b) => a - b).map((i) => check.pairs[i] as CheckResult['pairs'][number])
}
