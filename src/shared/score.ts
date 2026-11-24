/**
 * How closely a recreation matches its capture, measured rather than judged by the model. Pure:
 * main decodes the original frame and the recreation rendered at the same moment into raw
 * 4-byte pixels (RGBA or BGRA, as long as both use the same order) and hands them here.
 *
 * The measure is SSIM (structural similarity), a standard image-comparison score that looks at
 * brightness, contrast and structure in small windows, so it notices a shape in the wrong place
 * or the wrong colour, but forgives tiny anti-aliasing differences more than a raw pixel diff.
 * It is computed per colour channel and averaged, on images scaled down to SCORE_EDGE so the
 * score depends on the design rather than on sub-pixel rendering. Empty background that matches
 * counts for little (see `channelSsim`), so the score reflects the design, not the margins.
 */

export interface RawImage {
  width: number
  height: number
  /** width × height × 4 bytes; the fourth byte of each pixel (alpha) is ignored. */
  data: Uint8Array
}

/** Longest side both images are scaled to before comparing. */
export const SCORE_EDGE = 256
const WINDOW = 8
const STRIDE = 4
const C1 = (0.01 * 255) ** 2
const C2 = (0.03 * 255) ** 2

/** Shrinks an image by averaging the pixels that fall into each output pixel (box filter). */
export function downscale(image: RawImage, maxEdge: number): { width: number; height: number; channels: Float64Array[] } {
  const { width, height, data } = image
  if (width <= 0 || height <= 0 || data.length < width * height * 4) throw new Error('Image data does not match its size')
  const factor = Math.max(1, Math.max(width, height) / maxEdge)
  const w = Math.max(1, Math.round(width / factor))
  const h = Math.max(1, Math.round(height / factor))
  const channels = [new Float64Array(w * h), new Float64Array(w * h), new Float64Array(w * h)]
  const counts = new Float64Array(w * h)
  for (let y = 0; y < height; y++) {
    const oy = Math.min(h - 1, Math.floor((y * h) / height))
    for (let x = 0; x < width; x++) {
      const ox = Math.min(w - 1, Math.floor((x * w) / width))
      const o = oy * w + ox
      const p = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        const channel = channels[c] as Float64Array
        channel[o] = (channel[o] as number) + (data[p + c] as number)
      }
      counts[o] = (counts[o] as number) + 1
    }
  }
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) channel[i] = (channel[i] as number) / (counts[i] as number)
  }
  return { width: w, height: h, channels }
}

/**
 * SSIM of one channel over windows of `win` pixels, stepped by `stride`, averaged with each
 * window weighted by how much is going on in it (its contrast in either image, plus how far
 * apart their brightness is). Plain SSIM averages every window equally, so a capture that is
 * mostly empty background scores in the 90s even when the recreation misses the design itself;
 * with this weighting a matching empty background barely counts and the content decides.
 */
function channelSsim(a: Float64Array, b: Float64Array, width: number, height: number): number {
  const win = Math.min(WINDOW, width, height)
  const stride = Math.max(1, Math.min(STRIDE, win))
  let total = 0
  let weights = 0
  const n = win * win
  for (let y = 0; y + win <= height; y += stride) {
    for (let x = 0; x + win <= width; x += stride) {
      let sa = 0
      let sb = 0
      let saa = 0
      let sbb = 0
      let sab = 0
      for (let dy = 0; dy < win; dy++) {
        const row = (y + dy) * width + x
        for (let dx = 0; dx < win; dx++) {
          const va = a[row + dx] as number
          const vb = b[row + dx] as number
          sa += va
          sb += vb
          saa += va * va
          sbb += vb * vb
          sab += va * vb
        }
      }
      const ma = sa / n
      const mb = sb / n
      const va = saa / n - ma * ma
      const vb = sbb / n - mb * mb
      const cov = sab / n - ma * mb
      const ssim = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
      const weight = va + vb + (ma - mb) ** 2 + C2
      total += ssim * weight
      weights += weight
    }
  }
  return weights === 0 ? 1 : total / weights
}

/**
 * Similarity of two images of the same size, 0 (nothing alike) to 100 (identical), rounded to
 * one decimal.
 */
export function frameScore(original: RawImage, recreation: RawImage): number {
  if (original.width !== recreation.width || original.height !== recreation.height) {
    throw new Error('Frames must be the same size to compare')
  }
  const a = downscale(original, SCORE_EDGE)
  const b = downscale(recreation, SCORE_EDGE)
  let sum = 0
  for (let c = 0; c < 3; c++) sum += channelSsim(a.channels[c] as Float64Array, b.channels[c] as Float64Array, a.width, a.height)
  return Math.round(Math.max(0, Math.min(1, sum / 3)) * 1000) / 10
}

/** An asset's score: the mean of its frames' scores, so every sampled moment counts equally. */
export function assetScore(frameScores: readonly number[]): number | null {
  if (frameScores.length === 0) return null
  return Math.round((frameScores.reduce((sum, score) => sum + score, 0) / frameScores.length) * 10) / 10
}
