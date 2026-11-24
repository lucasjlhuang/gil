import { describe, expect, it } from 'vitest'
import { assetScore, downscale, frameScore, type RawImage } from './score'

/** A width × height image whose pixel colour comes from `pixel(x, y)`. */
function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): RawImage {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      data.set([r, g, b, 255], (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

const white = () => [255, 255, 255] as [number, number, number]
/** A white canvas with a dark square of side 20 at (left, top). */
const square = (left: number, top: number, colour: [number, number, number] = [20, 20, 20]) =>
  image(64, 64, (x, y) => (x >= left && x < left + 20 && y >= top && y < top + 20 ? colour : white()))

describe('frameScore', () => {
  it('gives identical frames 100', () => {
    expect(frameScore(square(10, 10), square(10, 10))).toBe(100)
  })

  it('scores a slightly moved shape higher than a missing one', () => {
    const original = square(10, 10)
    const nudged = frameScore(original, square(12, 10))
    const missing = frameScore(original, image(64, 64, white))
    expect(nudged).toBeLessThan(100)
    expect(nudged).toBeGreaterThan(missing)
  })

  it('does not let a matching empty background hide a missing design', () => {
    expect(frameScore(square(10, 10), image(64, 64, white))).toBeLessThan(20)
  })

  it('notices a shape in the wrong colour', () => {
    expect(frameScore(square(10, 10), square(10, 10, [200, 20, 20]))).toBeLessThan(90)
  })

  it('stays between 0 and 100 for opposite images', () => {
    const black = image(32, 32, () => [0, 0, 0])
    const score = frameScore(black, image(32, 32, white))
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThan(5)
  })

  it('handles images smaller than a comparison window', () => {
    expect(frameScore(image(3, 2, white), image(3, 2, white))).toBe(100)
  })

  it('refuses frames of different sizes', () => {
    expect(() => frameScore(image(4, 4, white), image(4, 5, white))).toThrow()
  })
})

describe('downscale', () => {
  it('averages pixels so the long edge fits', () => {
    const half = image(512, 256, (x) => (x < 256 ? [0, 0, 0] : [200, 100, 50]))
    const small = downscale(half, 256)
    expect([small.width, small.height]).toEqual([256, 128])
    expect(small.channels[0]?.[0]).toBe(0)
    expect(small.channels[0]?.[255]).toBe(200)
    expect(small.channels[2]?.[255]).toBe(50)
  })

  it('leaves small images at their size', () => {
    expect(downscale(image(10, 6, white), 256).width).toBe(10)
  })
})

describe('assetScore', () => {
  it('is the mean of the frame scores, or null without frames', () => {
    expect(assetScore([100, 80, 90])).toBe(90)
    expect(assetScore([])).toBeNull()
  })
})
