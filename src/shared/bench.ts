import { z } from 'zod'

/**
 * The benchmark: a fixed set of captures re-analyzed after every change to prompts or the
 * pipeline, so a change has to show it helps. A run's report is saved as JSON and printed as a
 * table next to the previous run. Pure; `main/bench.ts` does the running.
 */

export const benchResultSchema = z.object({
  /** The benchmark capture's name. */
  name: z.string(),
  /** 0–100, see shared/score.ts; null if the analysis failed. */
  score: z.number().nullable(),
  frames: z.array(z.object({ timestampMs: z.number(), score: z.number(), offsetPx: z.number().optional() })),
  /** The measurable parts of the accuracy gate; missing in runs from before it existed. */
  gate: z
    .object({
      pass: z.boolean(),
      offsetPx: z.number(),
      timingWorstMs: z.number().nullable(),
      missing: z.number(),
      extra: z.number(),
    })
    .nullable()
    .optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  /** Null when the model's price is unknown or nothing ran. */
  costUsd: z.number().nullable(),
  seconds: z.number(),
  model: z.string().nullable(),
  rounds: z.number().nullable(),
  error: z.string().nullable(),
})
export type BenchResult = z.infer<typeof benchResultSchema>

export const benchRunSchema = z.object({
  startedAt: z.string(),
  /** The build that ran, from git; `-dirty` if it had uncommitted changes. */
  commit: z.string(),
  results: z.array(benchResultSchema),
})
export type BenchRun = z.infer<typeof benchRunSchema>

export interface BenchTotals {
  /** Mean score of the captures that finished; null if none did. */
  score: number | null
  costUsd: number
  seconds: number
  failed: number
}

export function totals(run: BenchRun): BenchTotals {
  const scored = run.results.flatMap((result) => (result.score === null ? [] : [result.score]))
  return {
    score: scored.length ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10 : null,
    costUsd: run.results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0),
    seconds: run.results.reduce((sum, result) => sum + result.seconds, 0),
    failed: run.results.filter((result) => result.error !== null).length,
  }
}

function change(now: number | null, before: number | null | undefined): string {
  if (now === null || before === null || before === undefined) return ''
  const delta = Math.round((now - before) * 10) / 10
  return delta === 0 ? ' (=)' : ` (${delta > 0 ? '+' : ''}${delta})`
}

/** The gate as a few words: pass, or what failed. */
export function gateText(gate: BenchResult['gate']): string {
  if (!gate) return '-'
  if (gate.pass) return 'pass'
  const problems: string[] = []
  if (gate.missing) problems.push(`${gate.missing} movement${gate.missing > 1 ? 's' : ''} missing`)
  if (gate.extra) problems.push(`${gate.extra} extra`)
  if (gate.timingWorstMs !== null && gate.timingWorstMs > 67) problems.push(`timing off ${gate.timingWorstMs} ms`)
  if (gate.offsetPx > 2) problems.push(`placed ${gate.offsetPx} px off`)
  return `fail: ${problems.join(', ')}`
}

const money = (usd: number | null) => (usd === null ? '?' : `$${usd.toFixed(2)}`)
const pad = (text: string, width: number) => text.padEnd(width)

/** The run as a plain-text table, each score compared with the same capture in `previous`. */
export function formatRun(run: BenchRun, previous: BenchRun | null): string {
  const before = new Map(previous?.results.map((result) => [result.name, result]) ?? [])
  const nameWidth = Math.max(7, ...run.results.map((result) => result.name.length)) + 2
  const lines = [
    `gil benchmark, ${run.startedAt}, build ${run.commit}`,
    previous ? `compared with ${previous.startedAt}, build ${previous.commit}` : 'no earlier run to compare with',
    '',
    `${pad('capture', nameWidth)}${pad('score', 16)}${pad('cost', 10)}${pad('time', 9)}${pad('rounds', 8)}gate (±2 frames, ±2 px)`,
  ]
  for (const result of run.results) {
    const score = result.score === null ? 'failed' : `${result.score}${change(result.score, before.get(result.name)?.score)}`
    lines.push(
      `${pad(result.name, nameWidth)}${pad(score, 16)}${pad(money(result.costUsd), 10)}${pad(`${Math.round(result.seconds)}s`, 9)}${pad(String(result.rounds ?? '-'), 8)}${result.score === null ? '-' : gateText(result.gate)}`,
    )
    if (result.error) lines.push(`  ${result.error}`)
  }
  const now = totals(run)
  const then = previous ? totals(previous) : null
  lines.push(
    '',
    `gate passed by ${run.results.filter((result) => result.gate?.pass).length} of ${run.results.length}; the user still judges each recreation`,
    `average score ${now.score ?? '-'}${change(now.score, then?.score)}, total cost ${money(now.costUsd)}, total time ${Math.round(now.seconds)}s${now.failed ? `, ${now.failed} failed` : ''}`,
  )
  return lines.join('\n')
}
