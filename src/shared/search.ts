import type { Asset } from './asset'

/**
 * Library search, shared by the library window and the MCP server. Pure. Every word of the
 * query must appear somewhere in the asset (name, aliases, title, tags, kind or summary); the
 * results are ordered by where the words matched, an exact name or alias first.
 */

const normalize = (text: string) => text.toLowerCase().replace(/[-_]+/g, ' ').trim()

function scoreOf(asset: Asset, query: string): number {
  const q = normalize(query)
  if (!q) return 1
  const name = normalize(asset.name)
  const aliases = asset.aliases.map(normalize)
  if (name === q || aliases.includes(q)) return 100
  const fields: [string, number][] = [
    [name, 8],
    ...aliases.map((alias): [string, number] => [alias, 8]),
    [normalize(asset.title), 5],
    ...asset.tags.map((tag): [string, number] => [normalize(tag), 4]),
    [asset.kind, 3],
    [normalize(asset.summary ?? ''), 1],
  ]
  let total = 0
  for (const word of q.split(/\s+/)) {
    const best = Math.max(0, ...fields.filter(([text]) => text.includes(word)).map(([, weight]) => weight))
    if (best === 0) return 0
    total += best
  }
  return total
}

/** Assets matching `query`, best first; all of them, newest first, for an empty query. */
export function searchAssets(assets: readonly Asset[], query: string): Asset[] {
  return assets
    .map((asset, order) => ({ asset, order, score: scoreOf(asset, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.asset)
}

/** The asset a user means by `name`: its name, or one of its aliases (any case). */
export function resolveAsset(assets: readonly Asset[], name: string): Asset | null {
  const wanted = name.trim().toLowerCase()
  return (
    assets.find((asset) => asset.name === wanted) ??
    assets.find((asset) => asset.aliases.some((alias) => alias.toLowerCase() === wanted)) ??
    null
  )
}
