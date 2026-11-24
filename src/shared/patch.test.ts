import { describe, expect, it } from 'vitest'
import type { Motion, MotionSegment } from './motion'
import { median, regionDifferences, shapeAgreement, scaleTimeVars, shiftPage, timeFactor } from './patch'

describe('scaleTimeVars', () => {
  it('scales time custom properties and leaves everything else', () => {
    const css = ':root { --pill-duration: 200ms; --row-delay: 0.1s; --gap: 12px; --pill: #fff; --ease: cubic-bezier(.2,.8,.2,1); }\n.a { transition: opacity 300ms; }'
    const out = scaleTimeVars(css, 2.1)
    expect(out).toContain('--pill-duration: 420ms;')
    expect(out).toContain('--row-delay: 0.21s;')
    expect(out).toContain('--gap: 12px;')
    expect(out).toContain('transition: opacity 300ms;')
    expect(scaleTimeVars(css, Number.NaN)).toBe(css)
    expect(scaleTimeVars('<li style="--row-delay: 80ms">', 2)).toContain('--row-delay: 160ms"')
    expect(scaleTimeVars('--x-duration: 300ms !important;', 2)).toContain('600ms !important')
  })
})

describe('shiftPage', () => {
  it('adds one shift style, replacing an earlier one', () => {
    const once = shiftPage('<html><head></head><body></body></html>', 3, -2)
    expect(once).toContain('<style data-gil-fix>body{translate:3px -2px}</style>\n</head>')
    // A later shift is measured on top of the first, so they add up.
    const twice = shiftPage(once, 1, 0)
    expect(twice.match(/data-gil-fix/g)).toHaveLength(1)
    expect(twice).toContain('translate:4px -2px')
    expect(shiftPage(once, -3, 2)).not.toContain('data-gil-fix')
  })
})

const segment = (startMs: number, endMs: number): MotionSegment => ({
  startMs, endMs, durationMs: endMs - startMs, cutAtStart: false, cutAtEnd: false,
  bounds: { x: 0, y: 0, width: 1, height: 1 }, easing: null, stagger: null,
})
const motion = (...segments: MotionSegment[]): Motion => ({ fps: 30, segments })

describe('timeFactor', () => {
  it('finds that the recreation runs twice as fast', () => {
    expect(timeFactor(motion(segment(600, 1000), segment(1600, 2000)), motion(segment(300, 500), segment(800, 1000)))).toBeCloseTo(2, 1)
  })

  it('leaves agreeing times alone', () => {
    expect(timeFactor(motion(segment(600, 1000)), motion(segment(605, 1010)))).toBeNull()
    expect(timeFactor(motion(segment(600, 1000)), motion())).toBeNull()
  })
})

describe('median', () => {
  it('is the middle value', () => {
    expect(median([5, 1, 100])).toBe(5)
    expect(median([])).toBe(0)
  })
})

/** A white 120×120 image with dark squares of side 20 at the given corners. */
function image(...squares: [number, number][]) {
  const data = new Uint8Array(120 * 120).fill(255)
  for (const [left, top] of squares) for (let y = top; y < top + 20; y++) for (let x = left; x < left + 20; x++) data[y * 120 + x] = 20
  return { width: 120, height: 120, data }
}

describe('regionDifferences', () => {
  it('finds a part that is missing and one that is extra, and ignores what both have', () => {
    const found = regionDifferences(image([10, 10], [80, 80]), image([10, 10], [80, 10]))
    expect(found.map((d) => d.kind).sort()).toEqual(['extra', 'missing'])
    const missing = found.find((d) => d.kind === 'missing')
    // The square at (80, 80) of 120: somewhere past the middle on both axes.
    expect(missing?.x).toBeGreaterThan(0.5)
    expect(missing?.x).toBeLessThan(0.7)
    expect(missing?.y).toBeGreaterThan(0.5)
    expect(regionDifferences(image([10, 10]), image([12, 11]))).toEqual([])
  })
})

describe('shapeAgreement', () => {
  it('is high for the same shape a pixel off, and low when a stroke is somewhere else', () => {
    expect(shapeAgreement(image([10, 10], [60, 60]), image([11, 10], [60, 61]))).toBeGreaterThan(0.98)
    expect(shapeAgreement(image([10, 10], [60, 60]), image([10, 10], [60, 20]))).toBeLessThan(0.7)
    // Lined up by the given shift.
    expect(shapeAgreement(image([10, 10]), image([16, 10]), -6, 0)).toBe(1)
    expect(shapeAgreement(image(), image())).toBe(1)
  })
})
