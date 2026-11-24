import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import {
  describeOutputSchema,
  identifyOutputSchema,
  recreateOutputSchema,
  verifyOutputSchema,
  type DescribeOutput,
  type IdentifyOutput,
  type Spec,
  type VerifyOutput,
} from '../../shared/spec'
import type { AssetLens } from '../../shared/asset'
import type { Recipe } from '../../shared/recipe'
import { addUsage, NO_USAGE, usageOf, type Usage } from '../../shared/cost'
import { changesNote } from '../../shared/refinements'
import describePrompt from './prompts/describe.md?raw'
import recreatePrompt from './prompts/recreate.md?raw'
import refinePrompt from './prompts/refine.md?raw'
import verifyPrompt from './prompts/verify.md?raw'
import identifyPrompt from './prompts/identify.md?raw'

/**
 * The model analysis uses. One model plans, builds and corrects (decided 2026-11-23, after a
 * cheaper planner and a cheaper fixer gave less accurate recreations): describing a capture and
 * redrawing what differs both depend on seeing well, which is what this model is best at. Cost
 * is kept down by measuring first and by stopping as soon as the local check passes.
 */
export const ANALYSIS_MODEL = 'claude-opus-5-5'
/**
 * If the model declines for policy reasons (a false positive on an ordinary UI capture), the API
 * retries on its default fallback model inside the same call.
 */
const BETAS: Anthropic.Beta.AnthropicBeta[] = ['server-side-fallback-2026-07-01']
const MAX_TOKENS = 64_000

export interface Frame {
  timestampMs: number
  data: Uint8Array
  mediaType: 'image/png' | 'image/jpeg'
}

export interface CaptureFacts {
  width: number
  height: number
  /** Frame pixels per CSS pixel, as the frames are shown to the model. */
  frameScale: number
  isStill: boolean
  mode: 'recording' | 'screenshot'
  durationMs: number
  userContext: string | null
  /** Motion measured from every frame (see shared/motion.ts), as prompt lines; '' if none. */
  measuredMotion: string
  /** Colours measured from the capture's pixels (see shared/palette.ts), as prompt lines; '' if none. */
  measuredColors: string
  /** What the user asked gil to look for. */
  lens: AssetLens
  /** Exact values from a web page's CSS (Chrome extension), as prompt lines; '' if none. */
  pageStyles: string
  /** Boxes measured from the pixels (shared/layoutMeasure.ts), as prompt lines; '' if none. */
  measuredLayout: string
  /** Outlines traced from the frames (shared/trace.ts), as prompt lines; '' if none. */
  tracedShapes: string
  /** Texts matched to real fonts and how to set them (shared/fontEmbed.ts), as prompt lines; '' or missing if none. */
  realFonts?: string
}

/** What each lens asks the model to concentrate on. */
const LENS_NOTES: Record<AssetLens, string> = {
  auto: '',
  motion: 'The user chose the Motion lens: this asset is about how things move. Put the most care into the motion entries: every animated element, its timing, easing, order and stagger.',
  component: 'The user chose the Component lens: this asset is one element or widget. Describe and recreate that element precisely, with all its tokens and states, and treat everything around it as backdrop.',
  layout: 'The user chose the Layout lens: this asset is about structure, not content. Put the most care into the layout regions (boxes, nesting, direction, gaps, alignment). The recreation is a skeleton of that structure with neutral placeholder blocks and text, not a copy of the content.',
  type: 'The user chose the Type lens: this asset is the text system. Give one typography entry for every distinct text level you can see, largest first, with size, line height, weight, letter spacing and the font it looks like, and name the text and background colours. gil builds the type specimen from these values itself.',
  color: 'The user chose the Colour lens: this asset is the palette. Give every distinct colour with its role.',
  font: 'The user chose the Font lens: this asset is about the typeface of the text.',
  spacing: 'The user chose the Spacing lens: this asset is about the spacing and grid. gil measures them itself.',
  effects:
    'The user chose the Effects lens: this asset is about a look, a material or a surface treatment: blur and frosted glass, shadows and elevation, gradients, grain and noise, glows, borders and highlights, transparency, blend modes. Put the most care into the effects entries: give each effect exact CSS values (backdrop-filter, box-shadow layers with their offsets, blur, spread and colours, gradient stops and angles, opacity, mix-blend-mode), how strong it is, what it sits on and what shows through. The recreation must reproduce the look on a neutral placeholder shape, over a backdrop like the original one so the effect can be seen. In the recipe, say what the effect needs from what is behind it to work, and keep the effect apart from the picture it was captured in: the effect (blur, tint, rim, shadow, sheen, with their numbers) goes under how it is built and what to keep; the panel\'s shape, tilt and size, the backdrop and the colours belong to that one picture and go under adapting, with how the tint and shadow follow a different backdrop colour, and how to keep text, inputs and buttons readable on the effect when it has to hold UI.',
  icons:
    'The user chose the Icons lens: this asset is an icon set or illustration style. What matters is the rules that would let someone draw a new icon that belongs to the set: the grid size and the live area inside it, stroke weight, stroke ends and joins (round, square), corner radius, how curves are drawn, filled or outlined or both, how detail is reduced, optical size, and the colours. Measure them from the traced outlines. The recreation shows the captured icons drawn as clean SVG on that grid. In the recipe, state each rule with its number, and how to draw a new icon to it.',
  transition:
    'The user chose the Transition lens: this is a page or view transition, from one screen to another. Describe what leaves, what stays and moves (shared elements that travel between the two), what enters, and in what order, with the measured timings. The recreation plays the transition between two placeholder screens built from the captured ones, and the recipe says how to apply it between any two views (which parts are shared, which are the old and new screens).',
  scroll:
    'The user chose the Scroll lens: this is scroll choreography, things that move as the page scrolls (pinning, parallax, reveals, progress). Describe each effect in terms of scroll progress, not time: what happens between which points of the scroll, and how fast relative to it. The recreation replays it on a timeline, and the recipe gives each effect as a range of scroll progress so it can be built with scroll-driven animations.',
}

export type { Usage }

export interface CallResult<T> {
  output: T
  /** The model that answered; differs from ANALYSIS_MODEL if a fallback ran. */
  model: string
  usage: Usage
}

export function createClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey })
}

/** Checks a key by looking up the analysis model, which needs no tokens. */
export async function checkApiKey(apiKey: string): Promise<void> {
  await createClient(apiKey).models.retrieve(ANALYSIS_MODEL)
}

function frameBlocks(frames: readonly Frame[]): Anthropic.Beta.BetaContentBlockParam[] {
  return frames.flatMap((frame, index): Anthropic.Beta.BetaContentBlockParam[] => [
    { type: 'text', text: `Frame ${index + 1} at ${frame.timestampMs} ms` },
    {
      type: 'image',
      source: { type: 'base64', media_type: frame.mediaType, data: Buffer.from(frame.data).toString('base64') },
    },
  ])
}

function describeFacts(facts: CaptureFacts): string {
  const lines = [
    facts.mode === 'screenshot'
      ? 'This is a screenshot: a single still image.'
      : facts.isStill
        ? `This is a ${facts.durationMs} ms recording in which nothing moved, so one frame is shown.`
        : `This is a ${facts.durationMs} ms recording; frames were sampled where things change.`,
    `The captured region is ${facts.width} × ${facts.height} CSS pixels. The frames are shown at ${facts.frameScale.toFixed(2)}× that size, so divide what you measure in a frame by ${facts.frameScale.toFixed(2)} to get CSS pixels.`,
  ]
  if (facts.measuredMotion) lines.push(facts.measuredMotion)
  if (facts.measuredColors) lines.push(facts.measuredColors)
  if (facts.pageStyles) lines.push(facts.pageStyles)
  if (facts.measuredLayout) lines.push(facts.measuredLayout)
  if (facts.realFonts) lines.push(facts.realFonts)
  if (facts.tracedShapes) lines.push(facts.tracedShapes)
  if (LENS_NOTES[facts.lens]) lines.push(LENS_NOTES[facts.lens])
  if (facts.userContext) lines.push(`What the user said to look for: ${facts.userContext}`)
  return lines.join('\n')
}

/**
 * One call with a checked answer, retried once if the answer cannot be used.
 */
async function call<T>(
  client: Anthropic,
  system: string,
  content: Anthropic.Beta.BetaContentBlockParam[],
  schema: z.ZodType<T>,
  /**
   * `json`: the answer is asked for as JSON in the prompt and checked here, without the API's
   * schema-constrained output. For the plan, whose schema is too large for the API's grammar.
   */
  mode: 'structured' | 'json' = 'structured',
): Promise<CallResult<T>> {
  const shape =
    mode === 'json'
      ? `\n\nAnswer with one JSON object and nothing else: no prose, no code fence. It must match this JSON Schema exactly, with every property present:\n${JSON.stringify(z.toJSONSchema(schema))}`
      : ''
  let lastProblem = ''
  let usage: Usage = NO_USAGE
  // One retry if the answer does not validate, as the architecture asks.
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryNote: Anthropic.Beta.BetaContentBlockParam[] = lastProblem
      ? [{ type: 'text', text: `Your previous answer was rejected: ${lastProblem}. Answer again.` }]
      : []
    const stream = client.beta.messages.stream({
      model: ANALYSIS_MODEL,
      max_tokens: MAX_TOKENS,
      betas: BETAS,
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: mode === 'json' ? { effort: 'high' } : { effort: 'high', format: betaZodOutputFormat(schema) },
      system: `${system}${shape}`,
      messages: [{ role: 'user', content: [...content, ...retryNote] }],
    })
    const message = await stream.finalMessage()
    usage = addUsage(
      usage,
      usageOf(message.model, {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      }),
    )
    if (message.stop_reason === 'refusal') {
      throw new Error('Claude declined to analyze this capture')
    }
    if (message.stop_reason === 'max_tokens') {
      lastProblem = 'it was cut off because it was too long'
      continue
    }
    if (mode === 'structured') {
      if (message.parsed_output) return { output: message.parsed_output, model: message.model, usage }
      lastProblem = 'it did not match the required format'
      continue
    }
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    const parsed = parseJsonAnswer(text, schema)
    if (parsed.ok) return { output: parsed.value, model: message.model, usage }
    lastProblem = parsed.problem
  }
  throw new Error(`Claude's answer could not be used: ${lastProblem}`)
}

/** Reads a JSON answer, with or without a code fence around it, and checks it against the schema. */
export function parseJsonAnswer<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; problem: string } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, problem: 'it was not a JSON object' }
  let json: unknown
  try {
    json = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { ok: false, problem: 'it was not valid JSON' }
  }
  const result = schema.safeParse(json)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  return { ok: false, problem: `it did not match the format (${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'})` }
}

export function describe(
  client: Anthropic,
  frames: readonly Frame[],
  facts: CaptureFacts,
): Promise<CallResult<DescribeOutput>> {
  return call(client, describePrompt, [...frameBlocks(frames), { type: 'text', text: describeFacts(facts) }], describeOutputSchema, 'json')
}

/** Reads the text in a capture and names its typeface and free look-alikes (prompts/identify.md). */
export function identify(client: Anthropic, frame: Frame): Promise<CallResult<IdentifyOutput>> {
  return call(client, identifyPrompt, frameBlocks([frame]), identifyOutputSchema)
}

export function recreate(
  client: Anthropic,
  frames: readonly Frame[],
  facts: CaptureFacts,
  spec: Spec,
): Promise<CallResult<{ html: string; recipe: Recipe }>> {
  return call(
    client,
    recreatePrompt,
    [
      ...frameBlocks(frames),
      {
        type: 'text',
        text: `${describeFacts(facts)}\n\nSpec:\n${JSON.stringify(spec, null, 2)}`,
      },
    ],
    recreateOutputSchema,
  )
}

/** The user's Refine requests as one verify round sees them. */
export interface UserChanges {
  /** Asked for earlier and already in the recreation: keep them. */
  applied: readonly string[]
  /** To apply in this round, if any. */
  request: string | null
}

export const NO_CHANGES: UserChanges = { applied: [], request: null }

/**
 * One correction: the original frames, then the recreation rendered at the same moments, the
 * differences gil measured, and a corrected recreation back. With a request from the user this
 * is how Refine works, under its own prompt where the request wins over the original.
 *
 * Nothing is cached: a round's pairs differ from the last one's, so a cache entry would cost its
 * write premium and rarely be read.
 */
export function verify(
  client: Anthropic,
  pairs: readonly { original: Frame; recreation: Frame }[],
  facts: CaptureFacts,
  spec: Spec,
  html: string,
  changes: UserChanges,
  measured: readonly string[] = [],
): Promise<CallResult<VerifyOutput>> {
  const originals = pairs.flatMap(({ original }): Anthropic.Beta.BetaContentBlockParam[] => [
    { type: 'text', text: `Original at ${original.timestampMs} ms` },
    ...frameBlocks([original]).slice(1),
  ])
  const recreations = pairs.flatMap(({ recreation }): Anthropic.Beta.BetaContentBlockParam[] => [
    { type: 'text', text: `Recreation at ${recreation.timestampMs} ms` },
    ...frameBlocks([recreation]).slice(1),
  ])
  const note = changesNote(changes.applied, changes.request)
  const found = measured.length
    ? `\n\nDifferences gil measured between the capture and this recreation (trust these; fix each one):\n${measured.map((line) => `- ${line}`).join('\n')}`
    : ''
  return call(
    client,
    changes.request ? refinePrompt : verifyPrompt,
    [
      ...originals,
      ...recreations,
      {
        type: 'text',
        text: `${describeFacts(facts)}\n\nSpec:\n${JSON.stringify(spec, null, 2)}\n\nCurrent recreation:\n${html}${found}${note ? `\n\n${note}` : ''}`,
      },
    ],
    verifyOutputSchema,
  )
}
