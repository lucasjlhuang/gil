import { z } from 'zod'
import { activityOf, measureMotion, type Backdrop, type Motion, type MotionSegment } from './motion'

/**
 * Checking a use of an asset: when an AI tool applies an asset to the user's own content, its
 * draft is played and measured exactly as the capture was, and the two are compared. Pure.
 *
 * The content is different on purpose, so nothing here compares pictures. It compares what makes
 * a motion that motion whatever it is applied to: how many movements there are and in what
 * order, how long each lasts and the pauses between them, how each is paced, how strongly
 * each movement is beside the others, whether parts start one after another, and whether it ends
 * where it began. The answer is a list of gaps in plain words for the AI tool to fix.
 */

export interface UseProfile {
  fps: number
  motion: Motion
  /** Change at each step between frames, 0–255 (see motion.ts `activityOf`). */
  activity: number[]
  /** Light-to-dark range of the picture, 0–1: the same move changes less in a low-contrast design. */
  contrast: number
  /** Whether the last frame is the first frame again; null when page content scrolling behind makes that unknowable. */
  returns: boolean | null
}

/** Mean difference (0–255) under which two frames are the same picture. */
const SAME_FRAME = 4

export function profileOf(frames: readonly Uint8Array[], size: number, fps: number, backdrop: Backdrop | null = null): UseProfile {
  const first = frames[0]
  const last = frames[frames.length - 1]
  if (!first || !last || frames.length < 2) return { fps, motion: { fps, segments: [] }, activity: [], contrast: 1, returns: true }
  let lo = 255
  let hi = 0
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 7) {
      const value = frame[i] as number
      if (value < lo) lo = value
      if (value > hi) hi = value
    }
  }
  let difference = 0
  for (let i = 0; i < first.length; i++) difference += Math.abs((first[i] as number) - (last[i] as number))
  return {
    fps,
    motion: measureMotion(frames, size, fps, undefined, backdrop),
    activity: activityOf(frames, size, undefined, backdrop).activity,
    contrast: Math.max(0.05, (hi - lo) / 255),
    // With the page scrolling behind, the first and last frames differ whatever the thing does.
    returns: backdrop ? null : difference / first.length < SAME_FRAME,
  }
}

export interface UseCheck {
  pass: boolean
  /** What differs from the original, most important first; empty when it passes. */
  gaps: string[]
}

/** Times may differ by two frames, or this share of the original's time if that is more. */
const TIME_SHARE = 0.12
/** A movement less than this strong beside the others, compared with the original, is too weak; more than STRONG times, too strong. */
const WEAK = 0.3
const STRONG = 3
/** A stagger in the original has to spread over at least this long to be asked of the draft. */
const STAGGER_MS = 150

const ms = (value: number) => `${Math.round(value)} ms`
const tolerance = (fps: number, original: number) => Math.max((2 * 1000) / fps, TIME_SHARE * original)

/** One movement, or several with only short pauses between them, taken together. */
interface Span {
  startMs: number
  endMs: number
  durationMs: number
  cut: boolean
  /** The measured segment, when the span is exactly one. */
  segment: MotionSegment | null
}

/** Movements closer together than this may be one movement in the other version. */
const MERGE_PAUSE_MS = 250

function spans(motion: Motion, mergePauseMs: number): Span[] {
  const out: Span[] = []
  for (const segment of motion.segments) {
    const last = out[out.length - 1]
    if (last && mergePauseMs > 0 && segment.startMs - last.endMs <= mergePauseMs) {
      last.endMs = segment.endMs
      last.durationMs = last.endMs - last.startMs
      last.cut = last.cut || segment.cutAtEnd
      last.segment = null
    } else {
      out.push({ startMs: segment.startMs, endMs: segment.endMs, durationMs: segment.durationMs, cut: segment.cutAtStart || segment.cutAtEnd, segment })
    }
  }
  return out
}

/** The steps of a span in the activity curve. */
function stepsOf(profile: UseProfile, span: Span): number[] {
  const step = 1000 / profile.fps
  const start = Math.round(span.startMs / step)
  const end = Math.max(start + 1, Math.round(span.endMs / step))
  return profile.activity.slice(start, end)
}

/** All the change made in a span. */
function total(profile: UseProfile, span: Span): number {
  return stepsOf(profile, span).reduce((sum, value) => sum + value, 0)
}

/** How far through its time (0–1) a span is when 10%, 20% … 90% of its change is done. */
function pace(profile: UseProfile, span: Span): number[] | null {
  const steps = stepsOf(profile, span)
  const total = steps.reduce((sum, value) => sum + value, 0)
  if (steps.length < 4 || total <= 0) return null
  const out: number[] = []
  let done = 0
  let at = 0
  for (let k = 1; k <= 9; k++) {
    const target = (total * k) / 10
    while (at < steps.length && done + (steps[at] as number) < target) done += steps[at++] as number
    const inside = at < steps.length && (steps[at] as number) > 0 ? (target - done) / (steps[at] as number) : 0
    out.push((at + inside) / steps.length)
  }
  return out
}

const listSpans = (list: readonly Span[]) => list.map((span, i) => `${i + 1}: starts at ${ms(span.startMs)}, lasts ${ms(span.durationMs)}`).join('; ') || 'none'
const listMovements = (motion: Motion) => listSpans(spans(motion, 0))

/** Compares a draft's measured motion with the original capture's. */
export function compareUse(original: UseProfile, draft: UseProfile): UseCheck {
  const gaps: string[] = []
  let a = spans(original.motion, 0)
  let b = spans(draft.motion, 0)
  if (a.length === 0) {
    // Nothing was measured moving in the capture, so anything moving in the draft is not from it.
    return b.length === 0 ? { pass: true, gaps: [] } : { pass: false, gaps: [`gil measured no movement in the original capture, but the draft has ${b.length} (${listSpans(b)}). There is nothing to compare its motion with.`] }
  }
  if (b.length === 0) {
    return { pass: false, gaps: [`Nothing moves in the draft. The original has ${a.length} movement${a.length === 1 ? '' : 's'} (${listSpans(a)}). The draft must play by itself when window.replay() is called.`] }
  }
  if (a.length !== b.length) {
    // A short pause in one that the other runs through: say so, then compare the larger movements.
    const [mergedA, mergedB] = [spans(original.motion, MERGE_PAUSE_MS), spans(draft.motion, MERGE_PAUSE_MS)]
    gaps.push(
      `The original has ${a.length} separate movement${a.length === 1 ? '' : 's'} (${listSpans(a)}); the draft has ${b.length} (${listSpans(b)}). Where the original pauses between steps the draft must pause as long, and where it runs on the draft must run on.`,
    )
    if (mergedA.length === mergedB.length) [a, b] = [mergedA, mergedB]
    // Still a different number: say which of the original's movements nothing in the draft
    // overlaps (a change too faint to be seen counts as missing), and compare nothing else,
    // since which movement goes with which is unknown.
    else {
      a.forEach((span, i) => {
        if (!b.some((other) => other.startMs < span.endMs && other.endMs > span.startMs)) {
          gaps.push(`Nothing is seen moving in the draft during the original's movement ${i + 1} (${ms(span.startMs)} to ${ms(span.endMs)}): that step is missing, runs at another time, or changes too little to be seen.`)
        }
      })
      return { pass: false, gaps }
    }
  }
  const count = a.length
  for (let i = 0; i < count; i++) {
    const o = a[i] as Span
    const d = b[i] as Span
    const name = count === 1 ? 'The movement' : `Movement ${i + 1}`
    const lower = name.charAt(0).toLowerCase() + name.slice(1)
    const where = `(${ms(d.startMs)} to ${ms(d.endMs)} in the draft)`
    // When the change happens, by how much of it is done: the times at which 10%, 20% … 90% of
    // a movement's change has been made. Unlike where a movement is first and last noticed,
    // these hardly move with a gentle start or end, or with how much ink the content has.
    const [po, pd] = [pace(original, o), pace(draft, d)]
    if (po && pd && !o.cut) {
      const allowed = tolerance(original.fps, o.durationMs)
      const at = (span: Span, fraction: number) => span.startMs + fraction * span.durationMs
      const off = po.map((value, k) => Math.abs(at(d, pd[k] as number) - at(o, value)))
      if ((off[0] as number) > allowed || (off[8] as number) > allowed) {
        gaps.push(
          `${name}: in the draft the bulk of its change (from 10% to 90% done) runs from ${ms(at(d, pd[0] as number))} to ${ms(at(d, pd[8] as number))}; in the original from ${ms(at(o, po[0] as number))} to ${ms(at(o, po[8] as number))}.`,
        )
      } else {
        const worst = off.indexOf(Math.max(...off))
        if ((off[worst] as number) > allowed) {
          gaps.push(
            `${name} ${where} is paced differently: the draft has made ${(worst + 1) * 10}% of its change at ${ms(at(d, pd[worst] as number))}, the original at ${ms(at(o, po[worst] as number))}. Match when each step inside it starts, how long it lasts and its easing.`,
          )
        }
      }
    }
    // Too short to pace: its length is all there is to compare.
    if ((!po || !pd) && !o.cut && Math.abs(d.durationMs - o.durationMs) > tolerance(original.fps, o.durationMs)) {
      gaps.push(`${name} ${where} lasts ${ms(d.durationMs)}; in the original it lasts ${ms(o.durationMs)}.`)
    }
    // A stagger of a frame or two cannot be told apart from how the content happens to be drawn.
    if (o.segment?.stagger?.direction && o.segment.stagger.spreadMs >= STAGGER_MS && d.segment && !d.segment.stagger) {
      gaps.push(`In ${lower} of the original, parts start one after another, ${o.segment.stagger.direction.replace(/-/g, ' ')}, over ${ms(o.segment.stagger.spreadMs)}; in the draft they all start together.`)
    }
  }
  // How strong each movement is beside the others. Amounts are never compared directly: a short
  // word has less to wipe than a long one. But if the original's second movement is a third as
  // strong as its first, the draft's should be about that too, whatever the content.
  if (count > 1) {
    const [to, td] = [a.map((span) => total(original, span)), b.map((span) => total(draft, span))]
    const [maxO, maxD] = [Math.max(...to), Math.max(...td)]
    for (let i = 0; i < count && maxO > 0 && maxD > 0; i++) {
      const share = (to[i] as number) / maxO
      if (share <= 0) continue
      const ratio = (td[i] as number) / maxD / share
      const d = b[i] as Span
      const where = `movement ${i + 1} (${ms(d.startMs)} to ${ms(d.endMs)} in the draft)`
      if (ratio < WEAK) {
        gaps.push(
          `Beside the other movements, ${where} is only about ${Math.round(ratio * 100)}% as strong as it is in the original: what changes there is hard to see. Go by the pictures of the original: match the degree of change you see there. If your shape already changes as much as the original's does, leave it and tell the user this is where the measurement differs; never exaggerate a shape to raise this number.`,
        )
      } else if (ratio > STRONG) {
        gaps.push(`Beside the other movements, ${where} is about ${Math.round(ratio)} times as strong as it is in the original: something extra moves there, or a step that belongs to another movement runs there.`)
      }
    }
  }
  if (original.returns === true && draft.returns === false) gaps.push('The original ends exactly as it began; the draft ends in a different state.')
  // The other way round is not reported: a capture often ends differently only because a
  // pointer or the page behind it moved.
  return { pass: gaps.length === 0, gaps }
}

/**
 * Moments (ms) at which to show a draft: the middle of each stretch where the original is
 * still, before, between and after its movements. At most `limit`, the longest stretches first.
 */
export function quietMoments(motion: Motion, durationMs: number, limit = 4): number[] {
  const edges = [0, ...motion.segments.flatMap((segment) => [segment.startMs, segment.endMs]), durationMs]
  const stretches: { at: number; length: number }[] = []
  for (let i = 0; i < edges.length; i += 2) {
    const [from, to] = [edges[i] as number, edges[i + 1] as number]
    if (to - from >= 150) stretches.push({ at: Math.round((from + to) / 2), length: to - from })
  }
  return stretches.sort((a, b) => b.length - a.length).slice(0, limit).map((stretch) => stretch.at).sort((a, b) => a - b)
}

/** The middle of each movement (ms), the longest first when there are more than `limit`. */
export function movingMoments(motion: Motion, limit = 3): number[] {
  return [...motion.segments]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit)
    .map((segment) => Math.round((segment.startMs + segment.endMs) / 2))
    .sort((a, b) => a - b)
}

/** The result as text for the AI tool. */
export function describeUseCheck(check: UseCheck, original: UseProfile | null, draft: UseProfile | null, checksLeft: number, images = 0, styles = ''): string {
  const moving = original !== null && draft !== null
  const look = styles ? `the ${styles} it uses are the asset's own, nothing is cut off, and its text is readable` : 'nothing is cut off and its text is readable, but this asset has no colours, text levels, radii or spacing to compare styles with, so whether the look matches is yours to judge from the pictures'
  const lines: string[] = []
  if (check.pass) {
    lines.push(
      moving
        ? `gil played the draft and measured it against the original capture: the number and order of movements, their lengths and pauses, their pacing, how strong each is beside the others, and how it ends all match, and ${look}. ${styles ? 'It is ready to show the user, once the pictures look right to you.' : 'Show the user only once the pictures convince you.'}`
        : `gil rendered the draft and compared it with the asset: ${look}. ${styles ? 'It is ready to show the user, once the pictures look right to you.' : 'Show the user only once the pictures convince you.'}`,
    )
  } else {
    lines.push(`gil ${moving ? 'played the draft and measured it against the original capture' : 'rendered the draft and compared it with the asset'}. ${check.gaps.length} thing${check.gaps.length === 1 ? ' differs' : 's differ'}:`)
    for (const gap of check.gaps) lines.push(`- ${gap}`)
    lines.push(
      checksLeft > 0
        ? `Fix these and check again (${checksLeft} check${checksLeft === 1 ? '' : 's'} left for this use). Change what is listed and leave the rest; when a fix also changes another movement (a move and its reverse share a shape), keep that one matching too. A colour, text size or radius that is not the asset's is right to keep only where the user asked for it (their brand colour, their type); otherwise use the asset's.`
        : 'That was the last check for this use. Show the user the draft and tell them plainly which of these differences remain.',
    )
  }
  if (moving) lines.push('', `Original: ${listMovements(original.motion)}.`, `Draft: ${listMovements(draft.motion)}.`)
  if (images > 0) {
    lines.push(
      moving
        ? 'The pictures show the original capture and your draft at the same moments: where the original is still, and half way through each movement. Look at them before anything else. First the original: see how far it goes. How different is each resting state from the one before, how much of a shape stays recognisable, how bold or how subtle is the change? Your draft should go exactly that far with the new content, no further and no less. Then your draft: is every letter and shape well drawn, clearly the user\'s content, complete and not cut off, and as good as you would show a client? Are the shapes half way through a movement clean, not tangled? Fix what is not, even if the motion already matches. In a picture of the original, anything cut off by the edges of the picture is the page behind it, not part of the design.'
        : 'The pictures show the original capture and your draft. Look at them before anything else. First the original: its proportions, spacing, alignment, weight and density, what is emphasised and what is quiet. Your draft should read as the same design with the user\'s content in it. Then your draft: is everything well drawn, aligned, complete and not cut off, and as good as you would show a client? Fix what is not.',
    )
  }
  lines.push(
    moving
      ? 'Times are in ms after window.replay(), measured at 30 frames a second; times within about 70 ms, or 12% of a movement, count as matching. gil measures motion and reads styles; it cannot tell whether the new content is drawn well, so judge that yourself, and do not make a shape worse only to change a number.'
      : `gil reads the styles the draft uses${styles ? '' : ' (this asset has no colours, text levels or radii to compare with, so only readability is checked)'}; it cannot tell whether the new content is laid out well, or whether each colour is used in its role, so judge that yourself from the pictures.`,
  )
  return lines.join('\n')
}

/**
 * A check handed from gil's MCP server (plain Node) to gil itself, which can play the draft:
 * written to a file, answered in another. See main/checkMode.ts and mcp/check.ts.
 */
export const CHECK_FLAG = '--gil-check'
export const MAX_DRAFT_BYTES = 3 * 1024 * 1024

export const useCheckRequestSchema = z.object({
  /** The library folder. */
  root: z.string().min(1),
  /** The asset's name (its folder). */
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  /** The draft: one self-contained HTML document that plays when window.replay() is called. */
  html: z.string().min(1).max(MAX_DRAFT_BYTES),
  /** The draft's size in CSS px; the capture's size when left out. */
  width: z.number().positive().max(4000).optional(),
  height: z.number().positive().max(4000).optional(),
  checksLeft: z.number().int().min(0),
  /** Where the answer is written. */
  out: z.string().min(1),
})
export type UseCheckRequest = z.infer<typeof useCheckRequestSchema>

export const useCheckAnswerSchema = z.union([
  z.object({
    ok: z.literal(true),
    pass: z.boolean(),
    text: z.string(),
    /** The draft as gil drew it at its quiet moments (PNG, base64), for the AI tool to look at. */
    images: z.array(z.object({ atMs: z.number(), data: z.string(), original: z.string().nullable().default(null) })).default([]),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type UseCheckAnswer = z.infer<typeof useCheckAnswerSchema>
