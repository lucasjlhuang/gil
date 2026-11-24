import type { Spec } from './spec'

/**
 * The type lens's output, built by gil's own code from the saved values rather than written by
 * the model: one labelled sample line per text level, largest first. Cheap (no recreate or
 * verify call) and always the same for the same spec.
 */

/** A colour the page can use as is; anything else falls back. */
const safeColor = (value: string | undefined, fallback: string) =>
  value && /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/]+\)|[a-z]+)$/i.test(value.trim()) ? value.trim() : fallback
/** A font name that cannot leave its quotes or the stylesheet. */
const safeName = (name: string) => name.replace(/["\\<>{};\n\r]/g, '').trim()

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
/** A CSS custom property name from a level, such as `heading-1`. */
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'text'

/** A font stack: the recognised font first, then a generic family from the description. */
export function fontStack(fontName: string | null, family: string): string {
  const generic = /mono/i.test(family) ? 'ui-monospace, monospace' : /serif/i.test(family) && !/sans/i.test(family) ? 'ui-serif, Georgia, serif' : 'system-ui, -apple-system, sans-serif'
  const name = fontName ? safeName(fontName) : ''
  return name ? `"${name}", ${generic}` : generic
}

export function typeSpecimenPage(spec: Spec, title: string): string {
  const background = safeColor(spec.tokens.colors.find((color) => /background|backdrop/i.test(`${color.name} ${color.role}`))?.value, '#ffffff')
  const ink = safeColor(spec.tokens.colors.find((color) => /text|ink|foreground/i.test(`${color.name} ${color.role}`))?.value, '#111111')
  const levels = [...spec.tokens.typography].sort((a, b) => b.size - a.size)
  const used = new Map<string, number>()
  const names = levels.map((level) => {
    const base = slug(level.level)
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    return n === 1 ? base : `${base}-${n}`
  })
  const vars = levels
    .map((level, i) =>
      [
        `  --${names[i]}-font: ${fontStack(level.fontName, level.family)};`,
        `  --${names[i]}-size: ${Number(level.size)}px;`,
        `  --${names[i]}-line-height: ${level.lineHeight === null ? 'normal' : `${Number(level.lineHeight)}px`};`,
        `  --${names[i]}-weight: ${Number(level.weight)};`,
        `  --${names[i]}-letter-spacing: ${Number(level.letterSpacing)}px;`,
      ].join('\n'),
    )
    .join('\n')
  const rows = levels
    .map(
      (level, i) => `  <section class="level">
    <div class="label">${escape(level.level)} · ${escape(level.role)} · ${level.size}px${level.lineHeight === null ? '' : `/${level.lineHeight}px`} · ${level.weight}${level.fontName ? ` · ${escape(level.fontName)}` : ''}</div>
    <p style="font-family: var(--${names[i]}-font); font-size: var(--${names[i]}-size); line-height: var(--${names[i]}-line-height); font-weight: var(--${names[i]}-weight); letter-spacing: var(--${names[i]}-letter-spacing)">The quick brown fox jumps over the lazy dog</p>
  </section>`,
    )
    .join('\n')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escape(title)}</title>
<style>
:root {
  --background: ${background};
  --ink: ${ink};
${vars}
}
body { margin: 0; padding: 24px; background: var(--background); color: var(--ink); font: 13px/1.4 system-ui, -apple-system, sans-serif; }
.level { margin-bottom: 20px; }
.label { opacity: 0.55; font-size: 12px; margin-bottom: 4px; }
p { margin: 0; overflow-wrap: anywhere; }
</style>
</head>
<body>
${rows || '  <p>No text levels were found.</p>'}
  <script>window.replay = function () {}</script>
</body>
</html>
`
}
