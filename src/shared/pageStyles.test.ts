import { describe, expect, it } from 'vitest'
import { collectStyles, describePageStyles, ms, pageStylesSchema, px, splitList, transitionsOf } from './pageStyles'

const text = (sample: string, fontSize: number, extra = {}) => ({
  sample,
  fontFamily: 'Inter, sans-serif',
  fontSize,
  lineHeight: fontSize * 1.5,
  fontWeight: 400,
  letterSpacing: 0,
  color: 'rgb(17, 17, 17)',
  ...extra,
})

describe('collectStyles', () => {
  it('merges identical styles, largest text first, and drops transparent colours', () => {
    const styles = collectStyles(
      [text('Body one', 16), text('Heading', 32, { fontWeight: 700 }), text('Body two', 16)],
      [
        { value: 'rgb(255, 255, 255)', use: 'background' },
        { value: 'rgba(0, 0, 0, 0)', use: 'background' },
        { value: 'rgb(17, 17, 17)', use: 'text' },
        { value: 'rgb(255, 255, 255)', use: 'border' },
      ],
    )
    expect(styles.texts.map((t) => [t.sample, t.count])).toEqual([['Heading', 1], ['Body one', 2]])
    expect(styles.colors[0]).toEqual({ value: 'rgb(255, 255, 255)', uses: ['background', 'border'], count: 2 })
    expect(styles.colors).toHaveLength(2)
    expect(pageStylesSchema.parse(styles)).toEqual(styles)
  })
})

describe('px', () => {
  it('reads px lengths only', () => {
    expect(px('16px')).toBe(16)
    expect(px('-0.5px')).toBe(-0.5)
    expect(px('normal')).toBeNull()
  })
})

describe('describePageStyles', () => {
  it('lists exact values for the model', () => {
    const line = describePageStyles(collectStyles([text('Heading', 32)], []))
    expect(line).toContain('Text "Heading": Inter, sans-serif, 32px, line height 48px')
    expect(describePageStyles(null)).toBe('')
  })
})

describe('transitionsOf', () => {
  it('reads each timed transition, grouping properties that share a timing', () => {
    expect(
      transitionsOf({
        transitionProperty: 'transform, opacity, color',
        transitionDuration: '0.42s, 0.42s, 0s',
        transitionDelay: '0s',
        transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      }),
    ).toEqual([{ properties: 'transform, opacity', durationMs: 420, delayMs: 0, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }])
    expect(transitionsOf({ transitionProperty: 'all', transitionDuration: '0s', transitionDelay: '0s', transitionTimingFunction: 'ease' })).toEqual([])
  })

  it('splits lists on top-level commas and reads times', () => {
    expect(splitList('ease, cubic-bezier(0.1, 0.2, 0.3, 1), linear')).toEqual(['ease', 'cubic-bezier(0.1, 0.2, 0.3, 1)', 'linear'])
    expect(ms('300ms')).toBe(300)
    expect(ms('0.25s')).toBe(250)
    expect(ms('auto')).toBe(0)
  })

  it('describes boxes and motion for the model', () => {
    const text = describePageStyles({
      texts: [],
      colors: [{ value: 'rgb(0, 0, 0)', uses: ['text'], count: 1 }],
      boxes: [{ label: 'button.cta', x: 12, y: 8, width: 140, height: 44, radius: '22px', padding: '0px 20px' }],
      motions: [{ kind: 'transition', label: 'button.cta', properties: 'transform', durationMs: 420, delayMs: 0, easing: 'ease-out' }],
    })
    expect(text).toContain('- button.cta: at 12, 8, 140 × 44; radius 22px; padding 0px 20px')
    expect(text).toContain('- button.cta (transition): transform, 420 ms, delay 0 ms, ease-out')
  })
})
