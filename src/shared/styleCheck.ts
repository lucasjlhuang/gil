import { z } from 'zod'
import { contrastRatio, deltaE, toHex } from './palette'
import type { Spec } from './spec'

/**
 * Checking the look of a use of an asset, beside its motion: gil reads the styles the draft
 * really uses (from the rendered page, not from its source) and compares them with the tokens
 * the asset's spec holds. Pure, except that `STYLE_PROBE` is run by main inside the draft's
 * sandboxed page.
 *
 * It works for any asset with tokens: a component, a layout, a colour system, a type system, a
 * design system. It asks only whether the draft stays inside the asset's own vocabulary: its
 * colours, its text levels, its corner radii. What the user asked to change is theirs to change,
 * so every finding says so; the AI tool decides which apply.
 */

export const observedStylesSchema = z.object({
  /** Colours in use, each with the area (px²) of what is drawn in it. */
  colors: z.array(z.object({ value: z.string().max(60), use: z.enum(['text', 'background', 'border']), area: z.number().nonnegative() })).max(300),
  /** Text styles in use, each with a sample and how many characters are set in it. */
  texts: z
    .array(
      z.object({
        sample: z.string().max(60),
        fontFamily: z.string().max(300),
        fontSize: z.number().positive(),
        fontWeight: z.number(),
        chars: z.number().nonnegative(),
        /** The text colour and the first solid background behind it. */
        color: z.string().max(60).optional(),
        behind: z.string().max(60).optional(),
      }),
    )
    .max(200),
  /**
   * Things that do not fit: an element reaching past the page's edges, or text cut off by a box
   * too small for it. Each with a few words of what it is.
   */
  overflow: z.array(z.object({ what: z.string().max(80), how: z.enum(['outside', 'clipped']), px: z.number().nonnegative() })).max(20).default([]),
  /** Spaces in use (padding, gap, margin, px), with how many times each occurs. */
  spaces: z.array(z.object({ value: z.number().nonnegative(), count: z.number().nonnegative() })).max(100).default([]),
  /** Corner radii in use (px), with how many elements have each. */
  radii: z.array(z.object({ value: z.number().nonnegative(), count: z.number().nonnegative() })).max(100),
})
export type ObservedStyles = z.infer<typeof observedStylesSchema>

/**
 * Run inside the draft's page: the styles of everything visible, summed up. Returns plain data
 * shaped like `observedStylesSchema`; main validates it, since the page is untrusted.
 */
export const STYLE_PROBE = `(() => {
  const colors = new Map(), texts = new Map(), radii = new Map(), spaces = new Map()
  const add = (map, key, make, by) => { const entry = map.get(key) || make(); by(entry); map.set(key, entry) }
  const seen = (value) => value && !/rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*0(\\.0+)?\\s*\\)|transparent/.test(value)
  for (const el of document.querySelectorAll('body, body *')) {
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
    const area = rect.width * rect.height
    if (seen(cs.backgroundColor)) add(colors, 'background ' + cs.backgroundColor, () => ({ value: cs.backgroundColor, use: 'background', area: 0 }), (e) => { e.area += area })
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && seen(cs.borderTopColor)) add(colors, 'border ' + cs.borderTopColor, () => ({ value: cs.borderTopColor, use: 'border', area: 0 }), (e) => { e.area += (rect.width + rect.height) * 2 * parseFloat(cs.borderTopWidth) })
    for (const shape of ['fill', 'stroke']) {
      if (el instanceof SVGGeometryElement && seen(cs[shape]) && cs[shape] !== 'none') add(colors, 'background ' + cs[shape], () => ({ value: cs[shape], use: 'background', area: 0 }), (e) => { e.area += area * (shape === 'fill' ? 0.5 : 0.1) })
    }
    for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap', 'marginTop', 'marginBottom']) {
      const v = parseFloat(cs[prop])
      if (v >= 2 && v <= 160 && !(prop.endsWith('Gap') && cs.display.indexOf('flex') < 0 && cs.display.indexOf('grid') < 0)) add(spaces, String(Math.round(v * 2) / 2), () => ({ value: Math.round(v * 2) / 2, count: 0 }), (e) => { e.count += 1 })
    }
    const radius = parseFloat(cs.borderTopLeftRadius)
    if (radius > 0 && (seen(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0)) add(radii, String(Math.round(radius * 2) / 2), () => ({ value: Math.round(radius * 2) / 2, count: 0 }), (e) => { e.count += 1 })
    let own = ''
    for (const node of el.childNodes) if (node.nodeType === 3) own += node.textContent
    own = own.replace(/\\s+/g, ' ').trim()
    if (own && seen(cs.color)) {
      const size = parseFloat(cs.fontSize)
      add(colors, 'text ' + cs.color, () => ({ value: cs.color, use: 'text', area: 0 }), (e) => { e.area += own.length * size * size * 0.3 })
      let back = el, behind = ''
      while (back && !behind) { const bg = getComputedStyle(back).backgroundColor; if (seen(bg)) behind = bg; back = back.parentElement }
      add(texts, [cs.fontFamily, size, cs.fontWeight, cs.color, behind].join('|'), () => ({ sample: own.slice(0, 60), fontFamily: cs.fontFamily.slice(0, 300), fontSize: size, fontWeight: Number(cs.fontWeight) || 400, chars: 0, color: cs.color, behind: behind || 'rgb(255, 255, 255)' }), (e) => { e.chars += own.length })
    }
  }
  const overflow = []
  const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight
  const label = (el) => ((el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) || el.tagName.toLowerCase())
  for (const el of document.querySelectorAll('body *')) {
    if (overflow.length >= 20) break
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0 || cs.position === 'fixed' && cs.pointerEvents === 'none') continue
    // Only leaves and boxes with a look: a wrapper sticking out says nothing on its own.
    const drawn = el.children.length === 0 || seen(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0
    const past = Math.max(0, rect.right - W, rect.bottom - H, -rect.left, -rect.top)
    if (drawn && past > 1) { overflow.push({ what: label(el), how: 'outside', px: Math.round(past) }); continue }
    const clips = cs.overflow !== 'visible' || cs.textOverflow === 'ellipsis'
    if (clips && el.children.length === 0 && (el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 2) && cs.overflowY !== 'auto' && cs.overflowY !== 'scroll')
      overflow.push({ what: label(el), how: 'clipped', px: Math.round(Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight)) })
  }
  const top = (map, by, n) => [...map.values()].sort((a, b) => b[by] - a[by]).slice(0, n)
  return { colors: top(colors, 'area', 300), texts: top(texts, 'chars', 200), radii: top(radii, 'count', 100), spaces: top(spaces, 'count', 100), overflow }
})()`

type Rgb = [number, number, number]

/** A CSS colour as RGB: #rgb, #rrggbb, rgb() or rgba(). Null if it is something else or nearly transparent. */
export function parseCssColor(value: string): Rgb | null {
  const text = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(text)
  if (hex) {
    const digits = (hex[1] as string).length === 3 ? [...(hex[1] as string)].map((c) => c + c).join('') : (hex[1] as string)
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(text)
  if (!rgb) return null
  const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])
  if (alpha < 0.5) return null
  return [rgb[1], rgb[2], rgb[3]].map((part) => Math.round(Math.min(255, Number(part)))) as Rgb
}

/** Colours further apart than this (ΔE) are different colours. */
const COLOR_OK = 9
/** A colour or text style has to cover at least this share of its kind to be worth a line. */
const MIN_SHARE = 0.04
/** Most lines per kind, so the list stays readable. */
const MAX_LINES = 4

/**
 * What in the draft's styles is outside the asset's tokens, in plain words. Empty when
 * everything the draft uses is in the asset, or the asset has no tokens of that kind.
 */
export function compareStyles(spec: Spec, given: z.input<typeof observedStylesSchema>): string[] {
  const observed = observedStylesSchema.parse(given)
  const gaps: string[] = []

  const palette = spec.tokens.colors.flatMap((color) => {
    const rgb = parseCssColor(color.value)
    return rgb ? [{ name: color.name, role: color.role, rgb }] : []
  })
  if (palette.length >= 2) {
    for (const use of ['background', 'text', 'border'] as const) {
      const used = observed.colors.filter((color) => color.use === use)
      const total = used.reduce((sum, color) => sum + color.area, 0)
      let lines = 0
      for (const color of used) {
        if (lines >= MAX_LINES || total <= 0 || color.area / total < MIN_SHARE) continue
        const rgb = parseCssColor(color.value)
        if (!rgb) continue
        const nearest = [...palette].sort((a, b) => deltaE(rgb, a.rgb) - deltaE(rgb, b.rgb))[0] as (typeof palette)[number]
        if (deltaE(rgb, nearest.rgb) <= COLOR_OK) continue
        lines++
        gaps.push(
          `The draft uses ${toHex(rgb)} for ${use === 'text' ? 'text' : use === 'border' ? 'borders' : 'fills'} (about ${Math.round((color.area / total) * 100)}% of them), which is not one of the asset's colours; the nearest is ${nearest.name} (${toHex(nearest.rgb)}, ${nearest.role}).`,
        )
      }
    }
  }

  const levels = spec.tokens.typography
  if (levels.length > 0) {
    const total = observed.texts.reduce((sum, text) => sum + text.chars, 0)
    let lines = 0
    for (const text of observed.texts) {
      if (lines >= MAX_LINES || total <= 0 || text.chars / total < MIN_SHARE) continue
      const fits = levels.some((level) => Math.abs(level.size - text.fontSize) <= Math.max(1, level.size * 0.06) && Math.abs(level.weight - text.fontWeight) <= 100)
      if (fits) continue
      lines++
      gaps.push(
        `Text such as "${text.sample}" is set at ${Math.round(text.fontSize * 10) / 10}px, weight ${text.fontWeight}, which is none of the asset's text levels (${levels.map((level) => `${level.level} ${level.size}px/${level.weight}`).join(', ')}).`,
      )
    }
  }

  // The typeface, when the asset names one: a font asset, a type system, or text matched to a real font.
  const fonts = [...new Set(levels.flatMap((level) => (level.fontName?.trim() ? [level.fontName.trim()] : [])))]
  if (fonts.length > 0) {
    const names = fonts.map((font) => font.toLowerCase().replace(/[^a-z0-9]/g, ''))
    const total = observed.texts.reduce((sum, text) => sum + text.chars, 0)
    // The first family in the list is the one asked for; the rest are fallbacks.
    const first = (family: string) => (family.split(',')[0] ?? '').replace(/["']/g, '').trim()
    const others = new Map<string, number>()
    for (const text of observed.texts) {
      const family = first(text.fontFamily)
      const key = family.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (!key || names.some((name) => key.includes(name) || name.includes(key))) continue
      others.set(family, (others.get(family) ?? 0) + text.chars)
    }
    const [family, chars] = [...others].sort((a, b) => b[1] - a[1])[0] ?? []
    if (family && chars && total > 0 && chars / total >= MIN_SHARE) {
      gaps.push(`About ${Math.round((chars / total) * 100)}% of the text is set in "${family}"; the asset's typeface is ${fonts.join(' or ')}. Load that font (it is on Google Fonts if gil matched it) and put it first in the font-family.`)
    }
  }

  // Fit, whatever the asset: nothing may stick out of the page or be cut off.
  for (const item of observed.overflow.slice(0, MAX_LINES)) {
    gaps.push(
      item.how === 'outside'
        ? `"${item.what}" reaches ${item.px}px past the edge of the page, so it is cut off. Make everything fit inside the page (the user's content may need a denser arrangement or a part that scrolls), and say so if it cannot.`
        : `"${item.what}" is cut off by its own box (${item.px}px of it hidden). Give it room, or shorten what it holds.`,
    )
  }

  // Readability, whatever the asset: text that is hard to read on what it sits on.
  let unreadable = 0
  for (const text of observed.texts) {
    if (unreadable >= MAX_LINES || !text.color || !text.behind) continue
    const [ink, ground] = [parseCssColor(text.color), parseCssColor(text.behind)]
    if (!ink || !ground) continue
    const ratio = contrastRatio(ink, ground)
    const large = text.fontSize >= 24 || (text.fontSize >= 18.5 && text.fontWeight >= 700)
    if (ratio >= (large ? 3 : 4.5)) continue
    unreadable++
    gaps.push(`Text such as "${text.sample}" (${toHex(ink)} on ${toHex(ground)}) has a contrast of ${Math.round(ratio * 10) / 10}:1, below the ${large ? '3' : '4.5'}:1 that ${large ? 'large' : ''} text needs to be readable${large ? '' : ' at that size'}.`.replace('that  text', 'that text'))
  }

  // Spacing, when the asset has a scale: spaces between its steps.
  const steps = spec.tokens.spacing.map((step) => step.value)
  // The unit a spacing system is built on, from its description; multiples of it are on the scale too.
  const unit = Number(/built on a (\d+(?:\.\d+)?) px unit/.exec(spec.layout.description)?.[1] ?? 0)
  const onScale = (value: number) => steps.some((step) => Math.abs(step - value) <= 1) || (unit > 0 && Math.min(value % unit, unit - (value % unit)) <= 0.5)
  if (steps.length >= 2) {
    const off = observed.spaces.filter((space) => !onScale(space.value)).sort((a, b) => b.count - a.count)
    const total = observed.spaces.reduce((sum, space) => sum + space.count, 0)
    const offCount = off.reduce((sum, space) => sum + space.count, 0)
    if (total > 0 && offCount / total >= 0.15) {
      gaps.push(`About ${Math.round((offCount / total) * 100)}% of the paddings, gaps and margins are not on the asset's spacing scale (${steps.map((step) => `${step}px`).join(', ')}): most often ${off.slice(0, 4).map((space) => `${space.value}px`).join(', ')}. ${unit > 0 ? ` Use a step or a multiple of ${unit} px.` : ' Use the nearest step.'}`)
    }
  }

  const radii = spec.tokens.radii.map((radius) => radius.value)
  if (radii.length > 0) {
    let lines = 0
    for (const radius of observed.radii) {
      // A radius far larger than anything it could round is a pill or a circle, whatever its number.
      if (lines >= MAX_LINES || radius.value >= 200 || radii.some((value) => Math.abs(value - radius.value) <= 1.5)) continue
      lines++
      gaps.push(`A corner radius of ${radius.value}px is used (${radius.count} element${radius.count === 1 ? '' : 's'}); the asset's radii are ${radii.map((value) => `${value}px`).join(', ')}.`)
    }
  }
  return gaps
}

/** What compareStyles could compare for this asset, in words, for the answer; '' if nothing. */
export function checkedKinds(spec: Spec): string {
  const kinds = [
    spec.tokens.colors.length >= 2 ? 'colours' : '',
    spec.tokens.typography.length > 0 ? 'text sizes' : '',
    spec.tokens.typography.some((level) => level.fontName?.trim()) ? 'typeface' : '',
    spec.tokens.radii.length > 0 ? 'corner radii' : '',
    spec.tokens.spacing.length >= 2 ? 'spacing' : '',
  ].filter(Boolean)
  return kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}` : (kinds[0] ?? '')
}
