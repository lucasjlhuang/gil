import { describe, expect, it } from 'vitest'
import { formatRun, gateText, totals, type BenchResult, type BenchRun } from './bench'

const result = (name: string, score: number | null, extra: Partial<BenchResult> = {}): BenchResult => ({
  name,
  score,
  frames: [],
  inputTokens: 1000,
  outputTokens: 100,
  costUsd: 0.5,
  seconds: 60,
  model: 'claude-opus-5-5',
  rounds: 2,
  error: score === null ? 'The clip has no frames' : null,
  ...extra,
})

const run = (startedAt: string, results: BenchResult[]): BenchRun => ({ startedAt, commit: 'abc1234', results })

describe('totals', () => {
  it('averages the scores of finished captures and adds up cost and time', () => {
    expect(totals(run('t', [result('a', 80), result('b', 90), result('c', null, { costUsd: null })]))).toEqual({
      score: 85,
      costUsd: 1,
      seconds: 180,
      failed: 1,
    })
  })
})

describe('formatRun', () => {
  it('shows each score next to its change since the previous run', () => {
    const text = formatRun(run('now', [result('hover-card', 82.5), result('still-button', 90)]), run('before', [result('hover-card', 80)]))
    expect(text).toMatch(/hover-card\s+82.5 \(\+2.5\)/)
    expect(text).toMatch(/still-button\s+90\s/)
    expect(text).toContain('average score 86.3 (+6.3)')
  })

  it('lists failures with their reason', () => {
    const text = formatRun(run('now', [result('broken', null)]), null)
    expect(text).toContain('no earlier run')
    expect(text).toContain('failed')
    expect(text).toContain('  The clip has no frames')
  })
})

describe('gateText', () => {
  it('says pass, or lists what failed', () => {
    expect(gateText({ pass: true, offsetPx: 0, timingWorstMs: 10, missing: 0, extra: 0 })).toBe('pass')
    expect(gateText({ pass: false, offsetPx: 3.2, timingWorstMs: 240, missing: 1, extra: 0 })).toBe(
      'fail: 1 movement missing, timing off 240 ms, placed 3.2 px off',
    )
    expect(gateText(undefined)).toBe('-')
  })
})
