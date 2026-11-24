import { z } from 'zod'
import type { Spec } from './spec'

/**
 * The recipe: how a captured design is built, written so another AI can apply it to different
 * content ("use this animation for our logo, Studio P"). The recreation is one worked example
 * with the captured content; the recipe is the technique behind it, with the content taken out:
 * the parts and what each one is for, which of them the user supplies, the moves in order with
 * their timings, how each effect is made, and how to adapt it to new text, shapes or images.
 * Saved as `recipe.md` (docs/ASSET_FORMAT.md) and served to AI tools ahead of the code.
 */

export const recipeSchema = z.object({
  /** One or two sentences: what happens, in terms of roles, not of the captured content. */
  summary: z.string(),
  parts: z.array(
    z.object({
      /** A role name, such as "lead letter" or "card image": never the captured content. */
      name: z.string(),
      /** What it is and does. */
      role: z.string(),
      /** What the user supplies for it (their text, logo mark, image, colour), or '' if it is fixed. */
      slot: z.string(),
    }),
  ),
  /** The moves, in the order they happen. Empty for a still. */
  steps: z.array(
    z.object({
      part: z.string(),
      /** What changes and how, for example "wipes out from right to left with a clip-path". */
      change: z.string(),
      /** What starts it: "on load", "on hover", "when the previous step ends"… */
      trigger: z.string(),
      /** ms from the trigger. */
      startMs: z.number(),
      durationMs: z.number(),
      easing: z.string(),
    }),
  ),
  /**
   * The replay's timeline: every moment a trigger fires when the recreation plays by itself, in
   * order, including repeats ("hover in at 500 ms", "hover out at 1433 ms", "hover in again at
   * 2433 ms"). A demo of the asset on other content plays the same triggers at the same moments.
   */
  replay: z.array(z.object({ atMs: z.number(), trigger: z.string() })),
  /**
   * Sizes, positions and gaps that define the composition, each as a measured number and, where
   * it should scale with new content, as a proportion ("gap to the tagline: 9 px, 0.4 × cap height").
   */
  layout: z.array(z.string()),
  /**
   * The captured shapes that depend on the content (a letter, the mark it turns into, an
   * in-between shape), as SVG path data, so another AI can see exactly what was drawn and build
   * the equivalent for other content.
   */
  shapes: z.array(
    z.object({
      /** Such as "lead letter at rest", "mark", "morph at 50%". */
      name: z.string(),
      d: z.string(),
      /** What to notice: which strokes are kept, what changed from the previous shape. */
      note: z.string(),
    }),
  ),
  /** How each effect is built, as rules that hold for any content. */
  technique: z.array(z.string()),
  /** What to do to apply it to new content: one instruction per line. */
  adapt: z.array(z.string()),
  /** What must stay as captured for it to still be this design (timings, order, proportions…). */
  keep: z.array(z.string()),
})
export type Recipe = z.infer<typeof recipeSchema>

export const RECIPE_FILE = 'recipe.md'

const list = (items: readonly string[]) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- None')

/** recipe.md: the recipe as an AI tool reads it. */
export function recipeToMarkdown(recipe: Recipe, heading: { title: string; name: string }): string {
  const sections = [
    `# Recipe: ${heading.title}`,
    `How \`${heading.name}\` is built, so it can be applied to other content. The recreation is one worked example of this recipe; when the user asks for it with their own text, logo or images, build from the recipe and fill the slots, and use the recreation's code as the reference for how each step is done.`,
    recipe.summary,
    '## Parts',
    list(recipe.parts.map((part) => `**${part.name}**: ${part.role}${part.slot.trim() ? ` Slot: ${part.slot.trim()}` : ' Fixed.'}`)),
  ]
  if (recipe.steps.length > 0) {
    sections.push(
      '## Steps, in order',
      recipe.steps
        .map((step, i) => `${i + 1}. **${step.part}** ${step.change}. Trigger: ${step.trigger}. Starts ${Math.round(step.startMs)} ms after it, lasts ${Math.round(step.durationMs)} ms, easing ${step.easing}.`)
        .join('\n'),
    )
  }
  if (recipe.replay.length > 0) {
    sections.push(
      '## When it plays by itself',
      'The recreation, and any demo of this on other content, fires its triggers at these moments after `window.replay()`:',
      list(recipe.replay.map((moment) => `${Math.round(moment.atMs)} ms: ${moment.trigger}`)),
    )
  }
  if (recipe.layout.length > 0) sections.push('## Layout', list(recipe.layout))
  if (recipe.shapes.length > 0) {
    sections.push(
      '## Shapes as captured',
      'Reference shapes from the capture (SVG path data, CSS px, fill-rule evenodd). For other content, build the equivalent shapes the same way; do not reuse these unless the content is the same.',
      recipe.shapes.map((shape) => `- **${shape.name}**: ${shape.note}\n  \`${shape.d}\``).join('\n'),
    )
  }
  sections.push('## How it is built', list(recipe.technique), '## To apply it to new content', list(recipe.adapt), '## Keep as captured', list(recipe.keep))
  return `${sections.join('\n\n')}\n`
}

/**
 * How to apply an asset that is a system of values (a colour system, a type system, a font),
 * written from its spec: these are made without a build call, so they have no recipe of their
 * own. Empty for other kinds or a spec with nothing to say.
 */
export function systemGuide(kind: string, spec: Spec): string {
  const lines: string[] = []
  if (kind === 'color-system' && spec.tokens.colors.length > 0) {
    lines.push(
      '## How to apply this colour system',
      '',
      'Use these colours and no others, each in its role. Declare them once as CSS custom properties named after the roles and use them everywhere through `var(...)`.',
      '',
      ...spec.tokens.colors.map((color) => `- \`${color.value}\` ${color.name}: ${color.role}${color.confidence === 'estimated' ? ' (estimated)' : ''}`),
      ...(spec.caveats.some((caveat) => caveat.startsWith('Contrast ')) ? ['', 'Contrast:', ...spec.caveats.filter((caveat) => caveat.startsWith('Contrast ')).map((caveat) => `- ${caveat.replace(/^Contrast /, '')}`)] : []),
      '',
      'Keep the balance of the original: the background and surface colours cover most of the area, text sits on them in the text colours, and the accent is used sparingly, for the one or two things that should draw the eye. Put text only on pairs rated AA or better below; check any other pair you need yourself. Do not invent tints or shades; if one more step is needed (often a full-strength version of a muted accent, for an enabled button), say so to the user.',
    )
  }
  if ((kind === 'type-system' || kind === 'font') && spec.tokens.typography.length > 0) {
    const fonts = [...new Set(spec.tokens.typography.flatMap((level) => (level.fontName ? [level.fontName] : [])))]
    lines.push(
      kind === 'font' ? '## How to use this font' : '## How to apply this type system',
      '',
      ...(fonts.length > 0 ? [`Typeface: ${fonts.join(', ')}. Load it in the user's project the usual way (it is on Google Fonts when gil matched it) and put it first in the font-family, with a similar system font after it.`, ''] : []),
      ...(kind === 'type-system'
        ? [
            'Set every piece of text in one of these levels; do not use sizes or weights between them:',
            '',
            ...spec.tokens.typography.map(
              (level) => `- ${level.level} (${level.role}): ${level.size}px${level.lineHeight ? `/${level.lineHeight}px` : ''}, weight ${level.weight}${level.letterSpacing ? `, letter-spacing ${level.letterSpacing}px` : ''}${level.fontName ? `, ${level.fontName}` : `, ${level.family}`}`,
            ),
            '',
            'Keep the hierarchy: the largest level for one thing per view, body for running text, the small levels for labels and captions. Keep each level\'s line height and letter spacing with its size.',
          ]
        : spec.tokens.typography.map((level) => `Captured at ${level.size}px, weight ${level.weight}, as ${level.role}. Use it at the weights the family offers; keep the letter spacing at ${level.letterSpacing}px unless the size changes a lot.`)),
    )
  }
  if (kind === 'spacing-system' && (spec.tokens.spacing.length > 0 || spec.layout.description)) {
    lines.push(
      '## How to apply this spacing system',
      '',
      spec.layout.description,
      '',
      ...(spec.tokens.spacing.length > 0
        ? ['The steps, smallest first (estimated ones were named by the analysis rather than measured):', '', spec.tokens.spacing.map((step) => `${step.value}px${step.confidence === 'estimated' ? ' (estimated)' : ''}`).join(', '), '']
        : []),
      'Declare the steps once as custom properties (`--space-1`, `--space-2`… smallest first) and use them through `var(...)`, each where it was seen (above). When the user\'s content needs a space the scale does not have, use a multiple of the unit if there is one, else the nearest step. Write spaces as padding, gap and margin, not as line-height or fixed heights: that is what they are, and what gil\'s check reads. With a grid, lay content on its columns and gutters; on narrower screens keep the gutter and drop columns rather than squeezing them. The asset\'s recreation is a chart of the scale, not a layout to copy.',
    )
  }
  const reads = kind === 'spacing-system' ? 'the paddings, gaps and margins' : kind === 'color-system' ? 'the colours' : 'the text styles'
  if (lines.length > 0) lines.push('', `When you have applied it, give your draft to check_use with this asset's name: gil reads ${reads} your draft really uses and says which are not from this asset, and whether anything is cut off or hard to read.`)
  return lines.join('\n')
}
