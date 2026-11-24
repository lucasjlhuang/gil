import { describe, expect, it } from 'vitest'
import { specSchema, SPEC_SCHEMA_VERSION } from './spec'
import { checkedKinds, compareStyles, observedStylesSchema, parseCssColor } from './styleCheck'

const measured = 'measured' as const
const level = (name: string, size: number, weight: number) => ({
  level: name,
  role: name,
  family: 'sans',
  fontName: null,
  size,
  lineHeight: null,
  weight,
  letterSpacing: 0,
  confidence: { family: measured, size: measured, lineHeight: measured, weight: measured, letterSpacing: measured },
})
const spec = specSchema.parse({
  schemaVersion: SPEC_SCHEMA_VERSION,
  description: 'A card',
  tokens: {
    colors: [
      { name: 'surface', value: '#18181a', role: 'background', confidence: measured },
      { name: 'ink', value: 'rgb(226, 226, 226)', role: 'text', confidence: measured },
      { name: 'accent', value: '#de3f45', role: 'accent', confidence: measured },
    ],
    typography: [level('heading', 32, 700), level('body', 14, 400)],
    radii: [{ value: 8, confidence: measured }],
    spacing: [],
    shadows: [],
    effects: [],
  },
  layout: { description: '', regions: [] },
  motion: [],
  states: [],
  caveats: [],
})

describe('parseCssColor', () => {
  it('reads hex and rgb forms and leaves out what is nearly transparent', () => {
    expect(parseCssColor('#fff')).toEqual([255, 255, 255])
    expect(parseCssColor('#DE3F45')).toEqual([222, 63, 69])
    expect(parseCssColor('rgb(24, 24, 26)')).toEqual([24, 24, 26])
    expect(parseCssColor('rgba(24 24 26 / 80%)')).toEqual([24, 24, 26])
    expect(parseCssColor('rgba(0, 0, 0, 0.1)')).toBeNull()
    expect(parseCssColor('linear-gradient(red, blue)')).toBeNull()
  })
})

describe('compareStyles', () => {
  const inside = observedStylesSchema.parse({
    colors: [
      { value: 'rgb(24, 24, 26)', use: 'background', area: 9000 },
      { value: 'rgb(222, 63, 69)', use: 'background', area: 2000 },
      { value: 'rgb(228, 228, 228)', use: 'text', area: 500 },
    ],
    texts: [
      { sample: 'Welcome', fontFamily: 'Inter', fontSize: 32, fontWeight: 700, chars: 7 },
      { sample: 'Some body copy', fontFamily: 'Inter', fontSize: 14.5, fontWeight: 400, chars: 80 },
    ],
    radii: [{ value: 8, count: 3 }, { value: 9999, count: 1 }],
  })

  it('says nothing when the draft stays inside the asset', () => {
    expect(compareStyles(spec, inside)).toEqual([])
  })

  it('names colours, text sizes and radii that are not the asset\'s', () => {
    const gaps = compareStyles(spec, {
      colors: [...inside.colors, { value: 'rgb(37, 99, 235)', use: 'background', area: 4000 }, { value: 'rgb(25, 25, 27)', use: 'background', area: 10 }],
      texts: [...inside.texts, { sample: 'Fine print everywhere', fontFamily: 'Inter', fontSize: 11, fontWeight: 400, chars: 60 }],
      radii: [{ value: 8, count: 2 }, { value: 20, count: 4 }],
      overflow: [],
    })
    expect(gaps).toHaveLength(3)
    expect(gaps[0]).toContain('#2563eb')
    expect(gaps[0]).toContain('the nearest is')
    expect(gaps[1]).toContain('"Fine print everywhere" is set at 11px')
    expect(gaps[2]).toContain('20px')
  })

  it('names a typeface that is not the asset\'s, when the asset has one', () => {
    const named = { ...spec, tokens: { ...spec.tokens, typography: spec.tokens.typography.map((entry) => ({ ...entry, fontName: 'DM Sans' })) } }
    const text = (fontFamily: string) => ({ ...inside, texts: inside.texts.map((entry) => ({ ...entry, fontFamily })) })
    expect(compareStyles(named, text('"DM Sans", system-ui, sans-serif'))).toEqual([])
    const gaps = compareStyles(named, text('Helvetica Neue, Arial'))
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toContain('"Helvetica Neue"; the asset\'s typeface is DM Sans')
  })

  it('names text that is hard to read on what it sits on, whatever the asset', () => {
    const bare = { ...spec, tokens: { ...spec.tokens, colors: [], typography: [], radii: [] } }
    const pale = { sample: 'Save', fontFamily: 'Inter', fontSize: 14, fontWeight: 700, chars: 4, color: 'rgb(255, 255, 255)', behind: 'rgb(179, 156, 243)' }
    const gaps = compareStyles(bare, { colors: [], texts: [pale], radii: [], overflow: [] })
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toContain('#ffffff on #b39cf3')
    expect(compareStyles(bare, { colors: [], texts: [{ ...pale, color: 'rgb(17, 17, 17)' }], radii: [], overflow: [] })).toEqual([])
    expect(checkedKinds(spec)).toBe('colours, text sizes and corner radii')
    expect(checkedKinds(bare)).toBe('')
  })

  it('names what sticks out of the page or is cut off', () => {
    const bare = { ...spec, tokens: { ...spec.tokens, colors: [], typography: [], radii: [] } }
    const gaps = compareStyles(bare, { colors: [], texts: [], radii: [], overflow: [{ what: 'Send message', how: 'outside', px: 12 }, { what: 'A long label', how: 'clipped', px: 30 }] })
    expect(gaps[0]).toContain('"Send message" reaches 12px past the edge of the page')
    expect(gaps[1]).toContain('"A long label" is cut off by its own box')
  })

  it('names spaces off the asset\'s scale', () => {
    const scaled = { ...spec, tokens: { ...spec.tokens, colors: [], typography: [], radii: [], spacing: [8, 16, 24].map((value) => ({ value, confidence: measured })) } }
    const on = { colors: [], texts: [], radii: [], overflow: [], spaces: [{ value: 16, count: 10 }, { value: 8, count: 6 }, { value: 23.5, count: 2 }] }
    expect(compareStyles(scaled, on)).toEqual([])
    const gaps = compareStyles(scaled, { ...on, spaces: [...on.spaces, { value: 13, count: 5 }, { value: 30, count: 3 }] })
    expect(gaps[0]).toContain('not on the asset\'s spacing scale (8px, 16px, 24px): most often 13px, 30px')
    expect(checkedKinds(scaled)).toBe('spacing')
  })

  it('checks only the kinds of token the asset has', () => {
    const bare = { ...spec, tokens: { ...spec.tokens, colors: [], typography: [], radii: [] } }
    expect(compareStyles(bare, { colors: [{ value: '#00ff00', use: 'background', area: 1 }], texts: [], radii: [{ value: 3, count: 1 }], overflow: [] })).toEqual([])
  })
})
