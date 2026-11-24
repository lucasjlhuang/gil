import { describe, expect, it } from 'vitest'
import { gapsBetween, gridOf, groupValues, insetsWithin, measureSpacing, snapToNamed, spacingPage, spacingSystemSpec, unitOf } from './spacingSystem'

describe('spacing scale', () => {
  it('measures the gaps between facing boxes, not across others', () => {
    const boxes = [
      { x: 0, y: 0, width: 100, height: 40 },
      { x: 116, y: 0, width: 100, height: 40 },
      { x: 0, y: 64, width: 216, height: 20 },
    ]
    expect(gapsBetween(boxes).sort((a, b) => a - b)).toEqual([16, 24, 24])
  })

  it('groups near values and finds the unit they are built on', () => {
    expect(groupValues([8, 8.5, 16, 16, 15.5, 32])).toEqual([{ value: 8.5, count: 2 }, { value: 16, count: 3 }, { value: 32, count: 1 }])
    expect(unitOf([8, 16, 24, 32, 16, 8])).toEqual({ unit: 8, fit: 1 })
    expect(unitOf([12, 20, 28, 16]).unit).toBe(4)
    expect(unitOf([7, 13, 19, 23, 29]).unit).toBeNull()
    expect(unitOf([8, 16]).unit).toBeNull()
  })
})

describe('insets and named values', () => {
  it('measures padding inside the box that holds a thing, on sides with nothing between', () => {
    const card = { x: 0, y: 0, width: 200, height: 100 }
    const title = { x: 24, y: 24, width: 100, height: 20 }
    const body = { x: 24, y: 60, width: 152, height: 16 }
    expect(insetsWithin([card, title, body]).sort((a, b) => a - b)).toEqual([24, 24, 24, 24, 24, 76])
  })

  it('snaps measured steps to the values an analysis named, within the measuring error', () => {
    expect(snapToNamed([{ value: 13.5, count: 2 }, { value: 19.5, count: 1 }, { value: 31, count: 1 }], [14, 20, 24, 40])).toEqual([
      { value: 14, count: 2 },
      { value: 20, count: 1 },
      { value: 31, count: 1 },
    ])
  })
})

describe('grid', () => {
  it('finds equal columns with even gutters, and margins', () => {
    const cards = [0, 1, 2].map((i) => ({ x: 40 + i * 320, y: 100, width: 296, height: 200 }))
    expect(gridOf([...cards, { x: 40, y: 20, width: 600, height: 40 }], 1000)).toEqual({ columns: 3, columnWidth: 296, gutter: 24, marginLeft: 40, marginRight: 24 })
  })

  it('is null for things that are not columns', () => {
    expect(gridOf([{ x: 0, y: 0, width: 100, height: 10 }, { x: 140, y: 0, width: 300, height: 10 }], 800)).toBeNull()
    expect(gridOf([{ x: 0, y: 0, width: 40, height: 10 }, { x: 60, y: 0, width: 40, height: 10 }], 800)).toBeNull()
  })
})

describe('spacing system', () => {
  it('writes a spec and a specimen page', () => {
    const cards = [0, 1, 2].map((i) => ({ x: 24 + i * 112, y: 24, width: 96, height: 96 }))
    const system = measureSpacing([...cards, { x: 24, y: 136, width: 320, height: 40 }, { x: 24, y: 192, width: 320, height: 40 }], 368)
    expect(system.unit).toBe(8)
    expect(system.scale.map((step) => step.value)).toEqual([16])
    expect(system.grid?.columns).toBe(3)
    const spec = spacingSystemSpec(system, 'a card grid')
    expect(spec.tokens.spacing.map((step) => step.value)).toEqual([16])
    expect(spec.layout.description).toContain('8 px unit')
    expect(spec.layout.description).toContain('3-column grid')
    const page = spacingPage(system, 'Card grid <spacing>', { width: 368, height: 260 })
    expect(page).toContain('Card grid &#60;spacing&#62;')
    expect(page).toContain('3 columns, 96 px wide, 16 px gutters.')
  })
})
