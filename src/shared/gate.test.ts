import { describe, expect, it } from 'vitest'
import { bestShift, checkTiming, gateResult, toGray, type GrayImage } from './gate'
import type { Motion, MotionSegment } from './motion'

const segment = (startMs: number, endMs: number, extra: Partial<MotionSegment> = {}): MotionSegment => ({
  startMs,
  endMs,
  durationMs: endMs - startMs,
  cutAtStart: false,
  cutAtEnd: false,
  bounds: { x: 0, y: 0, width: 1, height: 1 },
  easing: null,
  stagger: null,
  ...extra,
})
const motion = (...segments: MotionSegment[]): Motion => ({ fps: 30, segments })

describe('checkTiming', () => {
  it('passes movements within two frames', () => {
    const check = checkTiming(motion(segment(500, 900), segment(1500, 1900)), motion(segment(533, 867), segment(1467, 1933)))
    expect(check.pass).toBe(true)
    expect(check.worstMs).toBe(33)
  })

  it('fails a movement that is too long, and names how far off it is', () => {
    const check = checkTiming(motion(segment(655, 1090)), motion(segment(650, 850)))
    expect(check.pass).toBe(false)
    expect(check.steps[0]?.endOffMs).toBe(-240)
  })

  it('counts missing and extra movements', () => {
    const check = checkTiming(motion(segment(0, 300), segment(1000, 1300)), motion(segment(0, 300), segment(2000, 2300)))
    expect(check.missing).toBe(1)
    expect(check.extra).toBe(1)
    expect(check.pass).toBe(false)
  })

  it('does not compare an end the clip cut off', () => {
    const check = checkTiming(motion(segment(1000, 2000, { cutAtEnd: true })), motion(segment(1000, 1400)))
    expect(check.pass).toBe(true)
  })
})

/** A gray image with a bright 6×6 square at (left, top). */
function square(left: number, top: number): GrayImage {
  const data = new Uint8Array(40 * 30)
  for (let y = top; y < top + 6; y++) for (let x = left; x < left + 6; x++) data[y * 40 + x] = 255
  return { width: 40, height: 30, data }
}

describe('bestShift', () => {
  it('finds how far a shape has moved', () => {
    expect(bestShift(square(10, 10), square(13, 6), 6)).toMatchObject({ dx: -3, dy: 4, distance: 5 })
  })

  it('is zero for identical images', () => {
    expect(bestShift(square(10, 10), square(10, 10), 4).distance).toBe(0)
  })
})

describe('toGray', () => {
  it('averages the colour channels and ignores alpha', () => {
    expect(toGray(1, 1, new Uint8Array([30, 60, 90, 0])).data[0]).toBe(60)
  })
})

describe('gateResult', () => {
  it('needs both timing and placement to pass', () => {
    const goodTiming = checkTiming(motion(segment(0, 300)), motion(segment(0, 300)))
    expect(gateResult(goodTiming, 1).pass).toBe(true)
    expect(gateResult(goodTiming, 3).pass).toBe(false)
    expect(gateResult(null, 2).pass).toBe(true)
  })
})
