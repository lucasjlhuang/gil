import { describe, expect, it } from 'vitest'
import { inkMask, inkSimilarity, normalizeInk } from './fontMatch'

/** A white `w`×`h` image with dark rectangles [x, y, w, h]. */
function image(w: number, h: number, rects: [number, number, number, number][], ink = 0, paper = 255): Uint8Array {
  const gray = new Uint8Array(w * h).fill(paper)
  for (const [rx, ry, rw, rh] of rects) for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) gray[y * w + x] = ink
  return gray
}

describe('ink comparison', () => {
  it('finds the ink box whatever the colours', () => {
    expect(inkMask(image(40, 20, [[5, 4, 10, 8]]), 40, 20)?.box).toEqual({ x: 5, y: 4, width: 10, height: 8 })
    expect(inkMask(image(40, 20, [[5, 4, 10, 8]], 255, 0), 40, 20)?.box).toEqual({ x: 5, y: 4, width: 10, height: 8 })
    expect(inkMask(image(10, 10, []), 10, 10)).toBeNull()
  })

  it('scores the same shape at another size and place as identical, and a different shape lower', () => {
    const a = normalizeInk(image(100, 40, [[10, 10, 8, 20], [30, 10, 8, 20]]), 100, 40)!
    const b = normalizeInk(image(200, 80, [[50, 20, 16, 40], [90, 20, 16, 40]]), 200, 80)!
    const c = normalizeInk(image(100, 40, [[10, 10, 28, 20]]), 100, 40)!
    expect(inkSimilarity(a, b)).toBeGreaterThan(95)
    expect(inkSimilarity(a, c)).toBeLessThan(inkSimilarity(a, b))
  })
})
