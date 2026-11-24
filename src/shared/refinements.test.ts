import { describe, expect, it } from 'vitest'
import { addRequest, changesNote, NO_REFINEMENTS, refinementsSchema } from './refinements'

describe('addRequest', () => {
  it('appends trimmed requests in order', () => {
    const once = addRequest(NO_REFINEMENTS, '  Change Mirego to Maya ')
    expect(addRequest(once, 'Slower').requests).toEqual(['Change Mirego to Maya', 'Slower'])
    expect(NO_REFINEMENTS.requests).toEqual([])
  })

  it('keeps the newest fifty and stays valid', () => {
    let refinements = NO_REFINEMENTS
    for (let i = 0; i < 55; i++) refinements = addRequest(refinements, `change ${i}`)
    expect(refinements.requests).toHaveLength(50)
    expect(refinements.requests[0]).toBe('change 5')
    expect(refinementsSchema.safeParse(refinements).success).toBe(true)
  })
})

describe('changesNote', () => {
  it('is empty with no changes', () => {
    expect(changesNote([], null)).toBe('')
  })

  it('tells the check to keep earlier changes', () => {
    const note = changesNote(['Change Mirego to Maya'], null)
    expect(note).toContain('deliberate')
    expect(note).toContain('- Change Mirego to Maya')
    expect(note).not.toContain('asking for now')
  })

  it('puts the new request after the earlier ones', () => {
    const note = changesNote(['Change Mirego to Maya'], 'Make it slower')
    expect(note.indexOf('Change Mirego')).toBeLessThan(note.indexOf('Make it slower'))
    expect(note).toContain('it wins')
  })
})
