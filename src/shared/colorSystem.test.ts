import { describe, expect, it } from 'vitest'
import { assignRoles, withAnalysisColors, colorSystemSpec, contrastPairs, swatchPage } from './colorSystem'
import type { PaletteColor } from './palette'
import { specSchema } from './spec'

const color = (hex: string, rgb: [number, number, number], share: number): PaletteColor => ({ hex, rgb, share })
const palette = [color('#ffffff', [255, 255, 255], 0.7), color('#e63946', [230, 57, 70], 0.2), color('#1d1d1f', [29, 29, 31], 0.08), color('#cccccc', [204, 204, 204], 0.02)]

describe('assignRoles', () => {
  it('names the background, the text, accents and neutrals', () => {
    expect(assignRoles(palette).map((role) => role.name)).toEqual(['background', 'accent-1', 'text', 'neutral-1'])
    expect(assignRoles([])).toEqual([])
  })
})

describe('colorSystemSpec', () => {
  it('is a valid spec with measured colours and contrast notes', () => {
    const spec = specSchema.parse(colorSystemSpec(assignRoles(palette), 'red-button'))
    expect(spec.tokens.colors.every((c) => c.confidence === 'measured')).toBe(true)
    expect(spec.caveats.some((caveat) => /^Contrast text on background: 1[67]\.\d:1 \(AAA\)/.test(caveat))).toBe(true)
    expect(contrastPairs(assignRoles(palette)).find((p) => p.a === 'neutral-1' && p.b === 'background')?.rating).toBe('fails')
  })
})

describe('swatchPage', () => {
  it('declares every colour on :root, escapes the title and defines replay', () => {
    const page = swatchPage(assignRoles(palette), 'Red <button>')
    expect(page).toContain('--accent-1: #e63946;')
    expect(page).toContain('Red &#60;button&#62;')
    expect(page).toContain('window.replay')
  })
})

describe('withAnalysisColors', () => {
  it('takes names and roles from the analysis and adds colours too small to measure', () => {
    const measured = assignRoles([
      { hex: '#fdfdfd', rgb: [253, 253, 253], share: 0.95 },
      { hex: '#edeafd', rgb: [237, 234, 253], share: 0.02 },
    ])
    const roles = withAnalysisColors(measured, [
      { name: 'surface', value: '#ffffff', role: 'card background' },
      { name: 'incoming-bubble', value: '#f0f1f6', role: 'received message bubble' },
      { name: 'outgoing-bubble', value: '#efe9fd', role: 'sent message bubble' },
      { name: 'text-strong', value: '#16161a', role: 'header name' },
      { name: 'surface', value: 'rgb(22, 22, 27)', role: 'duplicate of text' },
    ])
    expect(roles.map((role) => [role.name, role.color.hex, role.estimated === true])).toEqual([
      ['surface', '#fdfdfd', false],
      ['outgoing-bubble', '#edeafd', false],
      ['incoming-bubble', '#f0f1f6', true],
      ['text-strong', '#16161a', true],
    ])
    // The closest name wins a colour, whatever order the analysis listed them in.
    const spec = colorSystemSpec(roles, 'card')
    expect(spec.tokens.colors[3]).toMatchObject({ name: 'text-strong', confidence: 'estimated' })
    expect(spec.tokens.colors[0]?.role).toBe('card background, 95% of the capture')
  })
})
