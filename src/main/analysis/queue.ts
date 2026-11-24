import { Notification } from 'electron'
import { formatTimestamp, type Asset } from '../../shared/asset'
import { loadApiKey } from '../apiKey'
import { findAssetById, scanLibrary, updateAsset } from '../storage'
import { analyzeAsset, refineAsset } from './analyze'
import { applyColorLens } from '../colorLens'
import { ANALYSIS_MODEL } from './claude'

interface Job {
  id: string
  /** Set for Refine: the user's instruction. */
  instruction: string | null
}

/**
 * Background analysis, one asset at a time. Assets are queued by id, which survives the rename
 * analysis may do. The capture is always kept: a failed analysis marks the asset `failed` with
 * a readable reason and it can be analyzed again. A failed refinement keeps the recreation it
 * had and stays `ready`, with the reason in `analysis.error`. A refinement interrupted by
 * quitting is resumed as a full analysis, since the instruction is not saved.
 */
export class AnalysisQueue {
  private readonly pending: Job[] = []
  private running: Job | null = null

  constructor(
    private readonly deps: { libraryRoot: () => string; onChanged: () => void },
  ) {}

  /** Requeues assets left `analyzing` when gil last quit. */
  async resume(): Promise<void> {
    const { assets } = await scanLibrary(this.deps.libraryRoot())
    for (const asset of assets.reverse()) {
      if (asset.status === 'analyzing') this.pending.push({ id: asset.id, instruction: null })
    }
    void this.next()
  }

  isQueued(id: string): boolean {
    return this.running?.id === id || this.pending.some((job) => job.id === id)
  }

  /**
   * Marks an asset `analyzing` and queues it: a full analysis, or with an instruction, a
   * refinement of its current recreation.
   */
  async enqueue(id: string, instruction: string | null = null): Promise<void> {
    if (this.isQueued(id)) return
    const root = this.deps.libraryRoot()
    const asset = await findAssetById(root, id)
    if (!asset?.capture) return
    await updateAsset(root, asset.name, (current) => ({
      ...current,
      status: 'analyzing',
      updatedAt: formatTimestamp(new Date()),
    }))
    this.pending.push({ id, instruction })
    this.deps.onChanged()
    void this.next()
  }

  private async next(): Promise<void> {
    if (this.running) return
    const job = this.pending.shift()
    if (!job) return
    this.running = job
    const root = this.deps.libraryRoot()
    try {
      const asset = await findAssetById(root, job.id)
      if (asset) await this.analyze(root, asset, job.instruction)
    } catch (error) {
      console.error('Analysis bookkeeping failed', error)
    } finally {
      this.running = null
      this.deps.onChanged()
      void this.next()
    }
  }

  private async analyze(root: string, asset: Asset, instruction: string | null): Promise<void> {
    try {
      // A font asset is made by font identification from its source, not analyzed.
      if (asset.lens === 'font') throw new Error('Identify the font again from the original asset with Another Lens → Font')
      // The colour lens runs on the Mac with no model call, so it needs no key.
      if (asset.lens === 'color' && !instruction) {
        const saved = await applyColorLens(root, asset.name)
        notify(`${saved.title} is ready`, `Saved as ${saved.name}`)
        return
      }
      const apiKey = await loadApiKey()
      if (!apiKey) throw new Error('Add your Anthropic API key in Settings, then analyze again.')
      const result = instruction
        ? await refineAsset(root, asset.name, apiKey, instruction)
        : await analyzeAsset(root, asset.name, apiKey)
      console.log(
        `${instruction ? 'Refined' : 'Analyzed'} ${result.asset.name}: ${result.usage.inputTokens} input and ${result.usage.outputTokens} output tokens` +
          (result.differences.length ? `; still differs: ${result.differences.join(' | ')}` : ''),
      )
      notify(`${result.asset.title} is ready`, instruction ? 'Refined' : `Saved as ${result.asset.name}`)
    } catch (error) {
      const reason = describeError(error)
      console.error(`Analysis of ${asset.name} failed: ${reason}`)
      // The asset may have been renamed before the failure; look it up again.
      const current = (await findAssetById(root, asset.id)) ?? asset
      await updateAsset(root, current.name, (latest) =>
        instruction
          ? {
              ...latest,
              // A failed refinement keeps what the asset had.
              status: 'ready',
              analysis: { ...(latest.analysis ?? { model: ANALYSIS_MODEL, rounds: 0 }), error: `Refine failed: ${reason}` },
              updatedAt: formatTimestamp(new Date()),
            }
          : {
              ...latest,
              status: 'failed',
              analysis: { model: ANALYSIS_MODEL, rounds: 0, error: reason },
              updatedAt: formatTimestamp(new Date()),
            },
      )
      notify(`${instruction ? 'Refining' : 'Analysis of'} ${current.title} failed`, reason)
    }
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: unknown } | null)?.status
  if (status === 401) return 'The Anthropic API key was rejected. Check it in Settings.'
  if (status === 429) return 'The Anthropic API is rate limiting this key. Try again in a minute.'
  if (status === 529 || (typeof status === 'number' && status >= 500)) {
    return 'The Anthropic API is having problems. Try again later.'
  }
  return message.slice(0, 500)
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
}
