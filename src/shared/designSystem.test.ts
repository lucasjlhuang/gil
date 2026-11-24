import { describe, expect, it } from 'vitest'
import { normalizeMembers, parseDesignSystem } from './designSystem'

const a = '01JAB3X9K2M4Q7R8S5T6V0W1YA'
const b = '01JAB3X9K2M4Q7R8S5T6V0W1YB'

describe('normalizeMembers', () => {
  it('keeps each valid id once, in order, never the bundle itself', () => {
    expect(normalizeMembers([b, a, b, 'nope', a], a)).toEqual([b])
    expect(normalizeMembers([a, b], 'other')).toEqual([a, b])
  })
})

describe('parseDesignSystem', () => {
  it('treats missing or broken files as empty', () => {
    expect(parseDesignSystem(null).members).toEqual([])
    expect(parseDesignSystem('{').members).toEqual([])
    expect(parseDesignSystem(JSON.stringify({ version: 1, members: [a] })).members).toEqual([a])
  })
})
