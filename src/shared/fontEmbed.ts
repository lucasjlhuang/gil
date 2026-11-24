/**
 * Real fonts in a recreation. Pure.
 *
 * While gil and the model work on a recreation, a font is a short placeholder,
 * `url(gil-font:<key>)`, where the key names one file in gil's font cache (for example
 * `dm-sans-400-normal`). The saved recreation is self-contained: each placeholder is replaced by
 * the font itself as a data: URL that still carries its key, so the data can be taken out again
 * before the code is shown to a model or an AI tool (a font is tens of thousands of characters).
 */

/** A font key: family id, weight and style, lowercase with hyphens. Never a path. */
export const FONT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const fontToken = (key: string): string => `gil-font:${key}`

const PLACEHOLDER = /url\(\s*(["']?)gil-font:([a-z0-9-]+)\1\s*\)/g
const EMBEDDED = /url\(\s*(["']?)data:font\/woff2;gil=([a-z0-9-]+);base64,[A-Za-z0-9+/=]+\1\s*\)/g

/** The keys of the placeholders in `html`, each once. */
export function fontKeysIn(html: string): string[] {
  return [...new Set([...html.matchAll(PLACEHOLDER)].map((match) => match[2] as string))].filter((key) => FONT_KEY.test(key))
}

/** Replaces each placeholder whose font is in `fonts` (key → base64 WOFF2) by the font itself. */
export function embedFontData(html: string, fonts: ReadonlyMap<string, string>): string {
  return html.replace(PLACEHOLDER, (whole, _quote: string, key: string) => {
    const data = fonts.get(key)
    return data ? `url("data:font/woff2;gil=${key};base64,${data}")` : whole
  })
}

/** Puts the placeholders back in place of embedded font data. */
export function stripFontData(html: string): string {
  return html.replace(EMBEDDED, (_whole, _quote: string, key: string) => `url(${fontToken(key)})`)
}

/** The fonts embedded in `html`: key → base64 WOFF2. */
export function embeddedFontData(html: string): Map<string, string> {
  const fonts = new Map<string, string>()
  for (const match of html.matchAll(/data:font\/woff2;gil=([a-z0-9-]+);base64,([A-Za-z0-9+/=]+)/g)) fonts.set(match[1] as string, match[2] as string)
  return fonts
}

/** The keys of the fonts embedded in `html`, each once. */
export function embeddedFontKeys(html: string): string[] {
  return [...new Set([...html.matchAll(EMBEDDED)].map((match) => match[2] as string))]
}

/** One run of text gil matched to a real font and measured, in CSS px from the region's top left. */
export interface FittedText {
  text: string
  family: string
  weight: number
  italic: boolean
  /** The font file, as a key for `url(gil-font:<key>)`. */
  key: string
  /** How closely the font's letter shapes match the capture, 0–100. */
  score: number
  fontSize: number
  letterSpacing: number
  /** Where the text element goes (position: absolute, line-height 1) for its ink to land on the capture's. */
  left: number
  top: number
  /** The box the text's ink covers in the capture. */
  ink: { x: number; y: number; width: number; height: number }
}

/**
 * Size, spacing and position that make `text` set in a font cover the capture's ink box.
 * `sample` is the ink box of the same text set at `sampleSize` px with no letter spacing in an
 * element whose top left is the origin (line-height 1); `ink` is the capture's ink box.
 */
export function fitText(
  text: string,
  sampleSize: number,
  sample: { x: number; y: number; width: number; height: number },
  ink: { x: number; y: number; width: number; height: number },
  fontSize?: number,
): { fontSize: number; letterSpacing: number; left: number; top: number } | null {
  if (sample.height <= 0 || sample.width <= 0 || ink.height <= 0 || ink.width <= 0) return null
  const gaps = Math.max(1, [...text].length - 1)
  const round = (value: number) => Math.round(value * 100) / 100
  if (fontSize !== undefined) {
    // A given size (lines of one paragraph share theirs): spacing takes up the width, and the
    // ink is centred on the capture's from top to bottom.
    const k = fontSize / sampleSize
    return {
      fontSize: round(fontSize),
      letterSpacing: round((ink.width - sample.width * k) / gaps),
      left: round(ink.x - sample.x * k),
      top: round(ink.y + ink.height / 2 - (sample.y + sample.height / 2) * k),
    }
  }
  // Height sets the size; whatever width is then left over is letter spacing.
  const k = ink.height / sample.height
  return {
    fontSize: round(sampleSize * k),
    letterSpacing: round((ink.width - sample.width * k) / gaps),
    left: round(ink.x - sample.x * k),
    top: round(ink.y - sample.y * k),
  }
}

/** The matched texts as lines for the model's prompt; '' if there are none. */
export function describeFittedTexts(texts: readonly FittedText[]): string {
  if (texts.length === 0) return ''
  const lines = [
    'Text in real fonts: gil matched these texts to real fonts and measured how to set them so they land on the capture. Set each as real text in its font, never as paths, exactly as given (the element is position: absolute with line-height 1 and white-space: nowrap; left and top are from the region\'s top left). Declare each font once as @font-face with the src written exactly as shown: gil replaces url(gil-font:…) with the font file. Leave the traced outlines of these texts unused. To hide or reveal such text, clip or mask its element.',
  ]
  for (const t of texts) {
    lines.push(
      `- "${t.text}": @font-face { font-family: "${t.key}"; src: url(${fontToken(t.key)}) format("woff2"); } then left ${t.left}px; top ${t.top}px; font: ${t.italic ? 'italic ' : ''}${t.weight} ${t.fontSize}px/1 "${t.key}"; letter-spacing: ${t.letterSpacing}px. This is ${t.family} ${t.weight} from Google Fonts (${t.score}% shape match). Its ink covers x ${t.ink.x}–${Math.round((t.ink.x + t.ink.width) * 10) / 10}, y ${t.ink.y}–${Math.round((t.ink.y + t.ink.height) * 10) / 10}.`,
    )
  }
  return lines.join('\n')
}
