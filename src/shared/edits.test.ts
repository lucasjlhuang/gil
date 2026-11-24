import { describe, expect, it } from 'vitest'
import {
  applyEdits,
  compileEdits,
  editsSchema,
  hasEdits,
  isSafeValue,
  NO_EDITS,
  parseRootVars,
  splitRecreation,
  varKind,
} from './edits'

const BASE = `<!doctype html><html><head><style>
:root { --pill-duration: 320ms; --pill-ease: cubic-bezier(0.2, 0.8, 0.2, 1); --pill: rgba(255,255,255,0.12); }
/* :root { --ignored: 1px; } */
.pill { transition: transform var(--pill-duration) var(--pill-ease); }
</style></head><body><nav><a>One</a></nav><script>window.replay = () => {}</script></body></html>`

describe('parseRootVars', () => {
  it('finds the custom properties on :root and classifies them', () => {
    expect(parseRootVars(BASE)).toEqual([
      { name: '--pill-duration', value: '320ms', kind: 'duration' },
      { name: '--pill-ease', value: 'cubic-bezier(0.2, 0.8, 0.2, 1)', kind: 'easing' },
      { name: '--pill', value: 'rgba(255,255,255,0.12)', kind: 'color' },
    ])
  })
})

describe('varKind', () => {
  it.each([
    ['0.4s', 'duration'],
    ['ease-in-out', 'easing'],
    ['steps(4)', 'easing'],
    ['#fff', 'color'],
    ['12px', 'length'],
    ['1.5', 'number'],
    ['Inter, sans-serif', 'text'],
  ])('%s is %s', (value, kind) => {
    expect(varKind(value)).toBe(kind)
  })
})

describe('compileEdits and applyEdits', () => {
  const edits = editsSchema.parse({
    version: 1,
    vars: { '--pill-duration': '600ms' },
    rules: [
      {
        selector: 'body > nav:nth-child(1) > a:nth-child(1)',
        styles: { translate: '4px -2px', 'border-width': '1px', 'border-style': 'solid' },
      },
    ],
  })

  it('compiles values onto :root and element styles as overrides', () => {
    expect(compileEdits(edits)).toBe(
      ':root { --pill-duration: 600ms; }\n' +
        'body > nav:nth-child(1) > a:nth-child(1) { translate: 4px -2px !important; border-width: 1px !important; border-style: solid !important; }',
    )
  })

  it('adds one stylesheet before </body>, and replaces it on the next save', () => {
    const once = applyEdits(BASE, edits)
    expect(once.indexOf('data-gil-edits')).toBeLessThan(once.indexOf('</body>'))
    expect(once.indexOf('data-gil-edits')).toBeGreaterThan(once.indexOf('<script>'))
    const twice = applyEdits(once, edits)
    expect(twice.match(/data-gil-edits/g)).toHaveLength(1)
    expect(applyEdits(once, NO_EDITS)).toBe(BASE)
  })

  it('replaces edits saved under the old name too', () => {
    const legacy = BASE.replace('</body>', '\n<style data-gilbert-edits>\nold {}\n</style></body>')
    const saved = applyEdits(legacy, edits)
    expect(saved).not.toContain('data-gilbert-edits')
    expect(saved.match(/data-gil-edits/g)).toHaveLength(1)
  })

  it('knows when there is nothing to save', () => {
    expect(hasEdits(NO_EDITS)).toBe(false)
    expect(hasEdits(edits)).toBe(true)
  })
})

describe('validation', () => {
  it('rejects values that could escape a declaration or load something', () => {
    for (const value of ['red; } body { display:none', 'url(https://x)', '</style><script>', '@import "x"', '']) {
      expect(isSafeValue(value)).toBe(false)
    }
    expect(isSafeValue('cubic-bezier(0.2, 0.8, 0.2, 1)')).toBe(true)
  })

  it('accepts only structural selectors, known properties and custom property names', () => {
    const base = { version: 1, vars: {}, rules: [] }
    expect(editsSchema.safeParse({ ...base, vars: { color: 'red' } }).success).toBe(false)
    expect(
      editsSchema.safeParse({ ...base, rules: [{ selector: 'body *', styles: { color: 'red' } }] }).success,
    ).toBe(false)
    expect(
      editsSchema.safeParse({
        ...base,
        rules: [{ selector: 'body > div:nth-child(1)', styles: { position: 'fixed' } }],
      }).success,
    ).toBe(false)
  })
})

describe('splitRecreation', () => {
  it('separates markup, styles and scripts', () => {
    const { markup, css, js } = splitRecreation(BASE)
    expect(css).toContain('.pill { transition')
    expect(js).toBe('window.replay = () => {}')
    expect(markup).toContain('<nav><a>One</a></nav>')
    expect(markup).not.toContain('<style')
    expect(markup).not.toContain('<script')
  })
})
