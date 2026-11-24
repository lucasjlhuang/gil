import { describe, expect, it } from 'vitest'
import { addUsage, costUsd, usageOf } from './cost'

describe('costUsd', () => {
  it('prices input and output tokens separately', () => {
    expect(costUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(6)
  })

  it('prices cache writes above input and cache reads far below', () => {
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 })).toBeCloseTo(2.5)
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.2)
  })

  it('has no cost for a model it does not know', () => {
    expect(costUsd('some-future-model', { inputTokens: 10, outputTokens: 10 })).toBeNull()
  })
})

describe('usage totals', () => {
  it('adds calls on different models, each at its own price', () => {
    const plan = usageOf('claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 0 })
    const build = usageOf('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 })
    expect(addUsage(plan, build)).toEqual({ inputTokens: 2_000_000, outputTokens: 100_000, costUsd: 6.1 })
  })

  it('counts cached tokens as input, and an unknown price makes the total unknown', () => {
    expect(usageOf('claude-opus-5-5', { inputTokens: 10, outputTokens: 0, cacheReadTokens: 90 }).inputTokens).toBe(100)
    expect(addUsage(usageOf('mystery', { inputTokens: 1, outputTokens: 1 }), usageOf('claude-opus-5-5', { inputTokens: 1, outputTokens: 1 })).costUsd).toBeNull()
    expect(usageOf('mystery', { inputTokens: 0, outputTokens: 0 }).costUsd).toBe(0)
  })
})
