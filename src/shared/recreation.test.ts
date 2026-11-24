import { describe, expect, it } from 'vitest'
import { RECREATION_CSP, verifyDocument, wrapRecreation } from './recreation'

describe('recreation policy', () => {
  it('allows inline code and nothing from the network', () => {
    expect(RECREATION_CSP).toContain("default-src 'none'")
    expect(RECREATION_CSP).toContain("connect-src 'none'")
    expect(RECREATION_CSP).not.toMatch(/https?:|\*/)
  })

  it('puts the policy and preview bridge before the model output', () => {
    const wrapped = wrapRecreation('<!DOCTYPE html><html><body>hi</body></html>', ['color'])
    expect(wrapped.indexOf('Content-Security-Policy')).toBeLessThan(wrapped.indexOf('<html>'))
    expect(wrapped).toContain("d==='gil:replay'")
    expect(wrapped).toContain('PROPS=["color"]')
    // Messages are accepted only from the library window that embeds the frame.
    expect(wrapped).toContain('e.source!==parent')
    expect(wrapped.match(/<!doctype html>/gi)?.length).toBe(1)
  })
})

describe('verifyDocument', () => {
  it('installs the policy and the virtual clock before the recreation runs', () => {
    const doc = verifyDocument('<!doctype html><script>window.replay=()=>{}</script>')
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('__gilSeek'))
    expect(doc.indexOf('__gilSeek')).toBeLessThan(doc.indexOf('window.replay=()=>{}'))
    expect(doc.match(/<!doctype html>/gi)).toHaveLength(1)
  })
})
