import { describe, expect, it } from 'vitest'
import { catalogFromApi, closestWeight, findFamily, fontFileUrl } from './fontCatalog'

const api = [
  { id: 'inter', family: 'Inter', subsets: ['latin'], weights: [400, 700], styles: ['normal', 'italic'], category: 'sans-serif', type: 'google' },
  { id: 'noto-sans-jp', family: 'Noto Sans JP', subsets: ['japanese'], weights: [400], styles: ['normal'], category: 'sans-serif' },
  { id: 'BAD id', family: 'x' },
]

describe('fontCatalog', () => {
  it('keeps families with a Latin subset that parse', () => {
    expect(catalogFromApi(api).map((entry) => entry.id)).toEqual(['inter'])
    expect(() => catalogFromApi({})).toThrow()
  })

  it('finds a family by loose name, picks the nearest weight, and builds the file address', () => {
    const [inter] = catalogFromApi(api)
    expect(findFamily(catalogFromApi(api), 'inter ')?.id).toBe('inter')
    expect(closestWeight(inter!, 600)).toBe(700)
    expect(closestWeight(inter!, 500)).toBe(400)
    expect(fontFileUrl(inter!, 700, true)).toBe('https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-700-italic.woff2')
  })
})
