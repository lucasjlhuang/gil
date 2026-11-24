import { describe, expect, it } from 'vitest'
import {
  isProvisionalName,
  normalizeTags,
  isValidSlug,
  MAX_SLUG_LENGTH,
  provisionalName,
  provisionalTitle,
  slugify,
  uniqueSlug,
} from './slug'

describe('isValidSlug', () => {
  it.each(['glass-nav-hover', 'a', 'card2', 'capture-20261013-180411'])('accepts %s', (name) => {
    expect(isValidSlug(name)).toBe(true)
  })

  it.each([
    '',
    'Glass-Nav',
    '2-up-grid',
    '-leading',
    'trailing-',
    'double--hyphen',
    'has space',
    'under_score',
    '../escape',
    'a'.repeat(MAX_SLUG_LENGTH + 1),
  ])('rejects %j', (name) => {
    expect(isValidSlug(name)).toBe(false)
  })

  it('accepts exactly the maximum length', () => {
    expect(isValidSlug('a'.repeat(MAX_SLUG_LENGTH))).toBe(true)
  })
})

describe('slugify', () => {
  it('converts free text', () => {
    expect(slugify('Glass Nav — Hover!')).toBe('glass-nav-hover')
    expect(slugify('  Café card  ')).toBe('cafe-card')
  })

  it('drops leading characters that cannot start a name', () => {
    expect(slugify('3D button')).toBe('d-button')
    expect(slugify('--soft lift')).toBe('soft-lift')
  })

  it('truncates without leaving a trailing hyphen', () => {
    const slug = slugify(`${'a'.repeat(MAX_SLUG_LENGTH - 1)} tail`)
    expect(slug).toBe('a'.repeat(MAX_SLUG_LENGTH - 1))
  })

  it('returns null when nothing usable remains', () => {
    expect(slugify('!!!')).toBeNull()
    expect(slugify('123')).toBeNull()
    expect(slugify('')).toBeNull()
  })
})

describe('provisional names', () => {
  const date = new Date(2026, 9, 3, 8, 4, 9)

  it('is a valid slug built from local time', () => {
    const name = provisionalName(date)
    expect(name).toBe('capture-20261003-080409')
    expect(isValidSlug(name)).toBe(true)
  })

  it('has a readable title', () => {
    expect(provisionalTitle(date)).toBe('Capture 2026-10-03 08:04:09')
  })
})

describe('uniqueSlug', () => {
  it('returns the base when free', () => {
    expect(uniqueSlug('card', new Set())).toBe('card')
  })

  it('appends the first free number', () => {
    expect(uniqueSlug('card', new Set(['card']))).toBe('card-2')
    expect(uniqueSlug('card', new Set(['card', 'card-2', 'card-3']))).toBe('card-4')
  })

  it('stays within the length limit', () => {
    const base = 'a'.repeat(MAX_SLUG_LENGTH)
    const result = uniqueSlug(base, new Set([base]))
    expect(result).toBe(`${'a'.repeat(MAX_SLUG_LENGTH - 2)}-2`)
    expect(isValidSlug(result)).toBe(true)
  })

  it('does not produce a double hyphen when trimming', () => {
    const base = `${'a'.repeat(MAX_SLUG_LENGTH - 3)}-bc`
    const result = uniqueSlug(base, new Set([base]))
    expect(isValidSlug(result)).toBe(true)
  })

  it('rejects an invalid base', () => {
    expect(() => uniqueSlug('Not Valid', new Set())).toThrow()
  })
})

describe('isProvisionalName', () => {
  it('recognises capture-time names, including taken ones', () => {
    expect(isProvisionalName('capture-20261013-180411')).toBe(true)
    expect(isProvisionalName('image-20261013-180411-2')).toBe(true)
    expect(isProvisionalName('capture-20261013-180411-2')).toBe(true)
    expect(isProvisionalName('glass-nav-hover')).toBe(false)
    expect(isProvisionalName('capture-card')).toBe(false)
  })
})

describe('normalizeTags', () => {
  it('trims, lowercases, drops a leading # and removes duplicates', () => {
    expect(normalizeTags([' Hover ', '#nav', 'hover', '', 'Glass  Morphism'])).toEqual([
      'hover',
      'nav',
      'glass morphism',
    ])
  })

  it('caps the count and length', () => {
    expect(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(20)
    expect(normalizeTags(['x'.repeat(100)])[0]).toHaveLength(40)
  })
})
