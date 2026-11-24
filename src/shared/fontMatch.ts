import { z } from 'zod'

/**
 * Comparing text set in a candidate font with the captured text, by shape. Pure. Both images
 * are reduced to their "ink" (the pixels that differ from the background, whatever the colours),
 * cropped to it, scaled to the same box, and compared by overlap (intersection over union).
 * Colour, position and size drop out; letter shapes, weight, width and spacing decide.
 */

export const INK_BOX = { width: 320, height: 64 }

/** Grayscale (0–255) of 4-byte pixels; `bgra` for nativeImage bitmaps. */
export function grayOf(data: Uint8Array, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height)
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.299 * (data[i * 4 + 2] as number) + 0.587 * (data[i * 4 + 1] as number) + 0.114 * (data[i * 4] as number))
  }
  return gray
}

/**
 * Ink mask: pixels far from the background, which is taken to be the most common grey level
 * (light text on dark works as well as dark on light). Null if there is no ink.
 */
export function inkMask(gray: Uint8Array, width: number, height: number): { mask: Uint8Array; box: { x: number; y: number; width: number; height: number } } | null {
  const histogram = new Array<number>(256).fill(0)
  for (const value of gray) histogram[value] = (histogram[value] as number) + 1
  const background = histogram.indexOf(Math.max(...histogram))
  const mask = new Uint8Array(gray.length)
  let [minX, minY, maxX, maxY] = [width, height, -1, -1]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (Math.abs((gray[i] as number) - background) > 64) {
        mask[i] = 1
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { mask, box: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } }
}

/** The ink cropped to its box and scaled to INK_BOX (nearest pixel), so sizes compare. */
export function normalizeInk(gray: Uint8Array, width: number, height: number): Uint8Array | null {
  const ink = inkMask(gray, width, height)
  if (!ink) return null
  const out = new Uint8Array(INK_BOX.width * INK_BOX.height)
  for (let y = 0; y < INK_BOX.height; y++) {
    const sy = ink.box.y + Math.min(ink.box.height - 1, Math.floor((y * ink.box.height) / INK_BOX.height))
    for (let x = 0; x < INK_BOX.width; x++) {
      const sx = ink.box.x + Math.min(ink.box.width - 1, Math.floor((x * ink.box.width) / INK_BOX.width))
      out[y * INK_BOX.width + x] = ink.mask[sy * width + sx] as number
    }
  }
  return out
}

/** Overlap of two normalised ink masks, 0–100. */
export function inkSimilarity(a: Uint8Array, b: Uint8Array): number {
  let both = 0
  let either = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) either++
    if (a[i] && b[i]) both++
  }
  return either === 0 ? 0 : Math.round((both / either) * 1000) / 10
}

/** font.json: what font identification found for a capture (docs/ASSET_FORMAT.md). */
export const fontResultSchema = z.object({
  version: z.literal(1),
  /** The text the model read in the capture, which the candidates were set in. */
  text: z.string(),
  /** The font the model thinks it is, which may be a paid font that is not in the catalogue. */
  modelGuess: z.string().nullable(),
  category: z.string(),
  weight: z.number(),
  italic: z.boolean(),
  traits: z.array(z.string()),
  /** Free fonts ranked by how closely their shapes match, best first. */
  matches: z.array(z.object({ family: z.string(), id: z.string(), weight: z.number(), score: z.number() })),
})
export type FontResult = z.infer<typeof fontResultSchema>

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * The font asset's page: the captured text set in each of the best free matches, with the
 * fonts embedded as data: URLs (recreations make no network requests).
 */
export function fontSpecimenPage(result: FontResult, fonts: readonly { family: string; weight: number; dataUrl: string }[], title: string): string {
  const faces = fonts
    .map((font, i) => `@font-face { font-family: "gil-match-${i}"; src: url(${font.dataUrl}) format("woff2"); font-weight: ${Number(font.weight)}; font-style: ${result.italic ? 'italic' : 'normal'}; }`)
    .join('\n')
  const rows = fonts
    .map((font, i) => {
      const score = result.matches.find((match) => match.family === font.family)?.score
      return `  <section>
    <div class="label">${escapeHtml(font.family)} · ${Number(font.weight)}${score === undefined ? '' : ` · ${score}% shape match`}</div>
    <p style="font-family: 'gil-match-${i}', sans-serif; font-weight: ${Number(font.weight)}${result.italic ? '; font-style: italic' : ''}">${escapeHtml(result.text || 'The quick brown fox')}</p>
  </section>`
    })
    .join('\n')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${faces}
body { margin: 0; padding: 24px; background: #fff; color: #111; font: 13px/1.4 system-ui, -apple-system, sans-serif; }
section { margin-bottom: 18px; }
.label { opacity: 0.55; font-size: 12px; margin-bottom: 2px; }
.guess { opacity: 0.7; margin-bottom: 16px; }
p { margin: 0; font-size: 40px; line-height: 1.2; overflow-wrap: anywhere; }
</style>
</head>
<body>
${result.modelGuess ? `  <div class="guess">Looks like ${escapeHtml(result.modelGuess)}. Closest free fonts:</div>` : ''}
${rows || '  <p>No free match was found.</p>'}
  <script>window.replay = function () {}</script>
</body>
</html>
`
}
