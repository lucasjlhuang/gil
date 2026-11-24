import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Asset } from '../shared/asset'
import { frameAtArgs, motionMeasureArgs } from '../shared/ffmpegArgs'
import { splitFrames } from '../shared/frames'
import { toGray } from '../shared/gate'
import { focusedSize, focusSchema, MOTION_FPS, MOTION_SIZE, motionSchema, type Backdrop } from '../shared/motion'
import { compareUse, movingMoments, profileOf, quietMoments, type UseCheck, type UseProfile } from '../shared/useCheck'
import { parseSpec } from '../shared/spec'
import { checkedKinds, compareStyles, observedStylesSchema, STYLE_PROBE, type ObservedStyles } from '../shared/styleCheck'
import { probePage, renderFrames } from './analysis/render'
import { runFfmpegCapture } from './ffmpeg'
import { CAPTURE_DIR, CLIP_FILE, FOCUS_CLIP_FILE, FOCUS_FILE, FOCUS_POSTER_FILE, MOTION_FILE, POSTER_FILE, SPEC_FILE } from './storage'

/**
 * Checks a use of an asset (shared/useCheck.ts): measures the capture's clip and a draft made
 * for other content the same way, and compares their motion. No model call, nothing leaves the
 * Mac. The draft is untrusted code and is played only in the sandboxed, offline render window.
 */

/** Pictures of the draft are drawn about this many pixels on their long side (small drafts up to 4×). */
const PICTURE_EDGE = 1100
/** Drafts longer than this are measured up to here. */
const MAX_DURATION_MS = 20_000

export async function profileOfClip(clipPath: string, backdrop: Backdrop | null = null): Promise<UseProfile> {
  const raw = await runFfmpegCapture(motionMeasureArgs(clipPath, MOTION_FPS, MOTION_SIZE))
  return profileOf(splitFrames(raw, MOTION_SIZE * MOTION_SIZE), MOTION_SIZE, MOTION_FPS, backdrop)
}

export async function profileOfHtml(html: string, width: number, height: number, durationMs: number): Promise<UseProfile> {
  const step = 1000 / MOTION_FPS
  const length = Math.max(2, Math.ceil(Math.min(MAX_DURATION_MS, durationMs) / step))
  const timestamps = Array.from({ length }, (_, i) => Math.round(i * step))
  // Each frame is kept only at the size it is measured at: a long draft is hundreds of frames.
  const images = await renderFrames(html, { width, height, scale: 1, timestamps }, (image) => image.resize({ width: MOTION_SIZE, height: MOTION_SIZE, quality: 'best' }))
  const frames = images.map((image) => toGray(MOTION_SIZE, MOTION_SIZE, image.toBitmap()).data)
  return profileOf(frames, MOTION_SIZE, MOTION_FPS)
}

export interface UseCheckResult {
  /** The draft at its quiet moments, as PNGs, for the AI tool to look at, each with the original capture at that moment when it could be read. */
  images: { atMs: number; png: Buffer; original: Buffer | null }[]
  check: UseCheck
  /** Null for an asset with no recorded motion. */
  original: UseProfile | null
  draft: UseProfile | null
  /** The kinds of style compared with the asset's, in words ('' if none). */
  styles: string
}

/** The styles the draft really uses, read from its rendered page; null if they cannot be read. */
async function stylesOf(html: string, width: number, height: number): Promise<ObservedStyles | null> {
  try {
    const answer = observedStylesSchema.safeParse(await probePage(html, width, height, STYLE_PROBE))
    return answer.success ? answer.data : null
  } catch (error) {
    console.error('Could not read the draft\'s styles', error)
    return null
  }
}

/**
 * Renders `html` (the draft, `width` × `height` CSS px) and compares it with the asset: its
 * motion with the capture's, when there is recorded motion, and the styles it uses with the
 * asset's tokens. Pictures of the capture and the draft come back with it.
 */
export async function checkUse(root: string, asset: Asset, html: string, width?: number, height?: number, backdrop?: Backdrop): Promise<UseCheckResult> {
  const capture = asset.capture
  if (!capture) throw new Error(`${asset.name} has no capture to check against`)
  const captureDir = join(root, asset.name, CAPTURE_DIR)
  // An asset made from part of a capture is compared with that part only.
  const focus = await readFile(join(captureDir, FOCUS_FILE), 'utf8').then((text) => focusSchema.parse(JSON.parse(text))).catch(() => null)
  const size = focus ? focusedSize(capture, focus) : capture
  const [w, h] = [width ?? size.width, height ?? size.height]
  const moving = capture.mode === 'recording' && !capture.isStill
  // At the capture's own pixel density, so the draft and the original compare at the same size.
  const scale = Math.max(1, Math.min(4, capture.scale || PICTURE_EDGE / Math.max(w, h)))

  let original: UseProfile | null = null
  let draft: UseProfile | null = null
  let gaps: string[] = []
  let images: UseCheckResult['images']
  if (moving) {
    // The capture's own measurement says whether page content scrolling behind it was left out.
    const saved = await readFile(join(captureDir, MOTION_FILE), 'utf8').then((text) => motionSchema.parse(JSON.parse(text))).catch(() => null)
    const clip = join(captureDir, focus ? FOCUS_CLIP_FILE : CLIP_FILE)
    original = await profileOfClip(clip, backdrop ?? saved?.backdrop ?? null)
    draft = await profileOfHtml(html, w, h, size.durationMs)
    gaps = compareUse(original, draft).gaps
    // What the draft looks like where the original is still: measuring cannot judge looks, the AI tool can.
    const moments = [...new Set([...quietMoments(original.motion, size.durationMs), ...movingMoments(original.motion)])].sort((a, b) => a - b)
    const pictures = moments.length ? await renderFrames(html, { width: w, height: h, scale, timestamps: moments }) : []
    // The capture at the same moments: how far the original goes is seen, not guessed from words.
    const originals = await Promise.all(moments.map((at) => runFfmpegCapture(frameAtArgs(clip, at)).catch(() => null)))
    images = pictures.map((image, i) => ({ atMs: moments[i] as number, png: image.toPNG(), original: originals[i] ?? null }))
  } else {
    // Nothing moves: one picture of each, side by side.
    const [picture] = await renderFrames(html, { width: w, height: h, scale, timestamps: [0] })
    const poster = await readFile(join(captureDir, focus ? FOCUS_POSTER_FILE : POSTER_FILE)).catch(() => null)
    images = picture ? [{ atMs: 0, png: picture.toPNG(), original: poster }] : []
  }

  // The look: the colours, text levels and radii the draft uses against the asset's own.
  const spec = await readFile(join(root, asset.name, SPEC_FILE), 'utf8').then(parseSpec).catch(() => null)
  const styles = spec ? await stylesOf(html, w, h) : null
  if (spec && styles) gaps = [...gaps, ...compareStyles(spec, styles)]
  return { images, check: { pass: gaps.length === 0, gaps }, original, draft, styles: spec ? checkedKinds(spec) : '' }
}
