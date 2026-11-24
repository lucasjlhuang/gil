import { describe, expect, it } from 'vitest'
import { parseSpec } from './spec'
import { fontStack, typeSpecimenPage } from './typeSpecimen'

const spec = parseSpec(
  JSON.stringify({
    schemaVersion: 1,
    description: '',
    tokens: {
      colors: [{ name: 'ink', value: '#222222', role: 'text' }],
      typography: [
        { role: 'body', family: 'sans-serif', size: 16, weight: 400, letterSpacing: 0 },
        { role: 'heading', family: 'serif', size: 40, weight: 700, letterSpacing: -1 },
      ],
      radii: [],
      spacing: [],
      shadows: [],
      effects: [],
    },
    layout: '',
    motion: [],
    states: [],
    caveats: [],
  }),
)

describe('typeSpecimenPage', () => {
  it('shows each level largest first, with its values as custom properties', () => {
    const page = typeSpecimenPage(spec, 'Type <system>')
    expect(page.indexOf('--heading-size: 40px')).toBeLessThan(page.indexOf('--body-size: 16px'))
    expect(page).toContain('--ink: #222222')
    expect(page).toContain('Type &#60;system&#62;')
    expect(page).toContain('window.replay')
  })
})

describe('fontStack', () => {
  it('puts the recognised font first, then a generic family', () => {
    expect(fontStack('Inter', 'geometric sans')).toBe('"Inter", system-ui, -apple-system, sans-serif')
    expect(fontStack(null, 'old-style serif')).toBe('ui-serif, Georgia, serif')
    expect(fontStack(null, 'monospace')).toBe('ui-monospace, monospace')
  })
})

describe('specimen safety', () => {
  it('keeps odd values from breaking out of the stylesheet', () => {
    const hostile = parseSpec(JSON.stringify({ ...JSON.parse(JSON.stringify(spec)), schemaVersion: 2 }))
    hostile.tokens.colors[0]!.value = '#fff</style><script>alert(1)</script>'
    hostile.tokens.typography[0]!.fontName = 'Inter"; } body { color: red'
    const page = typeSpecimenPage(hostile, 'x')
    expect(page).not.toContain('<script>alert')
    expect(page).not.toMatch(/"Inter";/)
  })
})
