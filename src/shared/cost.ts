/**
 * What analysis costs, from the tokens the API reported. Prices are US dollars per million
 * tokens, Anthropic's standard first-party rates as listed on 2026-11-03. Check them against
 * Anthropic's pricing page when they change; a model missing here has no cost rather than a
 * guessed one. Cached input is priced relative to input: writing a cache entry costs 1.25×,
 * reading one 0.1×.
 */

export const PRICES_PER_MILLION: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  // Prompts up to 100,000 tokens; gil's planning prompts stay well under that.
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  // Models the server-side fallback may answer with.
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
}

const CACHE_WRITE = 1.25
const CACHE_READ = 0.1

/** One call's tokens. Cached tokens are counted apart from `inputTokens`, as the API reports them. */
export interface CallTokens {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens?: number
  cacheReadTokens?: number
}

/** A running total over calls that may use different models. */
export interface Usage {
  /** Every input token, cached or not. */
  inputTokens: number
  outputTokens: number
  /** Null once any call was answered by a model gil has no price for. */
  costUsd: number | null
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }

/** Dollars for one call on `model`, or null if gil does not know the model's price. */
export function costUsd(model: string, tokens: CallTokens): number | null {
  const price = PRICES_PER_MILLION[model]
  if (!price) return null
  const input = tokens.inputTokens + (tokens.cacheWriteTokens ?? 0) * CACHE_WRITE + (tokens.cacheReadTokens ?? 0) * CACHE_READ
  return (input * price.input + tokens.outputTokens * price.output) / 1_000_000
}

/** One call as usage, priced at the model that answered. */
export function usageOf(model: string, tokens: CallTokens): Usage {
  const spent = tokens.inputTokens + tokens.outputTokens + (tokens.cacheWriteTokens ?? 0) + (tokens.cacheReadTokens ?? 0)
  return {
    inputTokens: tokens.inputTokens + (tokens.cacheWriteTokens ?? 0) + (tokens.cacheReadTokens ?? 0),
    outputTokens: tokens.outputTokens,
    // Nothing spent costs nothing, whatever the model.
    costUsd: spent === 0 ? 0 : costUsd(model, tokens),
  }
}

/** Adds usage totals; one unknown price makes the total unknown rather than wrong. */
export function addUsage(a: Usage | undefined, b: Usage): Usage {
  const before = a ?? NO_USAGE
  return {
    inputTokens: before.inputTokens + b.inputTokens,
    outputTokens: before.outputTokens + b.outputTokens,
    costUsd: before.costUsd === null || b.costUsd === null ? null : Math.round((before.costUsd + b.costUsd) * 10000) / 10000,
  }
}
