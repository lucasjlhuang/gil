import { describe, expect, it } from 'vitest'
import { releaseTag, versionLabel } from './version'

describe('versionLabel', () => {
  it('shows the version and the commit it was built from', () => {
    expect(versionLabel('0.2.0', 'af5f4f2')).toBe('0.2.0 (af5f4f2)')
    expect(versionLabel('0.2.0', 'af5f4f2-dirty')).toBe('0.2.0 (af5f4f2-dirty)')
  })

  it('leaves out an unknown commit', () => {
    expect(versionLabel('0.2.0', 'unknown')).toBe('0.2.0')
  })
})

describe('releaseTag', () => {
  it('prefixes v', () => {
    expect(releaseTag('1.4.2')).toBe('v1.4.2')
  })
})
