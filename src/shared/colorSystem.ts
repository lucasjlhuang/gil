import { contrastRatio, deltaE, toHex, type PaletteColor } from './palette'
import { parseCssColor } from './styleCheck'
import { SPEC_SCHEMA_VERSION, type Spec } from './spec'

/**
 * The colour lens without a model call: a colour system built by gil's own code from colours
 * measured in the pixels. Roles are guessed from the numbers (the largest area is the
 * background, the colour that stands out most against it is the text, saturated colours are
 * accents), so they are labelled as guesses; the values are exact.
 */

export interface ColorRole {
  name: string
  role: string
  color: PaletteColor
  /** True for a colour the analysis named that was too small to measure in the pixels (text, a thin border). */
  estimated?: boolean
}

function saturation([r, g, b]: [number, number, number]): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
}

/** Names and roles for a measured palette, largest share first. */
export function assignRoles(palette: readonly PaletteColor[]): ColorRole[] {
  const [background, ...rest] = palette
  if (!background) return []
  const text = [...rest].sort((a, b) => contrastRatio(b.rgb, background.rgb) - contrastRatio(a.rgb, background.rgb))[0]
  let accent = 0
  let neutral = 0
  return palette.map((color) => {
    if (color === background) return { name: 'background', role: 'background (largest area)', color }
    if (color === text && contrastRatio(color.rgb, background.rgb) >= 3) return { name: 'text', role: 'text (most contrast with the background)', color }
    if (saturation(color.rgb) > 0.35) {
      accent++
      return { name: `accent-${accent}`, role: 'accent', color }
    }
    neutral++
    return { name: `neutral-${neutral}`, role: 'neutral', color }
  })
}

/**
 * Measured roles enriched with what an analysis of the same capture already knows: its names and
 * roles replace the guessed ones where a colour matches, and colours too small to measure in the
 * pixels (text, thin borders) are added as estimates. Measured values are kept as measured.
 */
export function withAnalysisColors(roles: readonly ColorRole[], named: readonly { name: string; value: string; role: string }[]): ColorRole[] {
  const out = roles.map((role) => ({ ...role }))
  const wanted = named.flatMap((color) => {
    const rgb = parseCssColor(color.value)
    return rgb && color.name.trim() ? [{ name: color.name.trim(), role: color.role.trim(), rgb }] : []
  })
  // Closest pairs first, each colour used once, so one name cannot take another's colour.
  const pairs = wanted.flatMap((color, i) => out.map((role, j) => ({ i, j, distance: deltaE(role.color.rgb, color.rgb) }))).sort((a, b) => a.distance - b.distance)
  const matchedNamed = new Set<number>()
  const matchedRole = new Set<number>()
  for (const pair of pairs) {
    if (pair.distance >= 8 || matchedNamed.has(pair.i) || matchedRole.has(pair.j)) continue
    matchedNamed.add(pair.i)
    matchedRole.add(pair.j)
    const role = out[pair.j] as ColorRole
    const color = wanted[pair.i] as (typeof wanted)[number]
    role.name = color.name
    role.role = color.role || role.role
  }
  wanted.forEach((color, i) => {
    if (matchedNamed.has(i) || out.some((role) => deltaE(role.color.rgb, color.rgb) < 4)) return
    out.push({ name: color.name, role: color.role || 'colour', color: { hex: toHex(color.rgb), rgb: color.rgb, share: 0 }, estimated: true })
  })
  // Names must stay unique: they become custom property names.
  const seen = new Map<string, number>()
  for (const role of out) {
    const count = (seen.get(role.name) ?? 0) + 1
    seen.set(role.name, count)
    if (count > 1) role.name = `${role.name}-${count}`
  }
  return out
}

/**
 * Readable pairs: each colour against the background (the largest area) and against the colour
 * that stands out most from it (the main text colour), with WCAG ratings.
 */
export function contrastPairs(roles: readonly ColorRole[]): { a: string; b: string; ratio: number; rating: string }[] {
  const background = roles[0]
  if (!background) return []
  const text = [...roles.slice(1)].sort((x, y) => contrastRatio(y.color.rgb, background.color.rgb) - contrastRatio(x.color.rgb, background.color.rgb))[0]
  const anchors = text && contrastRatio(text.color.rgb, background.color.rgb) >= 3 ? [background, text] : [background]
  const pairs: { a: string; b: string; ratio: number; rating: string }[] = []
  for (const anchor of anchors) {
    for (const other of roles) {
      if (other === anchor || (anchor === text && other === background)) continue
      const ratio = contrastRatio(anchor.color.rgb, other.color.rgb)
      const rating = ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA large text only' : 'fails'
      pairs.push({ a: other.name, b: anchor.name, ratio, rating })
    }
  }
  return pairs
}

/** spec.json for a colour system: measured colours, nothing else. */
export function colorSystemSpec(roles: readonly ColorRole[], sourceName: string): Spec {
  const pairs = contrastPairs(roles)
  return {
    schemaVersion: SPEC_SCHEMA_VERSION,
    description: `The colour palette of ${sourceName}, measured from its pixels by gil. Shares are the part of the capture each colour covers.`,
    tokens: {
      colors: roles.map((role) => ({
        name: role.name,
        value: role.color.hex,
        role: role.estimated ? `${role.role}, too small in the capture to measure` : `${role.role}, ${Math.round(role.color.share * 100)}% of the capture`,
        confidence: role.estimated ? ('estimated' as const) : ('measured' as const),
      })),
      typography: [],
      radii: [],
      spacing: [],
      shadows: [],
      effects: [],
    },
    layout: { description: 'A colour system has no layout.', regions: [] },
    motion: [],
    states: [],
    caveats: [
      'Values marked measured are exact, from the pixels. Colours marked estimated (text, thin lines) were too small to measure and come from the analysis of the same capture. Names and roles not taken from that analysis are guessed from area and contrast.',
      'Only colours visible in the capture are included, so this is the palette of that screen, not a whole design system.',
      ...pairs.map((pair) => `Contrast ${pair.a} on ${pair.b}: ${pair.ratio}:1 (${pair.rating})`),
    ],
  }
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** A self-contained swatch page for the recreation slot: no scripts beyond replay, no network. */
export function swatchPage(roles: readonly ColorRole[], title: string): string {
  const background = roles[0]?.color.hex ?? '#ffffff'
  const text = roles.find((role) => role.name === 'text')?.color.hex ?? '#111111'
  const vars = roles.map((role) => `  --${role.name}: ${role.color.hex};`).join('\n')
  const swatches = roles
    .map(
      (role) => `    <figure class="swatch">
      <div class="chip" style="background: var(--${role.name})"></div>
      <figcaption><strong>${escape(role.name)}</strong><code>${role.color.hex}</code><span>${Math.round(role.color.share * 100)}%</span></figcaption>
    </figure>`,
    )
    .join('\n')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escape(title)}</title>
<style>
:root {
${vars}
}
body { margin: 0; padding: 24px; background: ${background}; color: ${text}; font: 14px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; }
h1 { font-size: 16px; margin: 0 0 16px; }
.swatches { display: flex; flex-wrap: wrap; gap: 16px; }
.swatch { margin: 0; width: 120px; }
.chip { height: 72px; border-radius: 10px; box-shadow: inset 0 0 0 1px rgba(127, 127, 127, 0.3); }
figcaption { display: flex; flex-direction: column; margin-top: 6px; }
code { font-size: 12px; }
span { opacity: 0.6; font-size: 12px; }
</style>
</head>
<body>
  <h1>${escape(title)}</h1>
  <div class="swatches">
${swatches}
  </div>
  <script>window.replay = function () {}</script>
</body>
</html>
`
}
