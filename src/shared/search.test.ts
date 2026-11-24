import { describe, expect, it } from 'vitest'
import type { Asset } from './asset'
import { resolveAsset, searchAssets } from './search'

const asset = (name: string, extra: Partial<Asset> = {}) =>
  ({ name, title: name, aliases: [], tags: [], kind: 'component', summary: null, ...extra }) as Asset

describe('searchAssets', () => {
  const assets = [
    asset('red-hover-cta', { tags: ['button', 'hover'], summary: 'A red call to action' }),
    asset('glass-nav', { aliases: ['frosted bar'], kind: 'motion' }),
    asset('button-grid', { title: 'Grid of buttons' }),
  ]

  it('needs every word, and ranks names above summaries', () => {
    expect(searchAssets(assets, 'button').map((a) => a.name)).toEqual(['button-grid', 'red-hover-cta'])
    expect(searchAssets(assets, 'red hover').map((a) => a.name)).toEqual(['red-hover-cta'])
    expect(searchAssets(assets, 'frosted')).toHaveLength(1)
  })

  it('puts an exact name or alias first, and returns everything for an empty query', () => {
    expect(searchAssets(assets, 'frosted bar')[0]?.name).toBe('glass-nav')
    expect(searchAssets(assets, '')).toHaveLength(3)
  })
})

describe('resolveAsset', () => {
  it('finds by name or alias, ignoring case', () => {
    const assets = [asset('glass-nav', { aliases: ['Frosted Bar'] })]
    expect(resolveAsset(assets, 'GLASS-NAV')?.name).toBe('glass-nav')
    expect(resolveAsset(assets, 'frosted bar')?.name).toBe('glass-nav')
    expect(resolveAsset(assets, 'nope')).toBeNull()
  })
})
