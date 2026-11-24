import { describe, expect, it } from 'vitest'
import { applyCorrection, correctedHtml, migrateSpec, parseSpec, specSchema, specToMarkdown } from './spec'

const version1 = {
  schemaVersion: 1,
  description: 'A frosted pill.',
  tokens: {
    colors: [{ name: 'pill', value: 'rgba(255,255,255,0.12)', role: 'surface' }],
    typography: [{ role: 'link', family: 'sans-serif, geometric', size: 14, weight: 500, letterSpacing: 0 }],
    radii: [999],
    spacing: [8, 16],
    shadows: ['0 1px 2px black'],
    effects: [{ type: 'backdrop-blur', value: '12px' }],
  },
  layout: 'Horizontal row, 24px gap.',
  motion: [],
  states: ['default'],
  caveats: [],
  future: true,
}

describe('migrateSpec', () => {
  it('upgrades a version 1 spec, marking its values estimated and keeping unknown fields', () => {
    const spec = specSchema.parse(migrateSpec(version1))
    expect(spec.schemaVersion).toBe(2)
    expect(spec.tokens.colors[0]?.confidence).toBe('estimated')
    expect(spec.tokens.typography[0]).toMatchObject({ level: 'link', fontName: null, lineHeight: null })
    expect(spec.tokens.radii).toEqual([{ value: 999, confidence: 'estimated' }])
    expect(spec.tokens.shadows[0]).toEqual({ value: '0 1px 2px black', confidence: 'estimated' })
    expect(spec.layout).toEqual({ description: 'Horizontal row, 24px gap.', regions: [] })
    expect((spec as Record<string, unknown>).future).toBe(true)
  })

  it('leaves a current spec alone', () => {
    const current = migrateSpec(version1)
    expect(migrateSpec(current)).toBe(current)
    expect(parseSpec(JSON.stringify(version1)).schemaVersion).toBe(2)
  })
})

describe('specToMarkdown', () => {
  it('marks every value measured or estimated and lists layout regions', () => {
    const spec = parseSpec(JSON.stringify(version1))
    spec.tokens.typography[0]!.confidence.size = 'measured'
    spec.layout.regions.push({ name: 'nav', role: 'navigation', parent: null, x: 0, y: 0, width: 640, height: 96, direction: 'row', gap: 24, align: 'center', confidence: 'estimated' })
    const md = specToMarkdown(spec, { title: 'Glass nav', name: 'glass-nav' })
    expect(md).toContain('size 14px (measured)')
    expect(md).toContain('`pill`: rgba(255,255,255,0.12) (surface) (estimated)')
    expect(md).toContain('Radii: 999px (estimated)')
    expect(md).toContain('nav (navigation): 640×96px at 0, 0; children row, gap 24px, aligned center (estimated)')
  })
})

describe('correction edits', () => {
  it('applies exact, unique edits in order, and refuses anything else', () => {
    expect(applyCorrection('a{x:1}b{x:2}', [{ find: 'a{x:1}', replace: 'a{x:9}' }])).toBe('a{x:9}b{x:2}')
    expect(applyCorrection('x:1 x:1', [{ find: 'x:1', replace: 'x:2' }])).toBeNull()
    expect(applyCorrection('abc', [{ find: 'zzz', replace: '' }])).toBeNull()
    expect(correctedHtml('abc', { edits: [{ find: 'b', replace: 'B' }], html: '' })).toBe('aBc')
    expect(correctedHtml('abc', { edits: [], html: '<p>new</p>' })).toBe('<p>new</p>')
    expect(correctedHtml('abc', { edits: [{ find: 'q', replace: '' }], html: '' })).toBe('')
  })
})
