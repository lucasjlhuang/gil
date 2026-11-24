import { describe, expect, it } from 'vitest'
import { glossaryText, normalizeTerms, parseGlossary, readGlossaryText } from './glossary'

describe('normalizeTerms', () => {
  it('refuses half-filled, too long or too many rows', () => {
    expect(() => normalizeTerms([{ term: '', meaning: 'nothing' }])).toThrow(/both a term and a meaning/)
    expect(() => normalizeTerms([{ term: 'x'.repeat(81), meaning: 'm' }])).toThrow(/too long/)
    expect(() => normalizeTerms(Array.from({ length: 501 }, (_, i) => ({ term: `t${i}`, meaning: 'm' })))).toThrow(/500/)
  })

  it('drops empty rows, keeps one entry per term and sorts', () => {
    expect(
      normalizeTerms([
        { term: ' pill ', meaning: 'old' },
        { term: '', meaning: '' },
        { term: 'Chip', meaning: 'small label' },
        { term: 'PILL', meaning: 'rounded nav highlight' },
      ]),
    ).toEqual([
      { term: 'Chip', meaning: 'small label' },
      { term: 'PILL', meaning: 'rounded nav highlight' },
    ])
  })
})

describe('parseGlossary', () => {
  it('treats a missing or broken file as empty', () => {
    expect(parseGlossary(null).terms).toEqual([])
    expect(parseGlossary('{nope').terms).toEqual([])
    expect(readGlossaryText('{nope')).toBeNull()
    expect(readGlossaryText(null)?.terms).toEqual([])
    expect(parseGlossary('{"version":1,"terms":[{"term":"a","meaning":"b"}]}').terms).toHaveLength(1)
  })
})

describe('glossaryText', () => {
  it('lists the terms for an AI tool', () => {
    expect(glossaryText({ version: 1, terms: [{ term: 'chip', meaning: 'small label' }] })).toContain('- chip: small label')
    expect(glossaryText({ version: 1, terms: [] })).toMatch(/not added any terms/)
  })
})
