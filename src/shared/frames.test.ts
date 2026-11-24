import { describe, expect, it } from 'vitest'
import { DEFAULT_SELECTION, frameDifferences, selectFrames, splitFrames, thinToFit } from './frames'

const frame = (...values: number[]) => new Uint8Array(values)

describe('frameDifferences', () => {
  it('is the mean absolute pixel difference between neighbours', () => {
    expect(frameDifferences([frame(0, 0), frame(10, 0), frame(10, 4)])).toEqual([5, 2])
  })

  it('rejects frames of different sizes', () => {
    expect(() => frameDifferences([frame(0), frame(0, 0)])).toThrow()
  })
})

describe('splitFrames', () => {
  it('splits concatenated frames and drops a partial tail', () => {
    expect(splitFrames(frame(1, 2, 3, 4, 5), 2)).toEqual([frame(1, 2), frame(3, 4)])
  })
})

/** Diffs for `frames` frames that move only between the given frame indices (inclusive). */
function motion(frames: number, ...ranges: [number, number][]): number[] {
  return Array.from({ length: frames - 1 }, (_, i) =>
    ranges.some(([from, to]) => i + 1 >= from && i + 1 <= to) ? 20 : 0.3,
  )
}

describe('selectFrames', () => {
  it('keeps one middle frame of a still', () => {
    expect(selectFrames(50, motion(50))).toEqual({ isStill: true, indices: [24] })
  })

  it('treats compression noise as still', () => {
    expect(selectFrames(10, Array(9).fill(0.9)).isStill).toBe(true)
  })

  it('keeps the rest states and samples the motion between them', () => {
    // Rest 0–19, moves 20–29, rests 30–49.
    const { isStill, indices } = selectFrames(50, motion(50, [20, 29]))
    expect(isStill).toBe(false)
    expect(indices).toContain(19) // the state it moved from
    expect(indices).toContain(29) // where the motion ends
    expect(indices.filter((i) => i >= 20 && i <= 29).length).toBeGreaterThanOrEqual(5)
    expect(indices.length).toBeLessThanOrEqual(DEFAULT_SELECTION.budget)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  it('merges a short pause into the motion around it', () => {
    // The 15–16 pause is not treated as its own resting state.
    expect(selectFrames(40, motion(40, [10, 14], [17, 22]))).toEqual(
      selectFrames(40, motion(40, [10, 22])),
    )
  })

  it('never exceeds the budget, however many stretches there are', () => {
    const ranges: [number, number][] = Array.from({ length: 12 }, (_, i) => [i * 8 + 2, i * 8 + 4])
    const { indices } = selectFrames(100, motion(100, ...ranges), { ...DEFAULT_SELECTION, budget: 6 })
    expect(indices.length).toBeLessThanOrEqual(6)
    expect(new Set(indices).size).toBe(indices.length)
  })

  it('handles an empty clip', () => {
    expect(selectFrames(0, [])).toEqual({ isStill: true, indices: [] })
  })
})

describe('thinToFit', () => {
  it('keeps everything that fits', () => {
    expect(thinToFit([10, 10, 10], 30)).toEqual([0, 1, 2])
  })

  it('drops frames evenly, keeping the first and last', () => {
    const kept = thinToFit(Array(10).fill(10), 55)
    expect(kept.length).toBeLessThanOrEqual(5)
    expect(kept[0]).toBe(0)
    expect(kept.at(-1)).toBe(9)
  })
})
