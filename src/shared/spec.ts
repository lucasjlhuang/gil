import { z } from 'zod'
import { recipeSchema } from './recipe'

/**
 * `spec.json` (docs/ASSET_FORMAT.md) and what the describe step asks Claude for. The model's
 * answer is constrained to `describeOutputSchema` and validated again here; `spec.md` is
 * generated from the spec, never written by hand.
 */

export const SPEC_SCHEMA_VERSION = 2

const confidenceSchema = z.enum(['measured', 'estimated'])
export type Confidence = z.infer<typeof confidenceSchema>

export const motionSchema = z.object({
  target: z.string(),
  trigger: z.string(),
  properties: z.array(z.string()),
  durationMs: z.number(),
  delayMs: z.number(),
  easing: z.string(),
  confidence: z.object({
    durationMs: confidenceSchema,
    delayMs: confidenceSchema,
    easing: confidenceSchema,
  }),
  notes: z.string(),
})

/** A number with how it was found. */
const valueSchema = z.object({ value: z.number(), confidence: confidenceSchema })

const typeStyleSchema = z.object({
  /** Its place in the hierarchy, such as heading-1, heading-2, body, caption, label. */
  level: z.string(),
  /** What it is used for here, such as "card title". */
  role: z.string(),
  /** A generic description, such as "geometric sans". */
  family: z.string(),
  /** The font it looks like, if recognisable, such as "Inter"; null if not. */
  fontName: z.string().nullable(),
  /** CSS px. */
  size: z.number(),
  /** CSS px; null for a single line where it cannot be seen. */
  lineHeight: z.number().nullable(),
  weight: z.number(),
  /** CSS px. */
  letterSpacing: z.number(),
  confidence: z.object({
    family: confidenceSchema,
    size: confidenceSchema,
    lineHeight: confidenceSchema,
    weight: confidenceSchema,
    letterSpacing: confidenceSchema,
  }),
})

const tokensSchema = z.object({
  colors: z.array(z.object({ name: z.string(), value: z.string(), role: z.string(), confidence: confidenceSchema })),
  typography: z.array(typeStyleSchema),
  radii: z.array(valueSchema),
  spacing: z.array(valueSchema),
  shadows: z.array(z.object({ value: z.string(), confidence: confidenceSchema })),
  effects: z.array(z.object({ type: z.string(), value: z.string(), confidence: confidenceSchema })),
})

/** One region of the layout, as a box in CSS px from the capture's top left. */
const regionSchema = z.object({
  name: z.string(),
  /** Such as header, sidebar, card, list, button, media. */
  role: z.string(),
  /** The name of the region it sits in; null at the top level. */
  parent: z.string().nullable(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  /** How its children are arranged. */
  direction: z.enum(['row', 'column', 'grid', 'stack', 'none']),
  /** CSS px between children; null if it has none or it cannot be seen. */
  gap: z.number().nullable(),
  /** Such as "start", "center", "space-between". */
  align: z.string(),
  confidence: confidenceSchema,
})

const layoutSchema = z.object({
  /** A sentence or two on the structure. */
  description: z.string(),
  regions: z.array(regionSchema),
})

/** The spec body, shared by the model output and spec.json. */
const specBody = {
  description: z.string(),
  tokens: tokensSchema,
  layout: layoutSchema,
  motion: z.array(motionSchema),
  states: z.array(z.string()),
  caveats: z.array(z.string()),
}

export const specSchema = z.looseObject({
  schemaVersion: z.literal(SPEC_SCHEMA_VERSION),
  ...specBody,
})

export type Spec = z.infer<typeof specSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/**
 * Upgrades a parsed spec.json to the current version, keeping fields it does not know.
 *
 * - 1 -> 2: every token value gains a confidence ("estimated", which is what version 1 values
 *   were); typography gains level (from its role), fontName (null) and lineHeight (null);
 *   radii, spacing and shadows become objects; layout becomes a description with no regions.
 */
export function migrateSpec(json: unknown): unknown {
  if (!isRecord(json) || json['schemaVersion'] !== 1) return json
  const tokens = isRecord(json['tokens']) ? json['tokens'] : {}
  const est = 'estimated'
  const value = (v: unknown) => ({ value: v, confidence: est })
  return {
    ...json,
    schemaVersion: 2,
    tokens: {
      ...tokens,
      colors: array(tokens['colors']).map((c) => ({ ...(isRecord(c) ? c : {}), confidence: est })),
      typography: array(tokens['typography']).map((t) => {
        const type = isRecord(t) ? t : {}
        return {
          ...type,
          level: typeof type['role'] === 'string' ? type['role'] : 'text',
          fontName: null,
          lineHeight: null,
          confidence: { family: est, size: est, lineHeight: est, weight: est, letterSpacing: est },
        }
      }),
      radii: array(tokens['radii']).map(value),
      spacing: array(tokens['spacing']).map(value),
      shadows: array(tokens['shadows']).map(value),
      effects: array(tokens['effects']).map((e) => ({ ...(isRecord(e) ? e : {}), confidence: est })),
    },
    layout: { description: typeof json['layout'] === 'string' ? json['layout'] : '', regions: [] },
  }
}

/** Reads spec.json text of any version; throws if it is not a valid spec. */
export function parseSpec(text: string): Spec {
  return specSchema.parse(migrateSpec(JSON.parse(text)))
}

/**
 * What the planning step returns: the spec plus what goes into asset.json, in a flatter shape
 * than spec.json. The API compiles the schema into a grammar and refuses large ones, and every
 * enum and nullable field multiplies it; so here "measured" is a boolean, missing values are
 * sentinels (an empty string, 0 or -1), and the few fixed word lists are plain strings.
 * `specFromDescription` turns it into the real spec.
 */
export const describeOutputSchema = z.object({
  description: z.string(),
  colors: z.array(z.object({ name: z.string(), value: z.string(), role: z.string(), measured: z.boolean() })),
  typography: z.array(
    z.object({
      level: z.string(),
      role: z.string(),
      family: z.string(),
      /** '' when the font is not recognisable. */
      fontName: z.string(),
      size: z.number(),
      /** 0 when it cannot be seen. */
      lineHeight: z.number(),
      weight: z.number(),
      letterSpacing: z.number(),
      /** True when these values come from measurements given to the model. */
      measured: z.boolean(),
    }),
  ),
  radii: z.array(z.object({ value: z.number(), measured: z.boolean() })),
  spacing: z.array(z.object({ value: z.number(), measured: z.boolean() })),
  shadows: z.array(z.object({ value: z.string(), measured: z.boolean() })),
  effects: z.array(z.object({ type: z.string(), value: z.string(), measured: z.boolean() })),
  layout: z.string(),
  regions: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      /** '' at the top level. */
      parent: z.string(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      /** row, column, grid, stack or none. */
      direction: z.string(),
      /** -1 when there is none or it cannot be seen. */
      gap: z.number(),
      align: z.string(),
      measured: z.boolean(),
    }),
  ),
  motion: z.array(
    z.object({
      target: z.string(),
      trigger: z.string(),
      properties: z.array(z.string()),
      durationMs: z.number(),
      delayMs: z.number(),
      easing: z.string(),
      /** True when the duration and delay come from measured motion or the page. */
      timingMeasured: z.boolean(),
      easingMeasured: z.boolean(),
      notes: z.string(),
    }),
  ),
  states: z.array(z.string()),
  caveats: z.array(z.string()),
  /** Suggested asset name; slugified and made unique before use. */
  name: z.string(),
  title: z.string(),
  /** motion, component, layout, type-system, color-system or other. */
  kind: z.string(),
  /**
   * Lines of text that stay text throughout, in the resting state, for gil to match a real font
   * to: the exact text, its tight box in CSS px, and free Google Fonts families that look like it.
   */
  texts: z
    .array(
      z.object({
        text: z.string(),
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
        weight: z.number(),
        italic: z.boolean(),
        /** The typeface it looks like, by its usual name; '' if unknown. */
        fontName: z.string(),
        candidates: z.array(z.string()),
      }),
    )
    .default([]),
  /**
   * When the user's note asks for only part of what was captured: the span of the clip (ms) that
   * part occupies, and the box it occupies in the picture, as fractions (0–1) of the region from
   * its top left. 0 and the clip's length, and 0, 0, 1, 1, when the whole capture is wanted.
   */
  focusFromMs: z.number().default(0),
  focusToMs: z.number().default(0),
  focusX: z.number().default(0),
  focusY: z.number().default(0),
  focusWidth: z.number().default(1),
  focusHeight: z.number().default(1),
  /**
   * Whether page content scrolls behind the thing in the frames: vertical, horizontal or none.
   * gil then leaves that scrolling out of the measured motion (shared/motion.ts).
   */
  backdrop: z.string().default('none'),
  summary: z.string(),
  tags: z.array(z.string()),
})

export type DescribeOutput = z.infer<typeof describeOutputSchema>

export const verifyOutputSchema = z.object({
  matches: z.boolean(),
  differences: z.array(z.string()),
  /**
   * The correction as edits to the current HTML: each `find` is an exact, unique piece of it,
   * replaced by `replace`. Much shorter to write than the whole document, which is what a
   * correction costs most. Empty when `html` is used.
   */
  edits: z.array(z.object({ find: z.string(), replace: z.string() })),
  /** The whole corrected document, only when the change is too broad for edits; otherwise ''. */
  html: z.string(),
})

/**
 * Applies a correction's edits to the HTML. Null if an edit's `find` is missing or not unique:
 * a correction that cannot be applied exactly is not applied at all.
 */
export function applyCorrection(html: string, edits: readonly { find: string; replace: string }[]): string | null {
  let out = html
  for (const { find, replace } of edits) {
    if (!find) return null
    const at = out.indexOf(find)
    if (at < 0 || out.indexOf(find, at + 1) >= 0) return null
    out = out.slice(0, at) + replace + out.slice(at + find.length)
  }
  return out
}

/** The corrected HTML a verify answer stands for: its full document, else its edits applied; '' if neither works. */
export function correctedHtml(current: string, output: { edits: readonly { find: string; replace: string }[]; html: string }): string {
  if (output.html.trim()) return output.html
  if (output.edits.length === 0) return ''
  return applyCorrection(current, output.edits) ?? ''
}

export type VerifyOutput = z.infer<typeof verifyOutputSchema>

/** What font identification asks the model for (prompts/identify.md). */
export const identifyOutputSchema = z.object({
  text: z.string(),
  /** Where that text is, as fractions (0–1) of the image, so other text is left out. */
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  modelGuess: z.string().nullable(),
  category: z.enum(['sans-serif', 'serif', 'display', 'handwriting', 'monospace']),
  weight: z.number(),
  italic: z.boolean(),
  traits: z.array(z.string()),
  candidates: z.array(z.string()),
})
export type IdentifyOutput = z.infer<typeof identifyOutputSchema>

export const recreateOutputSchema = z.object({
  /** One self-contained HTML document. */
  html: z.string(),
  /** How it is built, for applying it to other content (shared/recipe.ts). */
  recipe: recipeSchema,
})

const PLAN_KINDS = ['motion', 'component', 'layout', 'type-system', 'color-system', 'other'] as const
export type PlanKind = (typeof PLAN_KINDS)[number]

/** The kind the plan chose, or `other` for a word outside the list. */
export function planKind(output: DescribeOutput): PlanKind {
  const kind = output.kind.trim().toLowerCase()
  return (PLAN_KINDS as readonly string[]).includes(kind) ? (kind as PlanKind) : 'other'
}

const DIRECTIONS = ['row', 'column', 'grid', 'stack', 'none'] as const

export function specFromDescription(output: DescribeOutput, isStill: boolean): Spec {
  const mark = (measured: boolean): Confidence => (measured ? 'measured' : 'estimated')
  return specSchema.parse({
    schemaVersion: SPEC_SCHEMA_VERSION,
    description: output.description,
    tokens: {
      colors: output.colors.map(({ measured, ...color }) => ({ ...color, confidence: mark(measured) })),
      typography: output.typography.map(({ measured, ...type }) => {
        const level = mark(measured)
        return {
          ...type,
          fontName: type.fontName.trim() || null,
          lineHeight: type.lineHeight > 0 ? type.lineHeight : null,
          confidence: { family: level, size: level, lineHeight: level, weight: level, letterSpacing: level },
        }
      }),
      radii: output.radii.map(({ measured, value }) => ({ value, confidence: mark(measured) })),
      spacing: output.spacing.map(({ measured, value }) => ({ value, confidence: mark(measured) })),
      shadows: output.shadows.map(({ measured, value }) => ({ value, confidence: mark(measured) })),
      effects: output.effects.map(({ measured, ...effect }) => ({ ...effect, confidence: mark(measured) })),
    },
    layout: {
      description: output.layout,
      regions: output.regions.map(({ measured, ...region }) => {
        const direction = region.direction.trim().toLowerCase()
        return {
          ...region,
          parent: region.parent.trim() || null,
          direction: (DIRECTIONS as readonly string[]).includes(direction) ? direction : 'none',
          gap: region.gap >= 0 ? region.gap : null,
          confidence: mark(measured),
        }
      }),
    },
    // A still has no motion, whatever the model said.
    motion: isStill
      ? []
      : output.motion.map(({ timingMeasured, easingMeasured, ...motion }) => ({
          ...motion,
          confidence: { durationMs: mark(timingMeasured), delayMs: mark(timingMeasured), easing: mark(easingMeasured) },
        })),
    states: output.states,
    caveats: output.caveats,
  })
}

function list(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- None'
}

function mark(level: Confidence): string {
  return level === 'estimated' ? ' (estimated)' : ' (measured)'
}

const px = (value: { value: number; confidence: Confidence }) => `${value.value}px${mark(value.confidence)}`

/** spec.md: the same spec, readable. This is what AI tools are given. */
export function specToMarkdown(spec: Spec, heading: { title: string; name: string }): string {
  const { tokens } = spec
  const sections = [
    `# ${heading.title}`,
    `Asset name: \`${heading.name}\``,
    spec.description,
    'Every value says whether gil measured it from the capture or the AI estimated it from the frames.',
    '## Colors',
    list(tokens.colors.map((color) => `\`${color.name}\`: ${color.value} (${color.role})${mark(color.confidence)}`)),
    '## Typography',
    list(
      tokens.typography.map((type) => {
        const c = type.confidence
        return [
          `${type.level} (${type.role}): ${type.fontName ? `${type.fontName}, ` : ''}${type.family}${mark(c.family)}`,
          `size ${type.size}px${mark(c.size)}`,
          type.lineHeight === null ? null : `line height ${type.lineHeight}px${mark(c.lineHeight)}`,
          `weight ${type.weight}${mark(c.weight)}`,
          `letter-spacing ${type.letterSpacing}px${mark(c.letterSpacing)}`,
        ]
          .filter(Boolean)
          .join(', ')
      }),
    ),
    '## Shape and spacing',
    list([
      `Radii: ${tokens.radii.length ? tokens.radii.map(px).join(', ') : 'none'}`,
      `Spacing: ${tokens.spacing.length ? tokens.spacing.map(px).join(', ') : 'none'}`,
      ...tokens.shadows.map((shadow) => `Shadow: ${shadow.value}${mark(shadow.confidence)}`),
      ...tokens.effects.map((effect) => `Effect: ${effect.type} ${effect.value}${mark(effect.confidence)}`),
    ]),
    '## Layout',
    spec.layout.description,
  ]
  if (spec.layout.regions.length > 0) {
    sections.push(
      list(
        spec.layout.regions.map(
          (region) =>
            `${region.name} (${region.role}${region.parent ? `, inside ${region.parent}` : ''}): ${region.width}×${region.height}px at ${region.x}, ${region.y}; children ${region.direction}${region.gap === null ? '' : `, gap ${region.gap}px`}, aligned ${region.align}${mark(region.confidence)}`,
        ),
      ),
    )
  }
  if (spec.motion.length > 0) {
    sections.push(
      '## Motion',
      spec.motion
        .map((motion) =>
          [
            `### ${motion.target}`,
            list([
              `Trigger: ${motion.trigger}`,
              `Properties: ${motion.properties.join(', ')}`,
              `Duration: ${motion.durationMs}ms${mark(motion.confidence.durationMs)}`,
              `Delay: ${motion.delayMs}ms${mark(motion.confidence.delayMs)}`,
              `Easing: ${motion.easing}${mark(motion.confidence.easing)}`,
              ...(motion.notes ? [`Notes: ${motion.notes}`] : []),
            ]),
          ].join('\n\n'),
        )
        .join('\n\n'),
    )
  }
  sections.push('## States', list(spec.states), '## Caveats', list(spec.caveats))
  return `${sections.join('\n\n')}\n`
}
