import { describe, expect, it } from 'vitest'
import { contrastRatio, deltaE, describePalette, edgeColor, measurePalette, toHex } from './palette'

/** RGBA pixels: `regions` of [colour, pixel count]. */
function pixels(...regions: [[number, number, number], number][]): { data: Uint8Array; width: number } {
  const total = regions.reduce((sum, [, n]) => sum + n, 0)
  const data = new Uint8Array(total * 4)
  let i = 0
  for (const [[r, g, b], n] of regions) {
    for (let k = 0; k < n; k++, i++) data.set([r, g, b, 255], i * 4)
  }
  return { data, width: total }
}

describe('measurePalette', () => {
  it('finds exact flat colours with their shares, largest first', () => {
    const { data, width } = pixels([[255, 255, 255], 700], [[230, 57, 70], 200], [[29, 29, 31], 100])
    const palette = measurePalette(data, width, 1)
    expect(palette.map((c) => c.hex)).toEqual(['#ffffff', '#e63946', '#1d1d1f'])
    expect(palette.map((c) => c.share)).toEqual([0.7, 0.2, 0.1])
  })

  it('merges near-duplicates such as anti-aliasing and drops specks', () => {
    const { data, width } = pixels([[255, 255, 255], 900], [[252, 253, 255], 90], [[0, 0, 255], 2])
    const palette = measurePalette(data, width, 1)
    expect(palette).toHaveLength(1)
    expect(palette[0]?.share).toBeCloseTo(1, 1)
  })

  it('reads BGRA and skips transparent pixels', () => {
    const data = new Uint8Array([70, 57, 230, 255, 0, 0, 0, 0])
    expect(measurePalette(data, 2, 1, { order: 'bgra' }).map((c) => c.hex)).toEqual(['#e63946'])
  })
})

describe('edgeColor', () => {
  it('finds what the thing sits on, even when something on top covers more', () => {
    // A 10 × 10 page of grey with a dark tile covering the middle 8 × 8.
    const data = new Uint8Array(10 * 10 * 4)
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const tile = x > 0 && x < 9 && y > 0 && y < 9
      data.set(tile ? [22, 22, 24, 255] : [60, 60, 70, 255], (y * 10 + x) * 4)
    }
    const palette = measurePalette(data, 10, 10)
    expect(palette[0]?.hex).toBe('#161618')
    const edge = edgeColor(data, 10, 10, palette)
    expect(edge?.hex).toBe('#3c3c46')
    expect(describePalette(palette, edge)).toContain('#3c3c46 is the colour along the region\'s edges')
  })
})

describe('colour maths', () => {
  it('gives WCAG contrast and perceived difference', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBe(21)
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBe(1)
    expect(deltaE([255, 0, 0], [255, 0, 0])).toBe(0)
    expect(deltaE([255, 0, 0], [0, 0, 255])).toBeGreaterThan(100)
    expect(toHex([1, 2, 255])).toBe('#0102ff')
  })

  it('describes the palette for the model', () => {
    expect(describePalette([])).toBe('')
    expect(describePalette([{ hex: '#ffffff', rgb: [255, 255, 255], share: 0.7 }])).toContain('#ffffff (70%)')
  })
})
