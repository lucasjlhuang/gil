import { describe, expect, it } from 'vitest'
import { recipeSchema, recipeToMarkdown, systemGuide } from './recipe'
import { specSchema, SPEC_SCHEMA_VERSION } from './spec'

const recipe = recipeSchema.parse({
  replay: [{ atMs: 500, trigger: 'hover in' }, { atMs: 1433.4, trigger: 'hover out' }],
  summary: 'A wordmark collapses into a monogram made from its first letter.',
  parts: [
    { name: 'lead letter', role: 'The first letter; it stays and turns into the mark.', slot: "the first letter of the user's name" },
    { name: 'backdrop', role: 'A plain colour behind everything.', slot: '' },
  ],
  steps: [{ part: 'rest of the wordmark', change: 'wipes out from right to left with a clip-path', trigger: 'on scroll down', startMs: 130, durationMs: 170.4, easing: 'linear' }],
  layout: ['Gap from wordmark to tagline: 9 px (0.4 × cap height).'],
  shapes: [{ name: 'mark', d: 'M0 0L1 0L1 1Z', note: 'The outer stems are kept.' }],
  technique: ['Draw the lead letter and the mark as SVG paths with the same commands, so the path can morph.'],
  adapt: ['Redraw the lead letter for the new name.'],
  keep: ['The order of the three moves.'],
})

describe('recipeToMarkdown', () => {
  it('writes parts with their slots, steps in order with timings, and the rules', () => {
    const md = recipeToMarkdown(recipe, { title: 'Wordmark collapse', name: 'wordmark-collapse' })
    expect(md).toContain("**lead letter**: The first letter; it stays and turns into the mark. Slot: the first letter of the user's name")
    expect(md).toContain('**backdrop**: A plain colour behind everything. Fixed.')
    expect(md).toContain('1. **rest of the wordmark** wipes out from right to left with a clip-path. Trigger: on scroll down. Starts 130 ms after it, lasts 170 ms, easing linear.')
    expect(md).toContain('## Layout\n\n- Gap from wordmark to tagline: 9 px (0.4 × cap height).')
    expect(md).toContain('- **mark**: The outer stems are kept.\n  `M0 0L1 0L1 1Z`')
    expect(md).toContain('## To apply it to new content\n\n- Redraw the lead letter for the new name.')
    expect(md).toContain('- 1433 ms: hover out')
  })

  it('leaves out the steps of a still', () => {
    expect(recipeToMarkdown({ ...recipe, replay: [] }, { title: 't', name: 'n' })).not.toContain('plays by itself')
    expect(recipeToMarkdown({ ...recipe, steps: [] }, { title: 't', name: 'n' })).not.toContain('## Steps')
  })
})

describe('systemGuide', () => {
  const measured = 'measured' as const
  const spec = specSchema.parse({
    schemaVersion: SPEC_SCHEMA_VERSION,
    description: '',
    tokens: {
      colors: [{ name: 'ink', value: '#111111', role: 'text', confidence: measured }],
      typography: [
        { level: 'body', role: 'running text', family: 'sans', fontName: 'Figtree', size: 14, lineHeight: 20, weight: 400, letterSpacing: 0, confidence: { family: measured, size: measured, lineHeight: measured, weight: measured, letterSpacing: measured } },
      ],
      radii: [],
      spacing: [],
      shadows: [],
      effects: [],
    },
    layout: { description: '', regions: [] },
    motion: [],
    states: [],
    caveats: [],
  })

  it('says how to apply a colour system, a type system and a font, and nothing for other kinds', () => {
    expect(systemGuide('color-system', spec)).toContain('- `#111111` ink: text')
    expect(systemGuide('type-system', spec)).toContain('- body (running text): 14px/20px, weight 400, Figtree')
    expect(systemGuide('font', spec)).toContain('Typeface: Figtree.')
    expect(systemGuide('font', spec)).toContain('check_use')
    expect(systemGuide('motion', spec)).toBe('')
    expect(systemGuide('color-system', { ...spec, tokens: { ...spec.tokens, colors: [] } })).toBe('')
  })
})
