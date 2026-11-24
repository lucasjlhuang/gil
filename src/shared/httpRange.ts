/**
 * Minimal HTTP Range parsing for serving clips to a <video> element, which needs byte ranges
 * to seek. Supports the single-range forms browsers send; anything else falls back to the
 * whole file.
 */

export interface ByteRange {
  /** Inclusive. */
  start: number
  /** Inclusive. */
  end: number
}

export type RangeResult =
  | { kind: 'full' }
  | { kind: 'partial'; range: ByteRange }
  | { kind: 'unsatisfiable' }

export function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return { kind: 'full' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return { kind: 'full' }
  const [, first = '', last = ''] = match
  if (first === '' && last === '') return { kind: 'full' }
  if (size === 0) return { kind: 'unsatisfiable' }

  if (first === '') {
    // Suffix form: the last N bytes.
    const length = Number(last)
    if (length === 0) return { kind: 'unsatisfiable' }
    return { kind: 'partial', range: { start: Math.max(0, size - length), end: size - 1 } }
  }

  const start = Number(first)
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (start >= size || start > end) return { kind: 'unsatisfiable' }
  return { kind: 'partial', range: { start, end } }
}
