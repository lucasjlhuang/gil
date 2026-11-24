import { describe, expect, it } from 'vitest'
import { describeTraces, simplifyLoop, traceFrame, traceLoops, withoutBoxes } from './trace'

/** A white RGBA image with filled shapes from `inside(x, y)` returning a colour or null. */
function image(width: number, height: number, paint: (x: number, y: number) => [number, number, number] | null) {
  const data = new Uint8Array(width * height * 4).fill(255)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const colour = paint(x, y)
    if (colour) data.set([...colour, 255], (y * width + x) * 4)
  }
  return data
}

/** Points along a traced path: `steps` per segment (lines and cubic curves). */
function sample(d: string, steps: number): [number, number][] {
  const out: [number, number][] = []
  let at: [number, number] = [0, 0]
  for (const [, command, rest] of d.matchAll(/([MLC])([^MLCZ]*)/g)) {
    const n = (rest ?? '').trim().split(/[ ,]+/).map(Number)
    if (command === 'M' || command === 'L') {
      const to: [number, number] = [n[0] as number, n[1] as number]
      if (command === 'L') for (let k = 1; k < steps; k++) out.push([at[0] + ((to[0] - at[0]) * k) / steps, at[1] + ((to[1] - at[1]) * k) / steps])
      out.push(to)
      at = to
    } else {
      const [x1, y1, x2, y2, x, y] = n as [number, number, number, number, number, number]
      for (let k = 1; k <= steps; k++) {
        const t = k / steps
        const m = 1 - t
        out.push([m * m * m * at[0] + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x, m * m * m * at[1] + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y])
      }
      at = [x, y]
    }
  }
  return out
}

describe('traceLoops', () => {
  it('follows a rectangle and a hole as two closed loops', () => {
    const mask = new Uint8Array(10 * 10)
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) mask[y * 10 + x] = x >= 4 && x < 6 && y >= 4 && y < 6 ? 0 : 1
    const loops = traceLoops(mask, 10, 10).map((loop) => simplifyLoop(loop))
    expect(loops).toHaveLength(2)
    const sizes = loops.map((loop) => loop.length).sort()
    expect(sizes).toEqual([4, 4])
    const xs = loops.flat().map(([x]) => x)
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([2, 8])
  })
})

describe('traceFrame', () => {
  it('traces a square exactly, with sharp corners, in output units, with its colour', () => {
    const data = image(60, 40, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? [20, 20, 20] : null))
    const layers = traceFrame(data, 60, 40, { scale: 2 })
    expect(layers).toHaveLength(1)
    expect(layers[0]?.color).toBe('#141414')
    // Four straight edges that meet at the real corners.
    expect(layers[0]?.d).not.toContain('C')
    expect(layers[0]?.points).toBe(4)
    const corners = sample(layers[0]?.d ?? '', 1)
    for (const [x, y] of corners) {
      expect(Math.min(Math.abs(x - 5), Math.abs(x - 15))).toBeLessThan(0.05)
      expect(Math.min(Math.abs(y - 5), Math.abs(y - 15))).toBeLessThan(0.05)
    }
  })

  it('draws a circle as a few smooth curves within a pixel, and separates colours', () => {
    const data = image(120, 80, (x, y) => {
      if (Math.hypot(x + 0.5 - 40, y + 0.5 - 40) < 25) return [230, 57, 70]
      if (x >= 90 && x < 110 && y >= 30 && y < 50) return [20, 20, 20]
      return null
    })
    const layers = traceFrame(data, 120, 80, { scale: 1 })
    expect(layers.map((layer) => layer.color).sort()).toEqual(['#141414', '#e63946'])
    const circle = layers.find((layer) => layer.color === '#e63946')
    expect(circle?.d).toContain('C')
    expect(circle?.points).toBeLessThan(60)
    const radii = sample(circle?.d ?? '', 12).map(([x, y]) => Math.hypot(x - 40, y - 40))
    expect(Math.max(...radii)).toBeLessThan(26)
    expect(Math.min(...radii)).toBeGreaterThan(24)
  })

  it('uses soft edge pixels to place the outline inside a pixel', () => {
    // A disc of radius 20.3 drawn with anti-aliasing: each pixel is shaded by how much of it is covered.
    const covered = (x: number, y: number) => {
      let inside = 0
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (Math.hypot(x + (i + 0.5) / 4 - 32.4, y + (j + 0.5) / 4 - 31.7) < 20.3) inside++
      return inside / 16
    }
    const data = image(64, 64, (x, y) => {
      const share = covered(x, y)
      const v = Math.round(255 - share * 255)
      return share > 0 ? [v, v, v] : null
    })
    const layers = traceFrame(data, 64, 64, { scale: 1 })
    expect(layers).toHaveLength(1)
    const radii = sample(layers[0]?.d ?? '', 12).map(([x, y]) => Math.hypot(x - 32.4, y - 31.7))
    expect(Math.max(...radii)).toBeLessThan(20.3 + 0.4)
    expect(Math.min(...radii)).toBeGreaterThan(20.3 - 0.4)
  })

  it('returns nothing for a flat image or one that needs too many points', () => {
    expect(traceFrame(image(20, 20, () => null), 20, 20, { scale: 1 })).toEqual([])
    const noisy = image(80, 80, (x, y) => ((x * 7 + y * 13) % 5 < 2 ? [0, 0, 0] : null))
    expect(traceFrame(noisy, 80, 80, { scale: 1, maxPoints: 200 })).toEqual([])
  })
})

describe('describeTraces', () => {
  it('lists each traced frame with its state', () => {
    const text = describeTraces([
      { timestampMs: 400, state: 'rest', layers: [{ color: '#111111', d: 'M0 0L1 0L1 1Z', points: 3 }] },
      { timestampMs: 900, state: 'moving', layers: [] },
    ])
    expect(text).toContain('At 400 ms (at rest):\n  fill #111111: M0 0L1 0L1 1Z')
    expect(text).not.toContain('900 ms')
    expect(describeTraces([])).toBe('')
  })
})

describe('withoutBoxes', () => {
  it('drops the outlines inside a box and keeps the rest', () => {
    const frames = [{ timestampMs: 0, state: 'rest' as const, layers: [{ color: '#000000', d: 'M1 1L5 1L5 5ZM20 20L30 20C31 21 31 29 30 30Z', points: 6 }] }]
    const kept = withoutBoxes(frames, [{ x: 18, y: 18, width: 14, height: 14 }])
    expect(kept[0]?.layers[0]?.d).toBe('M1 1L5 1L5 5Z')
    expect(withoutBoxes(frames, [{ x: 0, y: 0, width: 40, height: 40 }])[0]?.layers).toEqual([])
    expect(withoutBoxes(frames, [])).toEqual(frames)
  })
})
