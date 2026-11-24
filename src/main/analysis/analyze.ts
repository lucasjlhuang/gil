import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatTimestamp, type Asset, type AssetCapture, type AssetKind, type AssetLens } from '../../shared/asset'
import {
  ANALYSIS_FPS,
  focusClipArgs,
  focusStillArgs,
  frameEdge,
  frameScale,
  motionMeasureArgs,
  posterArgs,
  motionThumbnailArgs,
  selectedFramesArgs,
  stillFrameArgs,
  THUMB_SIZE,
} from '../../shared/ffmpegArgs'
import { DEFAULT_SELECTION, frameDifferences, selectFrames, splitFrames, thinToFit } from '../../shared/frames'
import { describeMotion, describeScroll, scrollTimeline, differencesFromMotion, framesForMotion, measureMotion, MOTION_FPS, MOTION_SIZE, focusFrom, focusedSize, focusSchema, motionSchema, sameTimeline, type Backdrop, type Focus, type Motion } from '../../shared/motion'
import { addRequest, NO_REFINEMENTS, refinementsSchema, type Refinements } from '../../shared/refinements'
import { isProvisionalName, slugify } from '../../shared/slug'
import { correctedHtml, parseSpec, planKind, specFromDescription, type Spec } from '../../shared/spec'
import { writeSpecMarkdown } from '../assets'
import { runFfmpeg, runFfmpegCapture } from '../ffmpeg'
import {
  CAPTURE_DIR,
  CLIP_FILE,
  EDITS_FILE,
  FOCUS_CLIP_FILE,
  FOCUS_FILE,
  FOCUS_POSTER_FILE,
  FRAMES_DIR,
  MOTION_FILE,
  POSTER_FILE,
  readAsset,
  RECREATION_BASE_FILE,
  RECREATION_DIR,
  RECREATION_FILE,
  RECREATION_FIRST_FILE,
  REFINEMENTS_FILE,
  renameAsset,
  SPEC_FILE,
  updateAsset,
  writeFileAtomic,
} from '../storage'
import {
  createClient,
  describe,
  NO_CHANGES,
  recreate,
  verify,
  type CaptureFacts,
  type Frame,
  type Usage,
  type UserChanges,
} from './claude'
import { nativeImage } from 'electron'
import { describeLayout, measureLayout } from '../../shared/layoutMeasure'
import { describeTraces, traceFrame, withoutBoxes, type TracedFrame } from '../../shared/trace'
import { describeFittedTexts, embedFontData, embeddedFontData, stripFontData } from '../../shared/fontEmbed'
import { embedFonts } from '../fonts'
import { fitTexts } from './textFonts'
import { better, checkRecreation, worthCorrecting, cssGray, pairsForFix, patchNumbers, restingFrames, type CaptureSize, type CheckResult } from './check'
import { addUsage, NO_USAGE } from '../../shared/cost'
import { RECIPE_FILE, recipeToMarkdown } from '../../shared/recipe'
import { typeSpecimenPage } from '../../shared/typeSpecimen'
import { describePageStyles, PAGE_STYLES_FILE, pageStylesSchema, type PageStyles } from '../../shared/pageStyles'
import { describeImagePalette } from '../colorLens'

/** The asset type each lens makes; auto leaves it to the model. */
const KIND_FOR_LENS: Partial<Record<AssetLens, AssetKind>> = {
  motion: 'motion',
  component: 'component',
  layout: 'layout',
  type: 'type-system',
  color: 'color-system',
  font: 'font',
  spacing: 'spacing-system',
  effects: 'effect',
  icons: 'icon-style',
  transition: 'motion',
  scroll: 'motion',
}

/** Total size of the original frames in one request, before base64. The API allows 32 MB. */
const MAX_FRAME_BYTES = 18 * 1024 * 1024
/** For verify, originals and renders together. */
const MAX_PAIR_BYTES = 20 * 1024 * 1024
export interface AnalysisResult {
  asset: Asset
  usage: Usage
  /** What the last verify round still found, if anything. */
  differences: string[]
}

type Anthropic = ReturnType<typeof createClient>

function factsFor(
  asset: Asset,
  capture: AssetCapture,
  isStill: boolean,
  motion: Motion | null,
  /** The image colours and boxes are measured from: the poster, or the focused part's first frame. */
  posterPath: string,
  pageStyles: PageStyles | null,
  frames: readonly Frame[],
): CaptureFacts {
  return {
    tracedShapes: describeTraces(traceFrames(frames, motion, capture)),
    lens: asset.lens,
    pageStyles: describePageStyles(pageStyles),
    // The page's own boxes are exact; without them, boxes are measured from the pixels.
    measuredLayout: pageStyles?.boxes?.length ? '' : layoutOfImage(posterPath, capture.width, capture.height),
    // The resting state's colours, measured from the poster; others the model sees are estimates.
    measuredColors: describeImagePalette(posterPath),
    measuredMotion: motion ? describeMotion(motion, capture.width, capture.height) : '',
    width: capture.width,
    height: capture.height,
    frameScale: frameScale(capture.width, capture.height),
    isStill,
    mode: capture.mode,
    durationMs: capture.durationMs,
    userContext: asset.userContext,
  }
}

/**
 * Analyzes one asset end to end, aiming to match the capture on the first try at low cost:
 *
 * 1. Measure on the Mac, free: motion from every frame, colours from pixels, layout boxes, and
 *    whatever the Chrome extension read from the page. Frames are chosen from the movements.
 * 2. Plan: a small model reads the frames and the measurements and writes the spec.
 * 3. Build: the main model writes the recreation from the spec, the numbers and the frames.
 * 4. Check and fix: the recreation is rendered and compared locally (2 px, 2 frames, nothing
 *    missing). Number gaps are patched in the code without the model; if parts are still missing
 *    or wrong, one correction on a cheaper model, kept only if the check improves.
 *
 * Writes everything into the asset folder, keeps this first recreation as `first.html`, marks the
 * asset ready, and gives it the suggested name if it still has its capture-time name.
 */
export async function analyzeAsset(root: string, name: string, apiKey: string): Promise<AnalysisResult> {
  const asset = await readAsset(root, name)
  const capture = asset.capture
  if (!capture) throw new Error('Only captures can be analyzed')
  const captureDir = join(root, name, CAPTURE_DIR)

  // Measured first: the frames the model sees are chosen from the measured movements.
  const choices = capture.mode === 'recording' ? await measureClipChoices(join(captureDir, CLIP_FILE)) : null
  const measured = choices?.raw ?? null
  const first =
    capture.mode === 'screenshot'
      ? { frames: [await stillFrame(join(captureDir, POSTER_FILE), capture)], isStill: true }
      : await pickFrames(join(captureDir, CLIP_FILE), capture, measured)
  const isStill = first.isStill
  let frames = first.frames
  if (frames.length === 0) throw new Error('The clip has no frames')
  await saveFrames(captureDir, frames)
  const rawMotion = isStill ? null : measured
  // Saved before the plan, so a failed call never leaves an older measurement beside new frames.
  if (rawMotion) await writeFileAtomic(join(captureDir, MOTION_FILE), `${JSON.stringify(rawMotion, null, 2)}\n`)
  else await rm(join(captureDir, MOTION_FILE), { force: true })

  const pageStyles = await readPageStyles(captureDir)
  let facts = factsFor(asset, capture, isStill, rawMotion, join(captureDir, POSTER_FILE), pageStyles, frames)
  const alternatives = rawMotion && choices ? scrollChoices(choices, capture) : ''
  // Scroll choreography is about scroll position, not time: measure how far the page scrolled.
  if (asset.lens === 'scroll' && rawMotion && capture.mode === 'recording') {
    const scroll = await scrollOfClip(join(captureDir, CLIP_FILE), capture.height)
    if (scroll) facts.measuredMotion = `${facts.measuredMotion}\n${scroll}`
  }
  const client = createClient(apiKey)
  const described = await describe(client, frames, alternatives ? { ...facts, measuredMotion: `${facts.measuredMotion}\n${alternatives}` } : facts)
  // Page content scrolling behind the thing is not its motion: everything after the plan uses
  // the measurement without it.
  // The plan's word is taken only where leaving the scroll out changes the timeline and still
  // leaves something moving: a thing that itself slides must not lose its own motion.
  const answered = rawMotion ? backdropOf(described.output.backdrop) : null
  const without = answered ? choices?.[answered] : undefined
  let motion = rawMotion && without && without.segments.length > 0 && !sameTimeline(rawMotion, without) ? without : rawMotion
  if (motion && motion !== rawMotion) {
    await writeFileAtomic(join(captureDir, MOTION_FILE), `${JSON.stringify(motion, null, 2)}\n`)
    facts.measuredMotion = `${describeMotion(motion, capture.width, capture.height)}\nPage content scrolling behind the thing was left out of this measurement; it is backdrop, not part of the design.`
  }
  // The user asked for only part of what was captured: gil cuts the capture to that part, in
  // time and in area, measures it again, and from here on works on it alone.
  let work: { width: number; height: number; durationMs: number } = capture
  const plan = described.output
  const focus = focusFrom(
    { fromMs: plan.focusFromMs, toMs: plan.focusToMs, x: plan.focusX, y: plan.focusY, width: plan.focusWidth, height: plan.focusHeight },
    capture.mode === 'recording' && !isStill ? capture.durationMs : 0,
  )
  const focusClip = join(captureDir, FOCUS_CLIP_FILE)
  const focusPoster = join(captureDir, FOCUS_POSTER_FILE)
  for (const file of [focusClip, focusPoster, join(captureDir, FOCUS_FILE)]) await rm(file, { force: true })
  if (focus) {
    try {
      const size = focusedSize(capture, focus)
      let focusedMotion: Motion | null = null
      let focusedFrames: Frame[]
      if (capture.mode === 'recording') {
        // A recording in which nothing moves has no span to cut, only an area.
        await runFfmpeg(focusClipArgs(join(captureDir, CLIP_FILE), focusClip, isStill ? { fromMs: 0, toMs: capture.durationMs, box: focus.box } : focus))
        await runFfmpeg(posterArgs(focusClip, focusPoster))
        const again = isStill ? null : await measureClipChoices(focusClip, answered ? [answered] : [])
        const scrolled = answered ? again?.[answered] : undefined
        focusedMotion = again ? (scrolled && scrolled.segments.length > 0 && !sameTimeline(again.raw, scrolled) ? scrolled : again.raw) : null
        focusedFrames = isStill ? [await stillFrame(focusPoster, size)] : (await pickFrames(focusClip, size, focusedMotion)).frames
      } else {
        if (!focus.box) throw new Error('A screenshot can only be focused on part of the picture')
        await runFfmpeg(focusStillArgs(join(captureDir, POSTER_FILE), focusPoster, focus.box))
        focusedFrames = [await stillFrame(focusPoster, size)]
      }
      if (focusedFrames.length === 0) throw new Error('The focused part has no frames')
      frames = focusedFrames
      motion = focusedMotion
      work = size
      await saveFrames(captureDir, frames)
      await writeFileAtomic(join(captureDir, FOCUS_FILE), `${JSON.stringify(focus, null, 2)}\n`)
      if (motion) await writeFileAtomic(join(captureDir, MOTION_FILE), `${JSON.stringify(motion, null, 2)}\n`)
      else await rm(join(captureDir, MOTION_FILE), { force: true })
      // The page's own boxes are positions in the whole capture; they no longer apply to a part of the picture.
      facts = factsFor(asset, { ...capture, ...size }, isStill, motion, focusPoster, focus.box ? null : pageStyles, frames)
      const where = [
        capture.mode === 'recording' && !isStill ? `${focus.fromMs}–${focus.toMs} ms of the original clip` : '',
        focus.box ? `the box at ${Math.round(focus.box.x * capture.width)}, ${Math.round(focus.box.y * capture.height)} px of the original region, ${size.width} × ${size.height} px` : '',
      ].filter(Boolean)
      facts.userContext = `${facts.userContext ?? ''}\nThe user asked for only part of what was captured, and gil has cut the capture to it: ${where.join(', and ')}. The frames, sizes, positions, measurements and times you are given are all of that part alone, counted from its top left and its start. Where the spec's numbers differ from these measurements, the measurements are right. Rebuild that part only, ${size.width} × ${size.height} px${size.durationMs ? `, ${size.durationMs} ms long` : ''}.`.trim()
    } catch (error) {
      // The whole capture is still a correct thing to build from; the plan already describes only the wanted part.
      console.error('Could not cut the capture to the part asked for; analyzing all of it', error)
      for (const file of [focusClip, focusPoster, join(captureDir, FOCUS_FILE)]) await rm(file, { force: true })
    }
  }
  const spec = specFromDescription(described.output, isStill)
  await writeFileAtomic(join(root, name, SPEC_FILE), `${JSON.stringify(spec, null, 2)}\n`)
  const output = described.output

  // Text the plan listed is matched to real fonts and measured, so the build sets real text;
  // the traced outlines of that text are then left out of the prompt.
  if (asset.lens !== 'type' && described.output.texts.length > 0) {
    const resting = [...restingFrames(frames, motion)].sort((a, b) => a - b)[0] ?? 0
    const fitted = await fitTexts(frames[resting] as Frame, work, described.output.texts, pageStyles?.texts.map((text) => text.fontFamily.split(',')[0]?.replace(/["']/g, '').trim() ?? '') ?? [])
    if (fitted.length > 0) {
      facts.realFonts = describeFittedTexts(fitted)
      facts.tracedShapes = describeTraces(withoutBoxes(traceFrames(frames, motion, work), fitted.map((text) => text.ink)))
    }
  }

  // The type lens's output is a specimen gil builds from the saved values: no build or fix
  // call, so it costs one small request and is always the same for the same spec.
  const specimen = asset.lens === 'type'
  const recreated = specimen
    ? { output: { html: typeSpecimenPage(spec, output.title.trim() || asset.title), recipe: null }, model: described.model, usage: NO_USAGE }
    : await recreate(client, frames, facts, spec)
  const checked: Checked = specimen
    ? { html: recreated.output.html, rounds: 0, model: null, usage: NO_USAGE, differences: [] }
    : await checkAndFix(client, frames, facts, spec, recreated.output.html, sizeOf(work, facts), motion, NO_CHANGES)
  await saveRecreation(root, name, checked.html, NO_REFINEMENTS)
  // The recreation as first made, kept through every later Refine and edit.
  await writeFileAtomic(join(root, name, RECREATION_DIR, RECREATION_FIRST_FILE), await embedFonts(checked.html))

  const usage = addUsage(addUsage(described.usage, recreated.usage), checked.usage)
  const tags = [...new Set(output.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
  let saved = await updateAsset(root, name, (current) => ({
    ...current,
    title: output.title.trim() || current.title,
    // A lens the user chose decides the kind.
    kind: KIND_FOR_LENS[current.lens] ?? planKind(output),
    summary: output.summary.trim() || null,
    tags,
    status: 'ready',
    capture: current.capture ? { ...current.capture, isStill } : current.capture,
    // The model that wrote the recreation; a fresh analysis starts the usage count again.
    analysis: { model: checked.model ?? recreated.model, rounds: 1 + checked.rounds, error: null, usage: { ...usage } },
    updatedAt: formatTimestamp(new Date()),
  }))
  // Only replace the name gil gave it at capture time; a name the user chose stays.
  const suggested = slugify(output.name)
  if (suggested && isProvisionalName(saved.name)) saved = await renameAsset(root, saved.name, suggested)
  await writeSpecMarkdown(root, saved)
  // The recipe: how it is built, for an AI tool to apply to the user's own content.
  if (recreated.output.recipe) {
    await writeFileAtomic(join(root, saved.name, RECIPE_FILE), recipeToMarkdown(recreated.output.recipe, { title: saved.title, name: saved.name }))
  } else {
    await rm(join(root, saved.name, RECIPE_FILE), { force: true })
  }

  return { asset: saved, usage, differences: checked.differences }
}

/**
 * Refine: the main model corrects the current recreation with the user's instruction, seeing it
 * beside the original frames. The result is then checked locally and its numbers patched without
 * the model; there is no second model round. Later rounds are told what the user has asked for
 * so far, so nothing undoes it.
 */
export async function refineAsset(
  root: string,
  name: string,
  apiKey: string,
  instruction: string,
): Promise<AnalysisResult> {
  const asset = await readAsset(root, name)
  const capture = asset.capture
  if (!capture) throw new Error('Only captures can be refined')
  const captureDir = join(root, name, CAPTURE_DIR)
  const recreationDir = join(root, name, RECREATION_DIR)

  // A type specimen is built by gil from the spec, not matched to the frames: re-analyze instead.
  if (asset.lens === 'type') throw new Error('A type system is rebuilt from its values; analyze it again instead of refining')
  const specText = await readFile(join(root, name, SPEC_FILE), 'utf8').catch(() => null)
  const onDisk =
    (await readFile(join(recreationDir, RECREATION_BASE_FILE), 'utf8').catch(() => null)) ??
    (await readFile(join(recreationDir, RECREATION_FILE), 'utf8').catch(() => null))
  if (!specText || onDisk === null) throw new Error('Analyze this capture before refining it')
  // The model works on the code with font placeholders, not tens of thousands of characters of font data.
  const html = stripFontData(onDisk)
  // Its own fonts go back in from the file itself, so they survive without gil's font cache.
  const ownFonts = embeddedFontData(onDisk)
  const spec = parseSpec(specText)
  const earlier = await readRefinements(recreationDir)
  // Assets analyzed before first.html existed: what is there now is the earliest copy left.
  const firstPath = join(recreationDir, RECREATION_FIRST_FILE)
  if (earlier.requests.length === 0 && !(await readFile(firstPath, 'utf8').catch(() => null))) await writeFileAtomic(firstPath, onDisk)

  const motion = await readMotion(captureDir)
  // Analyzed as part of the capture: Refine works on that part too.
  const focus = await readFocus(captureDir)
  const work = focus ? { ...capture, ...focusedSize(capture, focus) } : capture
  const clipPath = join(captureDir, focus ? FOCUS_CLIP_FILE : CLIP_FILE)
  const posterPath = join(captureDir, focus ? FOCUS_POSTER_FILE : POSTER_FILE)
  let frames = await loadFrames(join(captureDir, FRAMES_DIR))
  if (frames.length === 0) {
    frames =
      capture.mode === 'screenshot' || capture.isStill
        ? [await stillFrame(posterPath, work)]
        : (await pickFrames(clipPath, work, motion)).frames
    await saveFrames(captureDir, frames)
  }

  const facts = factsFor(asset, work, capture.isStill, motion, posterPath, focus?.box ? null : await readPageStyles(captureDir), frames)
  if (ownFonts.size > 0) {
    facts.realFonts = 'Text in real fonts: some text in this recreation is set in real fonts gil matched to the capture (the @font-face rules with url(gil-font:…)). Keep that text as real text in those fonts, leave those rules exactly as they are, and do not replace it with traced paths.'
  }
  const client = createClient(apiKey)
  const refinements = addRequest(earlier, instruction)
  const refined = await checkAndFix(client, frames, facts, spec, html, sizeOf(work, facts), motion, {
    applied: earlier.requests,
    request: instruction,
  })
  await saveRecreation(root, name, embedFontData(refined.html, ownFonts), refinements)

  const saved = await updateAsset(root, name, (current) => ({
    ...current,
    status: 'ready',
    analysis: {
      model: refined.model ?? current.analysis?.model ?? 'unknown',
      rounds: (current.analysis?.rounds ?? 1) + refined.rounds,
      error: null,
      usage: { ...addUsage(current.analysis?.usage, refined.usage) },
    },
    updatedAt: formatTimestamp(new Date()),
  }))
  return { asset: saved, usage: refined.usage, differences: refined.differences }
}

interface Checked {
  html: string
  /** Model rounds used: 0 or 1. */
  rounds: number
  model: string | null
  usage: Usage
  /** What the local check still finds off at the end. */
  differences: string[]
}

function sizeOf(capture: { width: number; height: number }, facts: CaptureFacts): CaptureSize {
  // The facts' length is the focused part's when the user asked for part of the recording.
  return { width: capture.width, height: capture.height, scale: facts.frameScale, durationMs: facts.durationMs }
}

/** Pairs sent with a correction; more would mostly repeat what the model has already seen. */
const MAX_FIX_PAIRS = 10

/**
 * The check-and-fix step. Without a request: check locally, patch numbers, and while something
 * is still missing or wrong, up to MAX_ROUNDS corrections, each given the frame pairs and the
 * measured differences in words and kept only if the local check says it is better. It stops as
 * soon as the check passes. With a request (Refine): the model applies it once, then the
 * result's numbers are patched.
 *
 * A recreation that cannot be rendered is kept as it is: the check is a refinement, not a
 * requirement.
 */
async function checkAndFix(
  client: Anthropic,
  frames: readonly Frame[],
  facts: CaptureFacts,
  spec: Spec,
  initialHtml: string,
  size: CaptureSize,
  motion: Motion | null,
  changes: UserChanges,
): Promise<Checked> {
  const done = (html: string, check: CheckResult | null, rounds: number, model: string | null, usage: Usage): Checked => ({
    html,
    rounds,
    model,
    usage,
    differences: check?.problems ?? [],
  })
  let current: { html: string; check: CheckResult }
  try {
    const check = await checkRecreation(initialHtml, size, frames, motion)
    // A user's request changes the recreation on purpose, so numbers are patched after it.
    current = changes.request ? { html: initialHtml, check } : await patchNumbers(initialHtml, check, size, frames, motion)
  } catch (error) {
    console.error('Could not render the recreation to check it', error)
    return done(initialHtml, null, 0, null, NO_USAGE)
  }
  // Passing, or failing with nothing the model could be told to fix: no model call.
  // Passing, or failing with nothing the model could be told to fix: no model call.
  if (!changes.request && !worthCorrecting(current.check)) return done(current.html, current.check, 0, null, NO_USAGE)

  // Up to MAX_ROUNDS corrections: the model sees the frame pairs and the measured differences,
  // and each result is kept only if the local check says it is better. A request (Refine) gets
  // one round and is always kept.
  let usage: Usage = NO_USAGE
  let rounds = 0
  let model: string | null = null
  const maxRounds = changes.request ? 1 : MAX_ROUNDS
  while (rounds < maxRounds) {
    const pairs = thinPairs(pairsForFix(current.check, MAX_FIX_PAIRS))
    const problems = changes.request
      ? []
      : [...current.check.problems]
    let result: Awaited<ReturnType<typeof verify>>
    try {
      result = await verify(client, pairs, facts, spec, current.html, changes, problems)
    } catch (error) {
      // A correction that fails must not throw away the build that is already paid for.
      if (changes.request) throw error
      console.error('A correction round failed; keeping the recreation as it is', error)
      break
    }
    rounds++
    usage = addUsage(usage, result.usage)
    const fixed = correctedHtml(current.html, result.output).trim()
    if (!fixed) break
    try {
      const check = await checkRecreation(fixed, size, frames, motion)
      const patched = await patchNumbers(fixed, check, size, frames, motion)
      if (changes.request || better(patched.check, current.check)) {
        current = patched
        model = result.model
      } else {
        // A correction that made nothing better is not followed by another: the differences left
        // are ones the model could not fix, or are not in the design at all.
        break
      }
    } catch (error) {
      console.error('Could not render the corrected recreation', error)
      if (changes.request) return done(fixed, null, rounds, result.model, usage)
    }
    if (!worthCorrecting(current.check)) break
  }
  // `model` stays null when no correction was kept: the recreation is still the builder's.
  return done(current.html, current.check, rounds, model, usage)
}

/** Corrections after the first build, at most; each is one model call. */
export const MAX_ROUNDS = 2

/** Keeps a request's images inside the API's size limit. */
function thinPairs(pairs: CheckResult['pairs']): CheckResult['pairs'] {
  const kept = thinToFit(
    pairs.map((pair) => pair.original.data.length + pair.recreation.data.length),
    MAX_PAIR_BYTES,
  )
  return kept.map((i) => pairs[i] as CheckResult['pairs'][number])
}

/**
 * Writes a new recreation; it replaces the old one and any edits made to it. `refinements` are
 * the user's Refine requests it includes, none after a fresh analysis.
 */
async function saveRecreation(root: string, name: string, html: string, refinements: Refinements): Promise<void> {
  const recreationDir = join(root, name, RECREATION_DIR)
  await mkdir(recreationDir, { recursive: true })
  // Saved self-contained: font placeholders become the fonts themselves.
  html = await embedFonts(html)
  await writeFileAtomic(join(recreationDir, RECREATION_BASE_FILE), html)
  await writeFileAtomic(join(recreationDir, RECREATION_FILE), html)
  await rm(join(recreationDir, EDITS_FILE), { force: true })
  if (refinements.requests.length > 0) {
    await writeFileAtomic(join(recreationDir, REFINEMENTS_FILE), `${JSON.stringify(refinements, null, 2)}\n`)
  } else {
    await rm(join(recreationDir, REFINEMENTS_FILE), { force: true })
  }
}

/** The Refine requests behind the current recreation; none if the file is missing or unreadable. */
async function readRefinements(recreationDir: string): Promise<Refinements> {
  const text = await readFile(join(recreationDir, REFINEMENTS_FILE), 'utf8').catch(() => null)
  if (text === null) return NO_REFINEMENTS
  try {
    return refinementsSchema.parse(JSON.parse(text))
  } catch (error) {
    console.error('Ignoring an unreadable refinements file', error)
    return NO_REFINEMENTS
  }
}

/** The frames sent to the model, named by timestamp, as docs/ASSET_FORMAT.md describes. */
export async function saveFrames(captureDir: string, frames: readonly Frame[]): Promise<void> {
  const framesDir = join(captureDir, FRAMES_DIR)
  await rm(framesDir, { recursive: true, force: true })
  await mkdir(framesDir, { recursive: true })
  for (const frame of frames) {
    const extension = frame.mediaType === 'image/png' ? 'png' : 'jpg'
    await writeFileAtomic(join(framesDir, `${frame.timestampMs}.${extension}`), frame.data)
  }
}

/** The frames saved by an earlier analysis, in time order. */
export async function loadFrames(framesDir: string): Promise<Frame[]> {
  const files = await readdir(framesDir).catch(() => [] as string[])
  const frames = await Promise.all(
    files
      .map((file) => /^(\d+)\.(jpg|png)$/.exec(file))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(async (match) => ({
        timestampMs: Number(match[1]),
        data: await readFile(join(framesDir, match[0])),
        mediaType: match[2] === 'png' ? ('image/png' as const) : ('image/jpeg' as const),
      })),
  )
  return frames.sort((a, b) => a.timestampMs - b.timestampMs)
}

/** How far the page scrolled through the clip, as prompt lines; '' if it did not scroll or cannot be read. */
async function scrollOfClip(clipPath: string, cssHeight: number): Promise<string> {
  try {
    const frames = splitFrames(await runFfmpegCapture(motionMeasureArgs(clipPath, MOTION_FPS, MOTION_SIZE)), MOTION_SIZE * MOTION_SIZE)
    return describeScroll(scrollTimeline(frames, MOTION_SIZE, MOTION_FPS, 'y'), cssHeight / MOTION_SIZE)
  } catch (error) {
    console.error('Could not measure the scroll', error)
    return ''
  }
}

/** Times and easing measured from every frame of the clip. Never fails an analysis. */
export async function measureClip(clipPath: string, backdrop: Backdrop | null = null): Promise<Motion | null> {
  return (await measureClipChoices(clipPath, backdrop ? [backdrop] : []))?.[backdrop ?? 'raw'] ?? null
}

/**
 * The clip's motion measured as it is (`raw`) and with page content scrolling behind the thing
 * left out, along each of `axes`. One decode; the plan says which applies.
 */
export async function measureClipChoices(clipPath: string, axes: readonly Backdrop[] = ['x', 'y']): Promise<({ raw: Motion } & Partial<Record<Backdrop, Motion>>) | null> {
  try {
    const frames = splitFrames(await runFfmpegCapture(motionMeasureArgs(clipPath, MOTION_FPS, MOTION_SIZE)), MOTION_SIZE * MOTION_SIZE)
    const choices: { raw: Motion } & Partial<Record<Backdrop, Motion>> = { raw: measureMotion(frames, MOTION_SIZE, MOTION_FPS) }
    for (const axis of axes) choices[axis] = measureMotion(frames, MOTION_SIZE, MOTION_FPS, undefined, axis)
    return choices
  } catch (error) {
    console.error('Could not measure the motion; analyzing without it', error)
    return null
  }
}

/** The plan's answer about the page behind, as an axis. */
function backdropOf(answer: string): Backdrop | null {
  const word = answer.trim().toLowerCase()
  return word.startsWith('vert') ? 'y' : word.startsWith('horiz') ? 'x' : null
}

/** The motion with scrolling left out, as prompt lines, for each axis where that changes the timeline. */
function scrollChoices(choices: { raw: Motion } & Partial<Record<Backdrop, Motion>>, capture: AssetCapture): string {
  const lines: string[] = []
  for (const [axis, word] of [['y', 'vertical'], ['x', 'horizontal']] as const) {
    const motion = choices[axis]
    if (!motion || sameTimeline(choices.raw, motion)) continue
    lines.push(
      `If page content scrolls behind the thing (${word}), the measurement above includes that scrolling. Measured again with ${word} scrolling left out (answer backdrop "${word}" to use this one):`,
      describeMotion(motion, capture.width, capture.height).split('\n').slice(1).join('\n') || '- Nothing else moves.',
    )
  }
  return lines.join('\n')
}

/** Frames are traced at this many pixels per CSS pixel, up to TRACE_EDGE on the long side. */
const TRACE_SCALE = 3
const TRACE_EDGE = 1400
/** Points across all traced frames; past this the outlines would crowd out everything else. */
const TRACE_POINTS = 2500
/** Resting states traced, and in-between shapes per movement. */
const TRACE_RESTING = 3
const TRACE_PER_MOVE = 2

/**
 * Traces the real outlines of the frames that matter: a few resting states, and a few in-between
 * shapes of each movement, so the builder gets exact geometry (see shared/trace.ts).
 */
export function traceFrames(frames: readonly Frame[], motion: Motion | null, capture: { width: number; height: number }): TracedFrame[] {
  const resting = [...restingFrames(frames, motion)]
  const spread = (indices: number[], count: number) =>
    indices.length <= count ? indices : Array.from({ length: count }, (_, k) => indices[Math.round((k * (indices.length - 1)) / (count - 1))] as number)
  const chosen = new Map<number, 'rest' | 'moving'>()
  for (const i of spread(resting, TRACE_RESTING)) chosen.set(i, 'rest')
  for (const segment of motion?.segments ?? []) {
    const inside = frames.map((frame, i) => ({ i, at: frame.timestampMs })).filter(({ at }) => at > segment.startMs && at < segment.endMs).map(({ i }) => i)
    for (const i of spread(inside, TRACE_PER_MOVE)) chosen.set(i, 'moving')
  }
  const scale = Math.min(TRACE_SCALE, TRACE_EDGE / Math.max(capture.width, capture.height))
  const width = Math.max(1, Math.round(capture.width * scale))
  const height = Math.max(1, Math.round(capture.height * scale))
  const traced: TracedFrame[] = []
  let points = 0
  // Resting states first, so the point budget never runs out before the shapes that matter most.
  for (const [i, state] of [...chosen].sort((a, b) => (a[1] === b[1] ? a[0] - b[0] : a[1] === 'rest' ? -1 : 1))) {
    try {
      const frame = frames[i] as Frame
      const image = nativeImage.createFromBuffer(Buffer.from(frame.data)).resize({ width, height, quality: 'best' })
      // Output in CSS px: the image has `width / capture.width` pixels per CSS px.
      const layers = traceFrame(image.toBitmap(), width, height, { scale: width / capture.width, order: 'bgra' })
      const used = layers.reduce((sum, layer) => sum + layer.points, 0)
      if (layers.length === 0 || points + used > TRACE_POINTS) continue
      points += used
      traced.push({ timestampMs: frame.timestampMs, state, layers })
    } catch (error) {
      console.error('Could not trace a frame; analyzing without it', error)
    }
  }
  return traced.sort((a, b) => a.timestampMs - b.timestampMs)
}

/** Boxes measured from the poster's pixels, as prompt lines; '' if it cannot be read or says nothing. */
function layoutOfImage(posterPath: string, cssWidth: number, cssHeight: number): string {
  try {
    const image = nativeImage.createFromPath(posterPath)
    if (image.isEmpty()) return ''
    const { gray, pxPerCss } = cssGray(image, cssWidth, cssHeight)
    return describeLayout(measureLayout(gray), pxPerCss)
  } catch (error) {
    console.error('Could not measure the layout; analyzing without it', error)
    return ''
  }
}

/** Exact style values saved by the Chrome extension, if this capture came through it. */
async function readPageStyles(captureDir: string): Promise<PageStyles | null> {
  const text = await readFile(join(captureDir, PAGE_STYLES_FILE), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const parsed = pageStylesSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The motion measured by an earlier analysis, if it is there and readable. */
export async function readMotion(captureDir: string): Promise<Motion | null> {
  const text = await readFile(join(captureDir, MOTION_FILE), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    return motionSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}

/** The part of the capture the last analysis was cut to, if it was (`capture/focus.json`). */
export async function readFocus(captureDir: string): Promise<Focus | null> {
  const text = await readFile(join(captureDir, FOCUS_FILE), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    return focusSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}

/** A screenshot as the model sees it: scaled like the frames of a recording. */
async function stillFrame(posterPath: string, capture: { width: number; height: number }): Promise<Frame> {
  const temp = await mkdtemp(join(tmpdir(), 'gil-still-'))
  try {
    const output = join(temp, 'still.png')
    await runFfmpeg(stillFrameArgs(posterPath, output, frameEdge(capture.width, capture.height)))
    return { timestampMs: 0, data: await readFile(output), mediaType: 'image/png' }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

/**
 * Samples the clip and extracts the frames worth sending: from the measured movements when there
 * is a measurement, otherwise from whole-frame change.
 */
export async function pickFrames(
  clipPath: string,
  /** The capture's CSS size, which sets how large the frames are. */
  capture: { width: number; height: number },
  motion: Motion | null,
): Promise<{ frames: Frame[]; isStill: boolean }> {
  const edge = frameEdge(capture.width, capture.height)
  const thumbs = splitFrames(await runFfmpegCapture(motionThumbnailArgs(clipPath)), THUMB_SIZE * THUMB_SIZE)
  const diffs = motion ? differencesFromMotion(motion, thumbs.length, ANALYSIS_FPS) : frameDifferences(thumbs)
  // With measured motion, frames go where the most changes; otherwise evenly through the motion.
  const byProgress = motion ? framesForMotion(motion, thumbs.length, ANALYSIS_FPS, DEFAULT_SELECTION.budget) : null
  const selection = byProgress ? { isStill: false, indices: byProgress } : selectFrames(thumbs.length, diffs)
  if (selection.indices.length === 0) return { frames: [], isStill: true }

  const temp = await mkdtemp(join(tmpdir(), 'gil-frames-'))
  try {
    await runFfmpeg(selectedFramesArgs(clipPath, selection.indices, join(temp, 'frame-%03d.jpg'), edge))
    const files = (await readdir(temp)).filter((file) => file.endsWith('.jpg')).sort()
    const frames: Frame[] = await Promise.all(
      files.map(async (file, i) => ({
        timestampMs: Math.round(((selection.indices[i] ?? 0) * 1000) / ANALYSIS_FPS),
        data: await readFile(join(temp, file)),
        mediaType: 'image/jpeg' as const,
      })),
    )
    // Stay well inside the API's request size limit (base64 adds a third).
    const kept = thinToFit(
      frames.map((frame) => frame.data.length),
      MAX_FRAME_BYTES,
    )
    return { frames: kept.map((i) => frames[i] as Frame), isStill: selection.isStill }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
