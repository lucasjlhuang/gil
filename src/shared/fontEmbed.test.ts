import { describe, expect, it } from 'vitest'
import { describeFittedTexts, embedFontData, embeddedFontData, embeddedFontKeys, fitText, fontKeysIn, stripFontData } from './fontEmbed'

describe('font placeholders', () => {
  const html = `<style>@font-face{font-family:"dm-sans-400-normal";src:url(gil-font:dm-sans-400-normal) format("woff2")}
@font-face{font-family:x;src:url("gil-font:archivo-800-normal")}</style><p>Hi</p>`

  it('finds, embeds and strips fonts, and the round trip gives the placeholders back', () => {
    expect(fontKeysIn(html)).toEqual(['dm-sans-400-normal', 'archivo-800-normal'])
    const embedded = embedFontData(html, new Map([['dm-sans-400-normal', 'AAAA'], ['archivo-800-normal', 'BB+/=']]))
    expect(embedded).toContain('url("data:font/woff2;gil=dm-sans-400-normal;base64,AAAA") format("woff2")')
    expect(embedded).not.toContain('gil-font:')
    expect(embeddedFontKeys(embedded)).toEqual(['dm-sans-400-normal', 'archivo-800-normal'])
    // What was embedded can be put back without any other source.
    expect(embedFontData(stripFontData(embedded), embeddedFontData(embedded))).toBe(embedded)
    expect(stripFontData(embedded)).toBe(html.replace('url("gil-font:archivo-800-normal")', 'url(gil-font:archivo-800-normal)'))
  })

  it('leaves a placeholder whose font is not at hand, and never reads a path as a key', () => {
    expect(embedFontData(html, new Map())).toBe(html)
    expect(fontKeysIn('src:url(gil-font:../../secret)')).toEqual([])
  })
})

describe('fitText', () => {
  it('sizes by height, spaces by the width left over, and places the element so the ink lands', () => {
    // At 100 px the sample's ink is 200 × 50, starting 4 px in and 20 px down.
    const fit = fitText('ABCDE', 100, { x: 4, y: 20, width: 200, height: 50 }, { x: 30, y: 10, width: 110, height: 25 })
    expect(fit).toEqual({ fontSize: 50, letterSpacing: 2.5, left: 28, top: 0 })
    // With the size given, spacing takes up the width and the ink is centred vertically.
    expect(fitText('ABCDE', 100, { x: 4, y: 20, width: 200, height: 50 }, { x: 30, y: 10, width: 110, height: 25 }, 40)).toEqual({ fontSize: 40, letterSpacing: 7.5, left: 28.4, top: 4.5 })
    expect(fitText('A', 100, { x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 1, height: 1 })).toBeNull()
  })
})

describe('describeFittedTexts', () => {
  it('gives the exact CSS for each text', () => {
    const text = describeFittedTexts([
      { text: 'Team', family: 'DM Sans', weight: 400, italic: false, key: 'dm-sans-400-normal', score: 71.2, fontSize: 11.8, letterSpacing: 0.1, left: 152, top: 27.3, ink: { x: 152.4, y: 29, width: 30, height: 8.4 } },
    ])
    expect(text).toContain('url(gil-font:dm-sans-400-normal) format("woff2")')
    expect(text).toContain('font: 400 11.8px/1 "dm-sans-400-normal"; letter-spacing: 0.1px')
    expect(describeFittedTexts([])).toBe('')
  })
})
