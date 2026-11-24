import { describe, expect, it } from 'vitest'
import { parseWindowList, pickWindow, regionInWindow, type WindowInfo } from './windowList'

const raw = (
  id: number,
  X: number,
  Y: number,
  Width: number,
  Height: number,
  extra: Record<string, unknown> = {},
) => ({
  kCGWindowNumber: id,
  kCGWindowOwnerPID: 100 + id,
  kCGWindowOwnerName: `App ${id}`,
  kCGWindowLayer: 0,
  kCGWindowAlpha: 1,
  kCGWindowBounds: { X, Y, Width, Height },
  ...extra,
})

describe('parseWindowList', () => {
  it('maps macOS keys and keeps order', () => {
    const windows = parseWindowList([
      raw(1, 0, 33, 1512, 863, { kCGWindowName: 'Docs' }),
      raw(2, 188, 50, 1200, 801),
    ])
    expect(windows).toEqual([
      {
        id: 1,
        pid: 101,
        app: 'App 1',
        title: 'Docs',
        bounds: { x: 0, y: 33, width: 1512, height: 863 },
        layer: 0,
        alpha: 1,
      },
      {
        id: 2,
        pid: 102,
        app: 'App 2',
        title: null,
        bounds: { x: 188, y: 50, width: 1200, height: 801 },
        layer: 0,
        alpha: 1,
      },
    ])
  })

  it('drops malformed entries and tolerates garbage', () => {
    expect(parseWindowList([raw(1, 0, 0, 100, 100), { nope: true }, null])).toHaveLength(1)
    expect(parseWindowList('not a list')).toEqual([])
    expect(parseWindowList(undefined)).toEqual([])
  })

  it('treats an empty title as unknown', () => {
    expect(parseWindowList([raw(1, 0, 0, 100, 100, { kCGWindowName: '' })])[0]?.title).toBeNull()
  })
})

describe('pickWindow', () => {
  const win = (id: number, bounds: WindowInfo['bounds'], extra: Partial<WindowInfo> = {}) => ({
    id,
    pid: 100 + id,
    app: `App ${id}`,
    title: null,
    bounds,
    layer: 0,
    alpha: 1,
    ...extra,
  })
  const selection = { x: 300, y: 200, width: 100, height: 50 }

  it('picks the frontmost window under the centre of the selection', () => {
    const front = win(1, { x: 250, y: 150, width: 400, height: 300 })
    const behind = win(2, { x: 0, y: 0, width: 1512, height: 982 })
    expect(pickWindow(selection, [front, behind], 1)).toBe(front)
  })

  it('skips windows that do not contain the centre', () => {
    const elsewhere = win(1, { x: 800, y: 0, width: 400, height: 300 })
    const under = win(2, { x: 0, y: 0, width: 1512, height: 982 })
    expect(pickWindow(selection, [elsewhere, under], 1)).toBe(under)
  })

  it('ignores menu bar items, overlays, invisible, tiny and own windows', () => {
    const full = { x: 0, y: 0, width: 1512, height: 982 }
    const candidates = [
      win(1, full, { layer: 25 }),
      win(2, full, { layer: 1000 }),
      win(3, full, { alpha: 0 }),
      win(4, { x: 340, y: 215, width: 30, height: 30 }),
      win(5, full, { pid: 42 }),
    ]
    expect(pickWindow(selection, candidates, 42)).toBeNull()
    const target = win(6, full)
    expect(pickWindow(selection, [...candidates, target], 42)).toBe(target)
  })

  it("skips gil's own windows", () => {
    const full = { x: 0, y: 0, width: 1512, height: 982 }
    const library = win(1, full, { pid: 42 })
    const other = win(2, full, { pid: 7 })
    expect(pickWindow(selection, [library, other], 42)).toBe(other)
  })

  it('works on a display left of the primary (negative coordinates)', () => {
    const left = win(1, { x: -1920, y: 0, width: 1920, height: 1080 })
    expect(pickWindow({ x: -1000, y: 100, width: 50, height: 50 }, [left], 0)).toBe(left)
  })

  it('returns null over the desktop', () => {
    expect(pickWindow(selection, [], 0)).toBeNull()
  })
})

describe('regionInWindow', () => {
  const bounds = { x: 100, y: 50, width: 800, height: 600 }

  it('translates into window coordinates', () => {
    expect(regionInWindow({ x: 150, y: 80, width: 200, height: 100 }, bounds)).toEqual({
      x: 50,
      y: 30,
      width: 200,
      height: 100,
    })
  })

  it('clips a selection that spills outside the window', () => {
    expect(regionInWindow({ x: 50, y: 600, width: 200, height: 200 }, bounds)).toEqual({
      x: 0,
      y: 550,
      width: 150,
      height: 50,
    })
  })

  it('returns null when almost nothing is inside', () => {
    expect(regionInWindow({ x: 896, y: 100, width: 100, height: 100 }, bounds)).toBeNull()
  })
})
