import { describe, expect, it } from 'vitest'
import { describeLayout, measureLayout } from './layoutMeasure'

/** A white image with dark rectangles [x, y, w, h]. */
function image(width: number, height: number, rects: [number, number, number, number][]) {
  const data = new Uint8Array(width * height).fill(250)
  for (const [rx, ry, rw, rh] of rects) for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) data[y * width + x] = 30
  return { width, height, data }
}

describe('measureLayout', () => {
  it('finds a header above two cards, with their exact boxes', () => {
    const boxes = measureLayout(image(200, 120, [[10, 10, 180, 20], [10, 50, 80, 30], [110, 50, 80, 30]]))
    expect(boxes.map(({ x, y, width, height }) => [x, y, width, height])).toEqual([
      [10, 10, 180, 20],
      [10, 50, 80, 30],
      [110, 50, 80, 30],
    ])
  })

  it('keeps things separated by a narrow gap together, like letters in a word', () => {
    const boxes = measureLayout(image(100, 40, [[10, 10, 10, 20], [23, 10, 10, 20], [60, 10, 20, 20]]))
    expect(boxes.map((box) => [box.x, box.width])).toEqual([[10, 23], [60, 20]])
  })

  it('looks inside a card with a border and finds what is in it', () => {
    // A 2 px outlined card holding a title and two blocks side by side.
    const data = new Uint8Array(240 * 160).fill(250)
    const fill = (rx: number, ry: number, rw: number, rh: number, v: number) => {
      for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) data[y * 240 + x] = v
    }
    fill(20, 20, 200, 120, 120)
    fill(22, 22, 196, 116, 250)
    fill(40, 40, 120, 14, 30)
    fill(40, 80, 70, 40, 30)
    fill(126, 80, 70, 40, 30)
    const boxes = measureLayout({ width: 240, height: 160, data })
    expect(boxes.map((box) => [box.x, box.y, box.width, box.height])).toEqual([
      [20, 20, 200, 120],
      [40, 40, 120, 14],
      [40, 80, 70, 40],
      [126, 80, 70, 40],
    ])
  })

  it('says nothing about an empty image or one filled edge to edge', () => {
    expect(measureLayout(image(50, 50, []))).toEqual([])
    expect(measureLayout(image(50, 50, [[1, 1, 48, 48]]))).toEqual([])
  })
})

describe('describeLayout', () => {
  it('gives boxes in CSS pixels', () => {
    const text = describeLayout([{ x: 20, y: 20, width: 360, height: 40, depth: 1 }], 2)
    expect(text).toContain('- at 10, 10: 180 × 20')
    expect(describeLayout([], 2)).toBe('')
  })
})
