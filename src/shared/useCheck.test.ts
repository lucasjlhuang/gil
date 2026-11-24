import { describe, expect, it } from 'vitest'
import { activityOf, describeScroll, measureMotion, sameTimeline, scrollTimeline } from './motion'
import { compareUse, describeUseCheck, profileOf, quietMoments, type UseProfile } from './useCheck'

const SIZE = 32

/** Frames of a block that moves right between `from` and `to` (frame numbers), `speed` px a frame. */
function slide(frames: number, from: number, to: number, speed: number, shade = 0): Uint8Array[] {
  return Array.from({ length: frames }, (_, f) => {
    const frame = new Uint8Array(SIZE * SIZE).fill(255)
    const x = 2 + Math.max(0, Math.min(to, f) - from) * speed
    for (let y = 12; y < 20; y++) for (let dx = 0; dx < 6; dx++) frame[y * SIZE + Math.min(SIZE - 1, x + dx)] = shade
    return frame
  })
}

describe('compareUse', () => {
  const original = profileOf(slide(40, 10, 22, 2), SIZE, 30)

  it('passes a draft that moves the same way, whatever it looks like', () => {
    // Lower contrast: the same movement in grey instead of black.
    const draft = profileOf(slide(40, 10, 22, 2, 120), SIZE, 30)
    expect(compareUse(original, draft)).toEqual({ pass: true, gaps: [] })
  })

  it('names a movement that is too short and one that is missing', () => {
    const short = compareUse(original, profileOf(slide(40, 10, 14, 2), SIZE, 30))
    expect(short.pass).toBe(false)
    expect(short.gaps.join(' ')).toMatch(/lasts \d+ ms; in the original it lasts \d+ ms/)
    const still = compareUse(original, profileOf(slide(40, 0, 0, 0), SIZE, 30))
    expect(still.gaps[0]).toContain('Nothing moves in the draft')
  })

  it('says which movement is too weak beside the others, whatever the amounts', () => {
    const twice = profileOf([...slide(40, 10, 22, 2), ...slide(40, 10, 22, 2)], SIZE, 30)
    // Everything half as strong (less ink) is the same motion; only the second movement fainter is not.
    const fainter: UseProfile = { ...twice, activity: twice.activity.map((value) => value * 0.5) }
    expect(compareUse(twice, fainter).pass).toBe(true)
    const weak: UseProfile = { ...twice, activity: twice.activity.map((value, i) => (i >= 40 ? value * 0.2 : value)) }
    const check = compareUse(twice, weak)
    expect(check.pass).toBe(false)
    expect(check.gaps).toHaveLength(1)
    expect(check.gaps[0]).toContain('movement 2')
    expect(check.gaps[0]).toContain('20% as strong')
    expect(describeUseCheck(check, twice, weak, 2)).toContain('2 checks left')
    expect(describeUseCheck(check, twice, weak, 0)).toContain('last check')
  })

  it('compares larger movements when one version pauses briefly inside what the other does in one go', () => {
    // The same slide, held still for three frames in the middle.
    const whole = slide(40, 10, 22, 2)
    const paused = Array.from({ length: 43 }, (_, f) => whole[f < 16 ? f : Math.max(16, f - 3)] as Uint8Array)
    const draft = profileOf(paused, SIZE, 30)
    expect(draft.motion.segments.length).toBe(2)
    const check = compareUse(original, draft)
    expect(check.gaps[0]).toContain('separate movement')
    // Taken together the two halves are the original's movement, so nothing else is reported as missing.
    expect(check.gaps.some((gap) => gap.includes('Nothing moves'))).toBe(false)
  })

  it('stops at the count when movements cannot be paired, and does not pass motion the capture never had', () => {
    const twice = [...slide(40, 10, 22, 2), ...slide(40, 10, 22, 2)]
    const extra = compareUse(original, profileOf(twice, SIZE, 30))
    expect(extra.pass).toBe(false)
    expect(extra.gaps).toHaveLength(1)
    // A movement of the original the draft does not have is named.
    expect(compareUse(profileOf(twice, SIZE, 30), original).gaps[1]).toContain("the original's movement 2")
    const still = profileOf(slide(40, 0, 0, 0), SIZE, 30)
    expect(compareUse(still, original).pass).toBe(false)
    expect(compareUse(still, still).pass).toBe(true)
  })

  it('does not ask how it ends when the page scrolls behind the original', () => {
    const scrolled = { ...original, returns: null }
    expect(compareUse(scrolled, original).pass).toBe(true)
    expect(profileOf(slide(40, 10, 22, 2), SIZE, 30, 'y').returns).toBeNull()
  })
})

describe('quietMoments', () => {
  it('picks the middle of each still stretch, the longest first when there are too many', () => {
    const motion = profileOf([...slide(40, 10, 22, 2), ...slide(40, 10, 22, 2)], SIZE, 30).motion
    const moments = quietMoments(motion, 2667)
    expect(moments).toHaveLength(3)
    expect(moments[0]).toBeLessThan(motion.segments[0]?.startMs ?? 0)
    expect(moments[2]).toBeGreaterThan(motion.segments[1]?.endMs ?? 0)
    expect(quietMoments(motion, 2667, 1)).toHaveLength(1)
    expect(quietMoments({ fps: 30, segments: [] }, 1000)).toEqual([500])
  })
})

describe('page scrolling behind the thing', () => {
  /** Stripes scrolling down 3 px a frame between frames 5 and 25, behind a block that blinks at frames 12–15. */
  const frames = Array.from({ length: 34 }, (_, f) => {
    const frame = new Uint8Array(SIZE * SIZE)
    const scrolled = Math.max(0, Math.min(25, f) - 5) * 3
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) frame[y * SIZE + x] = ((y - scrolled + 6000) % 12 < 2 && x > 16) ? 60 : 255
    const shade = f >= 12 && f <= 15 ? 255 - (f - 11) * 50 : 255 - (f > 15 ? 200 : 0)
    for (let y = 10; y < 22; y++) for (let x = 2; x < 12; x++) frame[y * SIZE + x] = shade
    return frame
  })

  it('follows how far the page scrolled', () => {
    const timeline = scrollTimeline(frames, SIZE, 30, 'y')
    expect(timeline[0]).toEqual({ atMs: 0, px: 0 })
    // The stripes repeat every 12 px, so the exact distance is ambiguous here; that it moves, and only while it scrolls, is not.
    expect(Math.abs(timeline[timeline.length - 1]?.px ?? 0)).toBeGreaterThan(20)
    expect(timeline.find((point) => point.atMs === 100)?.px).toBe(0)
    expect(describeScroll(timeline, 2)).toContain('Measured scroll')
    expect(scrollTimeline(frames.map(() => frames[0] as Uint8Array), SIZE, 30, 'y')).toEqual([])
  })

  it('is part of the plain measurement and left out when the backdrop is known to scroll', () => {
    const raw = measureMotion(frames, SIZE, 30)
    const without = measureMotion(frames, SIZE, 30, undefined, 'y')
    expect(raw.segments[0]?.durationMs).toBeGreaterThan(500)
    expect(without.backdrop).toBe('y')
    expect(without.segments).toHaveLength(1)
    expect(without.segments[0]?.startMs).toBeGreaterThanOrEqual(333)
    expect(without.segments[0]?.endMs).toBeLessThanOrEqual(567)
    expect(sameTimeline(raw, without)).toBe(false)
    expect(sameTimeline(raw, raw)).toBe(true)
    // Nothing is invented where only the page moves.
    expect(Math.max(...activityOf(frames, SIZE, undefined, 'y').activity.slice(17, 24))).toBeLessThan(1)
  })
})
