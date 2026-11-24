import { describe, expect, it } from 'vitest'
import { activeRanges, bezierAt, connectedPatches, describeMotion, differencesFromMotion, framesForMotion, fillRepeatedFrames, fitEasing, focusFrom, focusedSize, measureMotion, progressPoints } from './motion'

const SIZE = 96
const FPS = 30

/** A black frame with white squares (side 16) at the given top-left corners. */
function frame(...squares: [number, number][]): Uint8Array {
  const data = new Uint8Array(SIZE * SIZE)
  for (const [left, top] of squares) {
    for (let y = Math.round(top); y < Math.round(top) + 16; y++) {
      for (let x = Math.round(left); x < Math.round(left) + 16; x++) {
        if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) data[y * SIZE + x] = 255
      }
    }
  }
  return data
}

/** Frame positions of a square moving from x=4 to x=76 between two frames, eased by `ease`. */
function slide(total: number, from: number, to: number, ease: (t: number) => number, y = 40): Uint8Array[] {
  return Array.from({ length: total }, (_, f) => {
    const t = Math.min(1, Math.max(0, (f - from) / (to - from)))
    return frame([4 + 72 * ease(t), y])
  })
}

describe('measureMotion', () => {
  it('finds no motion in a still clip', () => {
    const still = Array.from({ length: 20 }, () => frame([10, 10]))
    expect(measureMotion(still, SIZE, FPS).segments).toEqual([])
  })

  it('times a slide to within a frame and finds where it happens', () => {
    const motion = measureMotion(slide(60, 15, 45, (t) => t), SIZE, FPS)
    expect(motion.segments).toHaveLength(1)
    const [segment] = motion.segments
    expect(Math.abs((segment?.startMs ?? 0) - 500)).toBeLessThanOrEqual(34)
    expect(Math.abs((segment?.durationMs ?? 0) - 1000)).toBeLessThanOrEqual(67)
    expect(segment?.cutAtStart).toBe(false)
    expect(segment?.bounds.y).toBeGreaterThan(0.3)
    expect(segment?.bounds.height).toBeLessThan(0.4)
    expect(segment?.bounds.width).toBeGreaterThan(0.8)
  })

  it('tells an ease-in from an ease-out', () => {
    const easeIn = measureMotion(slide(60, 10, 50, (t) => t * t * t), SIZE, FPS).segments[0]?.easing
    const easeOut = measureMotion(slide(60, 10, 50, (t) => 1 - (1 - t) ** 3), SIZE, FPS).segments[0]?.easing
    expect(easeIn?.nearest).toBe('ease-in')
    expect(easeOut?.nearest).toMatch(/ease-out|ease/)
    // An ease-in is behind a straight line halfway through; an ease-out is ahead of it.
    expect(bezierAt(easeIn?.bezier ?? [0, 0, 1, 1], 0.5)).toBeLessThan(0.4)
    expect(bezierAt(easeOut?.bezier ?? [0, 0, 1, 1], 0.5)).toBeGreaterThan(0.6)
  })

  it('sees a stagger and its direction', () => {
    // Two squares drop down one after the other, left first.
    const frames = Array.from({ length: 50 }, (_, f) => {
      const drop = (start: number) => 4 + 60 * Math.min(1, Math.max(0, (f - start) / 15))
      return frame([8, drop(5)], [70, drop(14)])
    })
    const [segment] = measureMotion(frames, SIZE, FPS).segments
    expect(segment?.stagger?.direction).toBe('left-to-right')
    expect(segment?.stagger?.spreadMs).toBeGreaterThanOrEqual(200)
  })

  it('marks motion that was already under way when the clip started', () => {
    const [segment] = measureMotion(slide(40, -5, 25, (t) => t), SIZE, FPS).segments
    expect(segment?.cutAtStart).toBe(true)
  })
})

describe('fillRepeatedFrames', () => {
  it('fills a single repeated frame inside motion but not a real pause', () => {
    expect(fillRepeatedFrames([0, 4, 0, 6, 0, 0, 5], 1)).toEqual([0, 4, 5, 6, 0, 0, 5])
  })
})

describe('activeRanges', () => {
  it('merges short gaps and drops one-step blips', () => {
    expect(activeRanges([0, 5, 5, 0, 5, 0, 0, 0, 5, 0], 1, 1)).toEqual([[1, 4]])
  })
})

describe('fitEasing', () => {
  it('recovers a known curve', () => {
    const curve = [0.42, 0, 0.58, 1] as const
    const points = Array.from({ length: 21 }, (_, i): [number, number] => [i / 20, bezierAt(curve, i / 20)])
    const fit = fitEasing(points)
    expect(fit.nearest).toBe('ease-in-out')
    expect(fit.fitError).toBeLessThan(0.01)
  })
})

describe('progressPoints', () => {
  it('is the running total scaled to 0–1', () => {
    expect(progressPoints([1, 1, 2])).toEqual([[0, 0], [1 / 3, 0.25], [2 / 3, 0.5], [1, 1]])
  })
})

describe('describeMotion', () => {
  it('says nothing when nothing moved, and gives times, area and easing otherwise', () => {
    expect(describeMotion({ fps: 30, segments: [] }, 400, 200)).toBe('')
    const text = describeMotion(measureMotion(slide(60, 15, 45, (t) => t), SIZE, FPS), 400, 200)
    expect(text).toContain('±33 ms')
    expect(text).toMatch(/Motion 1: \d+–\d+ ms \(\d+ ms\)/)
    expect(text).toContain('cubic-bezier(')
  })
})

describe('connectedPatches', () => {
  it('groups touching cells, corners included', () => {
    // On a 4×4 grid: cells 0, 5 (diagonal neighbours) and 3, 7 (a column) are two patches.
    expect(connectedPatches([0, 5, 3, 7], 4).map((patch) => patch.sort((a, b) => a - b))).toEqual([[0, 5], [3, 7]])
  })

  it('does not call one moving thing a stagger', () => {
    const [segment] = measureMotion(slide(60, 15, 45, (t) => t), SIZE, FPS).segments
    expect(segment?.stagger).toBeNull()
  })
})

describe('withoutPointer', () => {
  it('ignores a small wandering patch when there is larger motion', () => {
    // A big square slides from frame 20 to 30; a small "pointer" (4×4) wanders the whole time.
    const frames = Array.from({ length: 50 }, (_, f) => {
      const data = frame([4 + 60 * Math.min(1, Math.max(0, (f - 20) / 10)), 40])
      const px = 10 + ((f * 3) % 70)
      for (let y = 5; y < 9; y++) for (let x = px; x < px + 4; x++) data[y * SIZE + x] = 255
      return data
    })
    const segments = measureMotion(frames, SIZE, FPS).segments
    expect(segments).toHaveLength(1)
    expect(Math.abs((segments[0]?.durationMs ?? 0) - 333)).toBeLessThanOrEqual(67)
  })

  it('keeps small motion when it is the only motion', () => {
    const frames = Array.from({ length: 30 }, (_, f) => {
      const data = new Uint8Array(SIZE * SIZE)
      const px = 10 + f * 2
      for (let y = 5; y < 9; y++) for (let x = px; x < px + 4; x++) data[y * SIZE + x] = 255
      return data
    })
    expect(measureMotion(frames, SIZE, FPS).segments.length).toBeGreaterThan(0)
  })
})

describe('differencesFromMotion', () => {
  it('marks frames inside measured movements as moving', () => {
    const motion = { fps: 30, segments: [{ startMs: 100, endMs: 200, durationMs: 100, cutAtStart: false, cutAtEnd: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, easing: null, stagger: null }] }
    // 20 fps: frames at 0, 50, 100, 150, 200, 250 ms; diffs[i] is the change into frame i + 1.
    expect(differencesFromMotion(motion, 6, 20)).toEqual([0, 0, 255, 255, 0])
  })

  it('does not miss a change shorter than the gap between samples', () => {
    const blink = { fps: 30, segments: [{ startMs: 60, endMs: 93, durationMs: 33, cutAtStart: false, cutAtEnd: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, easing: null, stagger: null }] }
    expect(differencesFromMotion(blink, 4, 20)).toEqual([0, 255, 0])
  })
})

describe('framesForMotion', () => {
  it('puts frames inside each movement, densest where the most changes, plus the resting states', () => {
    // An ease-out slide from frame 15 to 45 of 60 (30 fps): most of the change is early.
    const motion = measureMotion(slide(60, 15, 45, (t) => 1 - (1 - t) ** 3), SIZE, FPS)
    const frames = framesForMotion(motion, 60, FPS, 12) ?? []
    expect(frames.length).toBeLessThanOrEqual(12)
    const inside = frames.filter((f) => f >= 15 && f <= 45)
    const early = inside.filter((f) => f < 30).length
    expect(inside.length).toBeGreaterThanOrEqual(6)
    expect(early).toBeGreaterThan(inside.length - early)
    // The rest before and after the movement.
    expect(frames.some((f) => f < 14)).toBe(true)
    expect(frames.some((f) => f > 46)).toBe(true)
  })

  it('gives every movement at least two frames inside it, and falls back without progress times', () => {
    const frames = Array.from({ length: 90 }, (_, f) => frame([4 + 30 * Math.min(1, Math.max(0, (f - 10) / 4)) + 30 * Math.min(1, Math.max(0, (f - 60) / 20)), 40]))
    const motion = measureMotion(frames, SIZE, FPS)
    expect(motion.segments).toHaveLength(2)
    const picked = framesForMotion(motion, 90, FPS, 10) ?? []
    for (const segment of motion.segments) {
      const [from, to] = [(segment.startMs * FPS) / 1000, (segment.endMs * FPS) / 1000]
      expect(picked.filter((f) => f >= from - 1 && f <= to).length).toBeGreaterThanOrEqual(2)
    }
    const old = { fps: 30, segments: motion.segments.map((segment) => ({ ...segment, progressMs: undefined })) }
    expect(framesForMotion(old, 90, FPS, 10)).toBeNull()
  })
})

describe('focus on part of a capture', () => {
  const all = { fromMs: 0, toMs: 0, x: 0, y: 0, width: 1, height: 1 }

  it('is null for the whole capture and for answers that cannot be used', () => {
    expect(focusFrom(all, 5590)).toBeNull()
    expect(focusFrom({ ...all, fromMs: 100, toMs: 5500 }, 5590)).toBeNull()
    expect(focusFrom({ ...all, fromMs: 3000, toMs: 3100 }, 5590)).toBeNull()
    expect(focusFrom({ ...all, x: 0.02, y: 0.01, width: 0.97, height: 0.98 }, 5590)).toBeNull()
    expect(focusFrom({ ...all, x: Number.NaN }, 5590)).toBeNull()
    // A screenshot has no time to focus in.
    expect(focusFrom({ ...all, fromMs: 500, toMs: 900 }, 0)).toBeNull()
  })

  it('takes a span of time, an area, or both', () => {
    expect(focusFrom({ ...all, fromMs: 2400.4, toMs: 9999 }, 5590)).toEqual({ fromMs: 2400, toMs: 5590 })
    expect(focusFrom({ ...all, x: 0.5, y: 0, width: 0.7, height: 0.4 }, 5590)).toEqual({ fromMs: 0, toMs: 5590, box: { x: 0.5, y: 0, width: 0.5, height: 0.4 } })
    const both = focusFrom({ fromMs: 1000, toMs: 2000, x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 5590)
    expect(both).toEqual({ fromMs: 1000, toMs: 2000, box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } })
    expect(focusedSize({ width: 400, height: 200, durationMs: 5590 }, both as NonNullable<typeof both>)).toEqual({ width: 200, height: 100, durationMs: 1000 })
    expect(focusFrom({ ...all, x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, 0)).toEqual({ fromMs: 0, toMs: 0, box: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } })
  })
})
