import { z } from 'zod'

/**
 * Exact style values the Chrome extension reads from a web page for the part the user clipped:
 * the computed font, size, line height, weight, letter spacing and colours of the text, and the
 * colours of backgrounds and borders. Values only: never the site's code or font files. Saved
 * as `capture/page-styles.json` and given to the model as measured values.
 */

export const MAX_TEXT_STYLES = 40
export const MAX_PAGE_COLORS = 40

export const textStyleSchema = z.object({
  /** A few words of the text, so the model can tell which level is which. */
  sample: z.string().max(60),
  /** The computed font-family list, as written in the page's CSS. */
  fontFamily: z.string().max(300),
  /** CSS px. */
  fontSize: z.number().finite().positive(),
  /** CSS px; null for `normal`. */
  lineHeight: z.number().finite().positive().nullable(),
  fontWeight: z.number().finite(),
  /** CSS px; 0 for `normal`. */
  letterSpacing: z.number().finite(),
  /** Computed colour, as the browser reports it (rgb() or rgba()). */
  color: z.string().max(100),
  /** How many text runs in the clip use this exact style. */
  count: z.number().int().positive(),
})

export const pageColorSchema = z.object({
  value: z.string().max(100),
  uses: z.array(z.enum(['text', 'background', 'border'])).max(3),
  count: z.number().int().positive(),
})

export const MAX_PAGE_BOXES = 40
export const MAX_PAGE_MOTIONS = 30

/** One element's box, from getBoundingClientRect, relative to the clip's top left, in CSS px. */
export const pageBoxSchema = z.object({
  /** The tag and a class or id, such as `button.cta`, to tell boxes apart. Never content. */
  label: z.string().max(60),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
  /** Computed border-radius and padding, as the browser reports them. */
  radius: z.string().max(60),
  padding: z.string().max(60),
})

/**
 * How an element moves: a running animation (from `document.getAnimations()`) or a transition
 * the page declares for it (computed `transition`), which is what a hover uses.
 */
export const pageMotionSchema = z.object({
  kind: z.enum(['animation', 'transition']),
  label: z.string().max(60),
  /** The properties that change, such as `transform, opacity`. */
  properties: z.string().max(200),
  /** ms. */
  durationMs: z.number().finite().nonnegative(),
  delayMs: z.number().finite(),
  /** A CSS timing function. */
  easing: z.string().max(120),
  /** Animations only: how many times it runs (Infinity is sent as -1) and its keyframes in short. */
  iterations: z.number().finite().optional(),
  keyframes: z.string().max(400).optional(),
})

export const pageStylesSchema = z.object({
  texts: z.array(textStyleSchema).max(MAX_TEXT_STYLES),
  colors: z.array(pageColorSchema).max(MAX_PAGE_COLORS),
  /** Missing in clips from before these were read. */
  boxes: z.array(pageBoxSchema).max(MAX_PAGE_BOXES).optional(),
  motions: z.array(pageMotionSchema).max(MAX_PAGE_MOTIONS).optional(),
})
export type PageBox = z.infer<typeof pageBoxSchema>
export type PageMotion = z.infer<typeof pageMotionSchema>
export type PageStyles = z.infer<typeof pageStylesSchema>
export type TextStyle = z.infer<typeof textStyleSchema>

export const PAGE_STYLES_FILE = 'page-styles.json'

/** A CSS time (`0.3s`, `300ms`) in ms; 0 for anything else. */
export function ms(value: string): number {
  const match = /^(-?\d*\.?\d+)(ms|s)$/.exec(value.trim())
  return match ? Math.round(Number(match[1]) * (match[2] === 's' ? 1000 : 1) * 100) / 100 : 0
}

/** Splits a computed list such as `opacity, transform` or `0.3s, 0.1s` on top-level commas. */
export function splitList(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth++
    if (char === ')') depth--
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/**
 * The transitions a computed style declares, one per property, leaving out those that take no
 * time. Lists shorter than the property list repeat, as CSS does.
 */
export function transitionsOf(style: { transitionProperty: string; transitionDuration: string; transitionDelay: string; transitionTimingFunction: string }): {
  properties: string
  durationMs: number
  delayMs: number
  easing: string
}[] {
  const properties = splitList(style.transitionProperty)
  const durations = splitList(style.transitionDuration)
  const delays = splitList(style.transitionDelay)
  const easings = splitList(style.transitionTimingFunction)
  const pick = (list: string[], i: number) => list[i % Math.max(1, list.length)] ?? ''
  const found = new Map<string, { properties: string[]; durationMs: number; delayMs: number; easing: string }>()
  properties.forEach((property, i) => {
    const durationMs = ms(pick(durations, i))
    if (durationMs <= 0 || property === 'none') return
    const delayMs = ms(pick(delays, i))
    const easing = pick(easings, i) || 'ease'
    // Properties that share a timing are one line.
    const key = `${durationMs}|${delayMs}|${easing}`
    const entry = found.get(key)
    if (entry) entry.properties.push(property)
    else found.set(key, { properties: [property], durationMs, delayMs, easing })
  })
  return [...found.values()].map((entry) => ({ ...entry, properties: entry.properties.join(', ').slice(0, 200) }))
}

/** Parses a CSS length in px (`16px`); null for anything else (`normal`). */
export function px(value: string): number | null {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim())
  return match ? Number(match[1]) : null
}

/** Merges raw style readings into distinct styles, the most used first, within the limits. */
export function collectStyles(
  texts: readonly Omit<TextStyle, 'count'>[],
  colors: readonly { value: string; use: 'text' | 'background' | 'border' }[],
): PageStyles {
  const byStyle = new Map<string, TextStyle>()
  for (const text of texts) {
    const key = JSON.stringify([text.fontFamily, text.fontSize, text.lineHeight, text.fontWeight, text.letterSpacing, text.color])
    const existing = byStyle.get(key)
    if (existing) existing.count++
    else byStyle.set(key, { ...text, sample: text.sample.slice(0, 60), count: 1 })
  }
  const byColor = new Map<string, { value: string; uses: Set<'text' | 'background' | 'border'>; count: number }>()
  for (const color of colors) {
    if (/^rgba\([^)]*,\s*0\)$/.test(color.value) || color.value === 'transparent') continue
    const existing = byColor.get(color.value)
    if (existing) {
      existing.count++
      existing.uses.add(color.use)
    } else byColor.set(color.value, { value: color.value, uses: new Set([color.use]), count: 1 })
  }
  return {
    texts: [...byStyle.values()].sort((a, b) => b.fontSize - a.fontSize || b.count - a.count).slice(0, MAX_TEXT_STYLES),
    colors: [...byColor.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_PAGE_COLORS)
      .map((color) => ({ value: color.value, uses: [...color.uses], count: color.count })),
  }
}

/** The styles as lines for the model's prompt; empty if there are none. */
export function describePageStyles(styles: PageStyles | null): string {
  if (!styles || (styles.texts.length === 0 && styles.colors.length === 0)) return ''
  const lines = [
    "Page styles: the gil Chrome extension read these exact values from the web page's CSS for the clipped area. They are exact: use them for typography and colours and mark them \"measured\". The font is the page's declared font-family; the first available one is what was shown.",
  ]
  for (const text of styles.texts) {
    lines.push(
      `- Text "${text.sample}": ${text.fontFamily}, ${text.fontSize}px, line height ${text.lineHeight === null ? 'normal' : `${text.lineHeight}px`}, weight ${text.fontWeight}, letter-spacing ${text.letterSpacing}px, colour ${text.color} (${text.count}×)`,
    )
  }
  if (styles.colors.length) {
    lines.push(`- Colours: ${styles.colors.map((color) => `${color.value} (${color.uses.join(', ')})`).join('; ')}`)
  }
  if (styles.boxes?.length) {
    lines.push('Exact boxes of the elements in the clip (x, y from its top left, then width × height, in CSS px), with corner radius and padding. Use them for layout regions, sizes, gaps and radii, and mark those "measured":')
    for (const box of styles.boxes) {
      lines.push(`- ${box.label}: at ${box.x}, ${box.y}, ${box.width} × ${box.height}; radius ${box.radius}; padding ${box.padding}`)
    }
  }
  if (styles.motions?.length) {
    lines.push('Exact motion the page declares for these elements. These are the real durations, delays and easings: use them as they are and mark them "measured". A transition runs whenever its property changes, such as on hover:')
    for (const motion of styles.motions) {
      lines.push(
        `- ${motion.label} (${motion.kind}): ${motion.properties}, ${motion.durationMs} ms, delay ${motion.delayMs} ms, ${motion.easing}${motion.iterations === undefined ? '' : `, runs ${motion.iterations < 0 ? 'forever' : `${motion.iterations}×`}`}${motion.keyframes ? `; keyframes: ${motion.keyframes}` : ''}`,
      )
    }
  }
  return lines.join('\n')
}
