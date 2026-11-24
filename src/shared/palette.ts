/**
 * Colours measured from pixels: the palette of an image, worked out on the Mac so colour values
 * are exact rather than the model's reading. Pure: main decodes the image into 4-byte pixels.
 *
 * Pixels are grouped by median cut (repeatedly splitting the group with the widest colour range
 * at its median), similar groups are merged by perceived difference (CIE76 ΔE in Lab), and each
 * colour keeps the share of the image it covers. Anti-aliased edges and gradients produce many
 * near-duplicates, so tiny shares are dropped.
 */

export interface PaletteColor {
  /** #rrggbb */
  hex: string
  rgb: [number, number, number]
  /** Fraction of the image, 0–1. */
  share: number
}

/** Colours closer than this (ΔE) are one colour. About 2.3 is the smallest visible difference. */
const MERGE_DELTA_E = 6
/** Colours covering less of the image than this are dropped (edges, noise). */
const MIN_SHARE = 0.004
/** At most this many pixels are sampled, evenly. */
const MAX_SAMPLES = 120_000

type Rgb = [number, number, number]

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

function toLab([r, g, b]: Rgb): Rgb {
  const linear = (v: number) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)]
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

export function deltaE(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = toLab(a)
  const [l2, a2, b2] = toLab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio, 1–21, to one decimal. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10
}

function median(group: Rgb[]): { channel: 0 | 1 | 2; range: number } {
  let best: { channel: 0 | 1 | 2; range: number } = { channel: 0, range: -1 }
  for (const channel of [0, 1, 2] as const) {
    let min = 255
    let max = 0
    for (const pixel of group) {
      if (pixel[channel] < min) min = pixel[channel]
      if (pixel[channel] > max) max = pixel[channel]
    }
    if (max - min > best.range) best = { channel, range: max - min }
  }
  return best
}

function average(group: Rgb[]): Rgb {
  const sum: Rgb = [0, 0, 0]
  for (const pixel of group) for (let c = 0; c < 3; c++) sum[c] = (sum[c] as number) + (pixel[c] as number)
  return sum.map((v) => Math.round(v / group.length)) as Rgb
}

/**
 * The palette of a `width` × `height` image of 4-byte pixels (`order` says where red is; the
 * alpha byte is ignored, and fully transparent pixels are skipped), largest share first.
 */
export function measurePalette(
  data: Uint8Array,
  width: number,
  height: number,
  options: { order?: 'rgba' | 'bgra'; maxColors?: number } = {},
): PaletteColor[] {
  const total = width * height
  if (total === 0 || data.length < total * 4) return []
  const [ri, bi] = options.order === 'bgra' ? [2, 0] : [0, 2]
  const step = Math.max(1, Math.floor(total / MAX_SAMPLES))
  const pixels: Rgb[] = []
  for (let i = 0; i < total; i += step) {
    const p = i * 4
    if ((data[p + 3] as number) === 0) continue
    pixels.push([data[p + ri] as number, data[p + 1] as number, data[p + bi] as number])
  }
  if (pixels.length === 0) return []

  // Median cut into more groups than wanted; merging brings it back down.
  const target = Math.max(1, (options.maxColors ?? 12) * 3)
  let groups: Rgb[][] = [pixels]
  while (groups.length < target) {
    let widest = -1
    let index = -1
    groups.forEach((group, i) => {
      if (group.length < 2) return
      const { range } = median(group)
      if (range > widest) {
        widest = range
        index = i
      }
    })
    if (index < 0 || widest <= 2) break
    const group = groups[index] as Rgb[]
    const { channel } = median(group)
    group.sort((a, b) => a[channel] - b[channel])
    const half = Math.floor(group.length / 2)
    groups = [...groups.slice(0, index), group.slice(0, half), group.slice(half), ...groups.slice(index + 1)]
  }

  // Merge perceptually close groups, biggest first so the main colour wins.
  const colors = groups
    .map((group) => ({ rgb: average(group), count: group.length }))
    .sort((a, b) => b.count - a.count)
  const merged: { rgb: Rgb; count: number }[] = []
  for (const color of colors) {
    const near = merged.find((existing) => deltaE(existing.rgb, color.rgb) < MERGE_DELTA_E)
    if (near) near.count += color.count
    else merged.push({ ...color })
  }
  return merged
    .map((color) => ({ hex: toHex(color.rgb), rgb: color.rgb, share: color.count / pixels.length }))
    .filter((color) => color.share >= MIN_SHARE)
    .sort((a, b) => b.share - a.share)
    .slice(0, options.maxColors ?? 12)
    .map((color) => ({ ...color, share: Math.round(color.share * 1000) / 1000 }))
}

/**
 * The palette colour most of the region's outermost pixels are nearest to: what the thing sits
 * on. Not always the largest area (a grid of tiles covers more than the page between them).
 */
export function edgeColor(data: Uint8Array, width: number, height: number, palette: readonly PaletteColor[], order: 'rgba' | 'bgra' = 'rgba'): PaletteColor | null {
  if (palette.length === 0 || width < 2 || height < 2) return null
  const [ri, bi] = order === 'bgra' ? [2, 0] : [0, 2]
  const counts = new Array<number>(palette.length).fill(0)
  const visit = (x: number, y: number) => {
    const p = (y * width + x) * 4
    const rgb: Rgb = [data[p + ri] as number, data[p + 1] as number, data[p + bi] as number]
    let best = 0
    palette.forEach((color, i) => {
      if (deltaE(rgb, color.rgb) < deltaE(rgb, (palette[best] as PaletteColor).rgb)) best = i
    })
    counts[best] = (counts[best] as number) + 1
  }
  for (let x = 0; x < width; x++) {
    visit(x, 0)
    visit(x, height - 1)
  }
  for (let y = 1; y < height - 1; y++) {
    visit(0, y)
    visit(width - 1, y)
  }
  return palette[counts.indexOf(Math.max(...counts))] ?? null
}

/** The palette as a line for the model's prompt; empty if there is none. */
export function describePalette(palette: readonly PaletteColor[], edge: PaletteColor | null = null): string {
  if (palette.length === 0) return ''
  const lines = [
    'Measured colours: gil measured these exact values from the pixels (share of the region in brackets). Use these values for the matching colours and mark them "measured"; anti-aliasing and compression can add near-duplicates, so a colour you see that is not listed is estimated.',
    palette.map((color) => `${color.hex} (${Math.round(color.share * 100)}%)`).join(', '),
  ]
  if (edge) {
    lines.push(
      edge === palette[0]
        ? `${edge.hex} is both the largest area and the colour along the region's edges: most likely the page the thing sits on.`
        : `${edge.hex} is the colour along the region's edges: most likely the page the thing sits on. The largest area, ${(palette[0] as PaletteColor).hex}, is something on top of it (tiles, cards, a panel), not the page.`,
    )
  }
  return lines.join('\n')
}
