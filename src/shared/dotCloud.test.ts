import { describe, expect, it } from 'vitest'
import { DOT_CLOUD_SCRIPT, READY_MS, STATUS_DIALS, trayStatus } from './dotCloud'

describe('trayStatus', () => {
  it('shows capturing over analyzing over ready, and ready only for a while', () => {
    expect(trayStatus({ capturing: true, analyzing: true, finishedAt: 0, now: 1 })).toBe('capturing')
    expect(trayStatus({ capturing: false, analyzing: true, finishedAt: 0, now: 1 })).toBe('analyzing')
    expect(trayStatus({ capturing: false, analyzing: false, finishedAt: 1000, now: 1000 + READY_MS - 1 })).toBe('ready')
    expect(trayStatus({ capturing: false, analyzing: false, finishedAt: 1000, now: 1000 + READY_MS })).toBe('idle')
    expect(trayStatus({ capturing: false, analyzing: false, finishedAt: null, now: 5 })).toBe('idle')
  })
})

describe('the drawing', () => {
  it('draws every status without error on a canvas-like context', () => {
    const calls: string[] = []
    const ctx = { globalAlpha: 1, beginPath: () => calls.push('path'), arc: () => undefined, fill: () => calls.push('fill') }
    const draw = new Function(`${DOT_CLOUD_SCRIPT}; return drawDotCloud`)() as (c: unknown, s: number, d: unknown, t: number) => void
    for (const dials of Object.values(STATUS_DIALS)) draw(ctx, 18, dials, 3.5)
    // 70 points always; flares and the ring add more for the busier statuses.
    expect(calls.filter((call) => call === 'fill').length).toBeGreaterThan(70 * 4)
  })
})
