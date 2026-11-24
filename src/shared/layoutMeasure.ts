import type { GrayImage } from './gate'

/**
 * Sizes and gaps measured from pixels, for captures with no page to read (screen captures and
 * images). The picture is cut along its empty gutters: full rows or columns of background split
 * it into blocks, and each block is cut again the other way, a few levels deep (an "XY cut").
 * What comes out is the boxes of the things in the capture and the gaps between them.
 *
 * It only works on a plain background (the most common grey level); on photos and gradients it
 * finds one big box, which says nothing and is left out. Pure.
 */

export interface MeasuredBox {
  /** In the image's pixels. */
  x: number
  y: number
  width: number
  height: number
  /** How deep in the cutting it was found: 0 is a top-level block. */
  depth: number
}

/** A pixel this far from the background grey is content. */
const CONTENT = 10
/** A pixel this far from the background can be part of a panel's border. */
const FRAME_EDGE = 8
/** Gutters narrower than this many pixels do not split (letter gaps, hairlines). */
const MIN_GUTTER = 6
/** Blocks smaller than this on either side are noise. */
const MIN_BLOCK = 4
const MAX_DEPTH = 3
const MAX_BOXES = 60

interface Rect { x: number; y: number; width: number; height: number }

/** Runs of consecutive true values at least `min` long, as [start, end) pairs. */
function runs(flags: readonly boolean[], min: number): [number, number][] {
  const found: [number, number][] = []
  let start = -1
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) {
      if (start < 0) start = i
    } else if (start >= 0) {
      if (i - start >= min) found.push([start, i])
      start = -1
    }
  }
  return found
}

export function measureLayout(image: GrayImage): MeasuredBox[] {
  const { width, height, data } = image
  /** The most common grey in a rect: its background. */
  const backgroundOf = (rect: Rect): number => {
    const histogram = new Array<number>(256).fill(0)
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) { const v = data[y * width + x] as number; histogram[v] = (histogram[v] as number) + 1 }
    return histogram.indexOf(Math.max(...histogram))
  }
  // Inside a framed panel (a card with a border, a filled box) the panel's own colour is the
  // background, so content is judged against whichever background the cutting is in.
  let background = backgroundOf({ x: 0, y: 0, width, height })
  const content = (x: number, y: number) => Math.abs((data[y * width + x] as number) - background) > CONTENT

  /** Whether each row (or column) of `rect` has any content. */
  const profile = (rect: Rect, rows: boolean): boolean[] => {
    const length = rows ? rect.height : rect.width
    return Array.from({ length }, (_, i) => {
      if (rows) {
        for (let x = rect.x; x < rect.x + rect.width; x++) if (content(x, rect.y + i)) return true
      } else {
        for (let y = rect.y; y < rect.y + rect.height; y++) if (content(rect.x + i, y)) return true
      }
      return false
    })
  }
  /** Shrinks a rect to its content; null if it is empty. */
  const trim = (rect: Rect): Rect | null => {
    const rowsWith = profile(rect, true)
    const colsWith = profile(rect, false)
    const top = rowsWith.indexOf(true)
    const left = colsWith.indexOf(true)
    if (top < 0 || left < 0) return null
    return { x: rect.x + left, y: rect.y + top, width: colsWith.lastIndexOf(true) - left + 1, height: rowsWith.lastIndexOf(true) - top + 1 }
  }
  /** Splits a trimmed rect along its gutters in one direction; one part means it did not split. */
  const split = (rect: Rect, rows: boolean): Rect[] => {
    const filled = profile(rect, rows)
    // Bridge gutters too narrow to count, so letters and words stay together.
    const gutters = runs(filled.map((value) => !value), MIN_GUTTER)
    const joined = filled.map(() => true)
    for (const [from, to] of gutters) for (let i = from; i < to; i++) joined[i] = false
    return runs(joined, 1).map(([from, to]) =>
      rows ? { x: rect.x, y: rect.y + from, width: rect.width, height: to - from } : { x: rect.x + from, y: rect.y, width: to - from, height: rect.height },
    )
  }

  /**
   * The inside of a panel: a rect that is all content at its edges (a border) or all one colour
   * other than the background (a filled box), shrunk past its border. Null for anything else,
   * such as text or an icon, or a panel too small to hold things.
   */
  const insideFrame = (rect: Rect): Rect | null => {
    if (rect.width < 40 || rect.height < 30) return null
    // Borders are often faint (a light grey line on white), so a smaller difference counts here.
    const edge = (x: number, y: number) => Math.abs((data[y * width + x] as number) - background) > FRAME_EDGE
    const filledShare = (y0: number, y1: number, x0: number, x1: number) => {
      let filled = 0
      let all = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        all++
        if (edge(x, y)) filled++
      }
      return all ? filled / all : 0
    }
    // A border: the outermost row and column on every side are nearly all content.
    const side = (from: number) => [
      filledShare(rect.y + from, rect.y + from + 1, rect.x, rect.x + rect.width),
      filledShare(rect.y + rect.height - 1 - from, rect.y + rect.height - from, rect.x, rect.x + rect.width),
      filledShare(rect.y, rect.y + rect.height, rect.x + from, rect.x + from + 1),
      filledShare(rect.y, rect.y + rect.height, rect.x + rect.width - 1 - from, rect.x + rect.width - from),
    ]
    // The outermost pixel may be a soft edge; the line can sit one pixel in.
    const edges = side(0).map((share, i) => Math.max(share, side(1)[i] as number))
    // Rounded corners leave the very corners empty, so most of each edge is enough.
    if (edges.every((share) => share >= 0.8)) {
      let inset = 1
      while (inset < Math.min(rect.width, rect.height) / 4 && filledShare(rect.y + inset, rect.y + inset + 1, rect.x + inset, rect.x + rect.width - inset) >= 0.8) inset++
      const margin = inset + 2
      return { x: rect.x + margin, y: rect.y + margin, width: rect.width - margin * 2, height: rect.height - margin * 2 }
    }
    return null
  }

  const boxes: MeasuredBox[] = []
  const cut = (rect: Rect, depth: number, rows: boolean, triedOther: boolean) => {
    const tight = trim(rect)
    if (!tight || tight.width < MIN_BLOCK || tight.height < MIN_BLOCK) return
    const parts = depth < MAX_DEPTH ? split(tight, rows) : [tight]
    if (parts.length <= 1) {
      // Nothing to cut this way: try the other once, then it is a box.
      if (!triedOther && depth < MAX_DEPTH) return cut(tight, depth, !rows, true)
      boxes.push({ ...tight, depth })
      // A framed or filled panel: look inside it, against its own background.
      const inner = insideFrame(tight)
      if (inner && depth < MAX_DEPTH + 2) {
        const outer = background
        background = backgroundOf(inner)
        const before = boxes.length
        cut(inner, depth + 1, true, false)
        // A panel with one thing inside says nothing more than the panel.
        if (boxes.length - before <= 1) boxes.length = before
        background = outer
      }
      return
    }
    for (const part of parts) cut(part, depth + 1, !rows, false)
  }
  cut({ x: 0, y: 0, width, height }, 0, true, false)

  // One box covering nearly everything says nothing.
  if (boxes.length === 1 && (boxes[0] as MeasuredBox).width * (boxes[0] as MeasuredBox).height > width * height * 0.9) return []
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, MAX_BOXES)
}

/** The boxes as lines for the model's prompt, in CSS px; empty if there are none. */
export function describeLayout(boxes: readonly MeasuredBox[], pxPerCss: number): string {
  if (boxes.length === 0) return ''
  const css = (value: number) => Math.round(value / pxPerCss)
  return [
    'Measured boxes: gil cut the capture along its empty gutters and measured these blocks from the pixels (x, y from the top left, then width × height, in CSS px, accurate to about 1 px). Use them for sizes, positions and gaps, and mark those "measured". A block can be one element or a tight group; text blocks are the size of the letters, not of the text box:',
    ...boxes.map((box) => `- at ${css(box.x)}, ${css(box.y)}: ${css(box.width)} × ${css(box.height)}`),
  ].join('\n')
}
