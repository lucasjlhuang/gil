import { describe, expect, it } from 'vitest'
import { parseRange } from './httpRange'

describe('parseRange', () => {
  it('serves the whole file without a usable header', () => {
    expect(parseRange(null, 100)).toEqual({ kind: 'full' })
    expect(parseRange('items=0-5', 100)).toEqual({ kind: 'full' })
    expect(parseRange('bytes=0-5,10-15', 100)).toEqual({ kind: 'full' })
    expect(parseRange('bytes=-', 100)).toEqual({ kind: 'full' })
  })

  it('parses open-ended and bounded ranges', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ kind: 'partial', range: { start: 0, end: 99 } })
    expect(parseRange('bytes=10-19', 100)).toEqual({
      kind: 'partial',
      range: { start: 10, end: 19 },
    })
  })

  it('clamps the end to the file size', () => {
    expect(parseRange('bytes=90-500', 100)).toEqual({
      kind: 'partial',
      range: { start: 90, end: 99 },
    })
  })

  it('parses suffix ranges', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'partial', range: { start: 90, end: 99 } })
    expect(parseRange('bytes=-500', 100)).toEqual({ kind: 'partial', range: { start: 0, end: 99 } })
  })

  it('reports ranges that cannot be satisfied', () => {
    expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=50-40', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' })
  })
})
