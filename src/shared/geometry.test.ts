import { describe, expect, it } from 'vitest'
import {
  clampRect,
  rectToVideoCrop,
  expandRect,
  isSelectable,
  placeOutside,
  rectFromPoints,
  rectsIntersect,
  windowRectToDisplayRect,
} from './geometry'

describe('rectFromPoints', () => {
  it('normalises a drag in any direction', () => {
    const expected = { x: 10, y: 20, width: 30, height: 40 }
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(expected)
    expect(rectFromPoints({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(expected)
    expect(rectFromPoints({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(expected)
  })
})

describe('clampRect', () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 }

  it('leaves a contained rect alone', () => {
    const rect = { x: 10, y: 10, width: 20, height: 20 }
    expect(clampRect(rect, bounds)).toEqual(rect)
  })

  it('clips a rect that overflows', () => {
    expect(clampRect({ x: -10, y: 90, width: 50, height: 50 }, bounds)).toEqual({
      x: 0,
      y: 90,
      width: 40,
      height: 10,
    })
  })

  it('collapses a rect that is entirely outside', () => {
    const clipped = clampRect({ x: 200, y: 200, width: 10, height: 10 }, bounds)
    expect(clipped.width).toBe(0)
    expect(clipped.height).toBe(0)
  })
})

describe('isSelectable', () => {
  it('rejects accidental clicks', () => {
    expect(isSelectable({ width: 3, height: 200 })).toBe(false)
    expect(isSelectable({ width: 8, height: 8 })).toBe(true)
  })
})

describe('windowRectToDisplayRect', () => {
  const rect = { x: 100, y: 50, width: 200, height: 80 }

  it('is the identity when the window covers the display exactly', () => {
    const bounds = { x: 0, y: 0, width: 1512, height: 982 }
    expect(windowRectToDisplayRect(rect, bounds, bounds)).toEqual(rect)
  })

  it('is independent of where the display sits in the global space', () => {
    // Secondary display to the left of and above the primary: negative global origin.
    const bounds = { x: -1920, y: -300, width: 1920, height: 1080 }
    expect(windowRectToDisplayRect(rect, bounds, bounds)).toEqual(rect)
  })

  it('accounts for a window pushed below the menu bar', () => {
    const display = { x: 0, y: 0, width: 1512, height: 982 }
    const window = { x: 0, y: 38, width: 1512, height: 944 }
    expect(windowRectToDisplayRect(rect, window, display)).toEqual({ ...rect, y: 88 })
  })

  it('clips to the display', () => {
    const display = { x: 0, y: 0, width: 1000, height: 800 }
    const window = { x: 0, y: 0, width: 1000, height: 800 }
    expect(
      windowRectToDisplayRect({ x: 900, y: 700, width: 300, height: 300 }, window, display),
    ).toEqual({ x: 900, y: 700, width: 100, height: 100 })
  })
})

describe('rectToVideoCrop', () => {
  it('keeps odd sizes for screenshots', () => {
    const result = rectToVideoCrop(
      { x: 11, y: 21, width: 301, height: 201 },
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
      { even: false },
    )
    expect(result.crop).toEqual({ x: 11, y: 21, width: 301, height: 201 })
  })

  it('scales by 2 on a Retina display', () => {
    const result = rectToVideoCrop(
      { x: 100, y: 50, width: 320, height: 48 },
      { width: 1512, height: 982 },
      { width: 3024, height: 1964 },
    )
    expect(result).toEqual({ crop: { x: 200, y: 100, width: 640, height: 96 }, scale: 2 })
  })

  it('is 1:1 on a non-Retina external display', () => {
    const result = rectToVideoCrop(
      { x: 11, y: 21, width: 300, height: 200 },
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
    )
    expect(result).toEqual({ crop: { x: 11, y: 21, width: 300, height: 200 }, scale: 1 })
  })

  it('uses the recorded frame size, not a nominal scale factor', () => {
    // A "More Space" mode: 1800x1169 points reported at scale 2, but the stream is native 3024x1964.
    const result = rectToVideoCrop(
      { x: 900, y: 0, width: 900, height: 1169 },
      { width: 1800, height: 1169 },
      { width: 3024, height: 1964 },
    )
    expect(result.crop).toEqual({ x: 1512, y: 0, width: 1512, height: 1964 })
    expect(result.scale).toBe(1.68)
  })

  it('always returns even dimensions inside the frame', () => {
    const video = { width: 1920, height: 1080 }
    const result = rectToVideoCrop(
      { x: 1001, y: 501, width: 333, height: 77 },
      { width: 1920, height: 1080 },
      video,
    )
    expect(result.crop.width % 2).toBe(0)
    expect(result.crop.height % 2).toBe(0)
    expect(result.crop).toEqual({ x: 1001, y: 501, width: 332, height: 76 })
  })

  it('handles fractional selections without drifting', () => {
    const result = rectToVideoCrop(
      { x: 10.25, y: 10.75, width: 100.5, height: 50.5 },
      { width: 1000, height: 500 },
      { width: 2000, height: 1000 },
    )
    // left 20.5 -> 21, right 221.5 -> 222, top 21.5 -> 22, bottom 122.5 -> 123
    expect(result.crop).toEqual({ x: 21, y: 22, width: 200, height: 100 })
  })

  it('keeps a selection on the far edge inside the frame', () => {
    const video = { width: 3024, height: 1964 }
    const result = rectToVideoCrop(
      { x: 1511.6, y: 981.6, width: 0.4, height: 0.4 },
      { width: 1512, height: 982 },
      video,
    )
    expect(result.crop.x + result.crop.width).toBeLessThanOrEqual(video.width)
    expect(result.crop.y + result.crop.height).toBeLessThanOrEqual(video.height)
    expect(result.crop.width).toBe(2)
    expect(result.crop.height).toBe(2)
  })

  it('covers the whole frame for a full-display selection', () => {
    const result = rectToVideoCrop(
      { x: 0, y: 0, width: 1512, height: 982 },
      { width: 1512, height: 982 },
      { width: 3024, height: 1964 },
    )
    expect(result.crop).toEqual({ x: 0, y: 0, width: 3024, height: 1964 })
  })

  it('rejects impossible sizes', () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 }
    expect(() =>
      rectToVideoCrop(rect, { width: 0, height: 10 }, { width: 10, height: 10 }),
    ).toThrow()
    expect(() =>
      rectToVideoCrop(rect, { width: 10, height: 10 }, { width: 1, height: 10 }),
    ).toThrow()
  })
})

describe('expandRect and rectsIntersect', () => {
  it('grows outward on all sides', () => {
    expect(expandRect({ x: 10, y: 10, width: 20, height: 20 }, 2)).toEqual({
      x: 8,
      y: 8,
      width: 24,
      height: 24,
    })
  })

  it('treats touching rects as not intersecting', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 }
    expect(rectsIntersect(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false)
    expect(rectsIntersect(a, { x: 9, y: 9, width: 10, height: 10 })).toBe(true)
  })
})

describe('placeOutside', () => {
  const viewport = { width: 1000, height: 800 }
  const box = { width: 120, height: 32 }

  it('prefers below the region, left-aligned', () => {
    const region = { x: 200, y: 200, width: 300, height: 100 }
    expect(placeOutside(region, box, viewport, 8)).toEqual({ x: 200, y: 308 })
  })

  it('goes above when there is no room below', () => {
    const region = { x: 200, y: 600, width: 300, height: 190 }
    expect(placeOutside(region, box, viewport, 8)).toEqual({ x: 200, y: 560 })
  })

  it('goes to the side for a full-height region', () => {
    const region = { x: 200, y: 0, width: 300, height: 800 }
    expect(placeOutside(region, box, viewport, 8)).toEqual({ x: 508, y: 0 })
    const rightEdge = { x: 700, y: 0, width: 300, height: 800 }
    expect(placeOutside(rightEdge, box, viewport, 8)).toEqual({ x: 572, y: 0 })
  })

  it('never overlaps the region and stays in the viewport', () => {
    const region = { x: 950, y: 100, width: 50, height: 50 }
    const point = placeOutside(region, box, viewport, 8)
    expect(point).not.toBeNull()
    if (!point) return
    expect(rectsIntersect({ ...point, ...box }, region)).toBe(false)
    expect(point.x + box.width).toBeLessThanOrEqual(viewport.width)
  })

  it('returns null for a full-screen region', () => {
    expect(placeOutside({ x: 0, y: 0, ...viewport }, box, viewport, 8)).toBeNull()
  })
})
