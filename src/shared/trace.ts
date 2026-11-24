import { measurePalette } from './palette'

/**
 * Tracing: the real outlines of what is in a frame, taken from its pixels, so the model is given
 * exact shapes to use instead of drawing letters, marks and icons by eye. Pure: main decodes
 * the frame into RGBA pixels.
 *
 * The frame is split into its main flat colours (see shared/palette.ts). The largest is the
 * background; for each other colour, the pixels nearest to it form a mask, whose boundary is
 * followed along the pixel edges into closed loops. Each loop is moved onto the true edge inside
 * its soft (anti-aliased) pixels, then turned into a clean outline: real corners, straight lines
 * and fitted curves, within about half a pixel of the edge. The result is one SVG path per
 * colour, with holes (fill-rule evenodd).
 *
 * It suits flat graphics: logos, text, icons, buttons. Photos, gradients and soft shadows have
 * no clean colour layers; a frame that needs too many points is left untraced.
 */

export interface TracedLayer {
  /** #rrggbb of the layer. */
  color: string
  /** SVG path data in the units asked for (CSS px), to be filled with fill-rule evenodd. */
  d: string
  points: number
}

export interface TraceOptions {
  /** Image pixels per output unit (CSS px). */
  scale: number
  /** Most points a frame may need; beyond that it is not flat graphics and nothing is returned. */
  maxPoints?: number
  /** 'bgra' for nativeImage bitmaps. */
  order?: 'rgba' | 'bgra'
}

type Point = [number, number]

/** How far (in pixels) the simplified outline may stray from the pixel boundary. */
const TOLERANCE = 0.5
/** Loops enclosing less than this many pixels are specks. */
const MIN_AREA = 8
/** A pixel further than this (RGB distance) from every palette colour belongs to no layer. */
const MAX_DISTANCE = 90
/** A pixel this close (RGB distance) to the straight blend of two layer colours is a soft edge between them. */
const BLEND_DISTANCE = 40

/** Closed loops along the pixel edges of a mask (1 = inside), each a list of corner points. */
export function traceLoops(mask: Uint8Array, width: number, height: number): Point[][] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1
  // Directed boundary edges, keyed by their start corner. Corner (x, y) is index y * (width + 1) + x.
  const stride = width + 1
  const from = new Map<number, number[]>()
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const key = y0 * stride + x0
    const list = from.get(key)
    if (list) list.push(y1 * stride + x1)
    else from.set(key, [y1 * stride + x1])
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 1) continue
      if (!inside(x, y - 1)) add(x + 1, y, x, y)
      if (!inside(x, y + 1)) add(x, y + 1, x + 1, y + 1)
      if (!inside(x - 1, y)) add(x, y, x, y + 1)
      if (!inside(x + 1, y)) add(x + 1, y + 1, x + 1, y)
    }
  }
  const loops: Point[][] = []
  for (const start of from.keys()) {
    while ((from.get(start)?.length ?? 0) > 0) {
      const loop: Point[] = []
      let at = start
      for (;;) {
        loop.push([at % stride, Math.floor(at / stride)])
        const next = from.get(at)?.pop()
        if (next === undefined || next === start) break
        at = next
      }
      if (loop.length >= 4) loops.push(loop)
    }
  }
  return loops
}

function area(loop: readonly Point[]): number {
  let sum = 0
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i] as Point
    const [x1, y1] = loop[(i + 1) % loop.length] as Point
    sum += x0 * y1 - x1 * y0
  }
  return Math.abs(sum) / 2
}

/** Douglas–Peucker on an open run of points. */
function simplifyRun(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points]
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop() as [number, number]
    const [ax, ay] = points[first] as Point
    const [bx, by] = points[last] as Point
    const length = Math.hypot(bx - ax, by - ay) || 1
    let worst = 0
    let index = -1
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i] as Point
      const distance = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length
      if (distance > worst) {
        worst = distance
        index = i
      }
    }
    if (index >= 0 && worst > tolerance) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

/** Simplifies a closed loop: split at its two farthest-apart points, simplify each half. */
export function simplifyLoop(loop: readonly Point[], tolerance = TOLERANCE): Point[] {
  if (loop.length <= 4) return [...loop]
  const [x0, y0] = loop[0] as Point
  let far = 0
  let best = -1
  loop.forEach(([x, y], i) => {
    const distance = Math.hypot(x - x0, y - y0)
    if (distance > best) {
      best = distance
      far = i
    }
  })
  const first = simplifyRun(loop.slice(0, far + 1), tolerance)
  const second = simplifyRun([...loop.slice(far), loop[0] as Point], tolerance)
  const joined = [...first.slice(0, -1), ...second.slice(0, -1)]
  // The two split points are always kept; drop either if it lies on a straight edge.
  return joined.filter((point, i) => {
    const [ax, ay] = joined[(i + joined.length - 1) % joined.length] as Point
    const [bx, by] = joined[(i + 1) % joined.length] as Point
    const length = Math.hypot(bx - ax, by - ay)
    if (length === 0) return true
    return Math.abs((bx - ax) * (ay - point[1]) - (ax - point[0]) * (by - ay)) / length > tolerance / 4
  })
}

/**
 * Evens out the pixel staircase of a traced loop: each corner point is replaced by the average
 * of itself and its neighbours along the loop. Straight runs stay straight and real corners are
 * rounded by well under a pixel, while diagonals and curves stop zig-zagging.
 */
export function smoothLoop(loop: readonly Point[], reach = 2): Point[] {
  const n = loop.length
  if (n < 2 * reach + 2) return [...loop]
  return loop.map((_, i) => {
    let x = 0
    let y = 0
    for (let k = -reach; k <= reach; k++) {
      const [px, py] = loop[(i + k + n) % n] as Point
      x += px
      y += py
    }
    return [x / (2 * reach + 1), y / (2 * reach + 1)]
  })
}

// ---------------------------------------------------------------------------------------------
// Clean outlines: sub-pixel edges, real corners, straight lines and fitted curves.
// ---------------------------------------------------------------------------------------------

/**
 * Moves a pixel-edge loop (from traceLoops) onto the true edge. A soft (anti-aliased) edge says
 * where the real edge runs inside a pixel: `coverage(x, y)` is how much pixel (x, y) belongs to
 * the shape (0 to 1, above 0.5 inside), and each boundary step becomes the point between the
 * inside and the outside pixel where the coverage crosses one half.
 */
export function refineLoop(loop: readonly Point[], coverage: (x: number, y: number) => number): Point[] {
  const out: Point[] = []
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i] as Point
    const [x1, y1] = loop[(i + 1) % loop.length] as Point
    // The shape is on the left of each step in traceLoops' winding (see its four `add` calls).
    let inside: Point
    let outside: Point
    if (x1 < x0) [inside, outside] = [[x1, y0], [x1, y0 - 1]]
    else if (x1 > x0) [inside, outside] = [[x0, y0 - 1], [x0, y0]]
    else if (y1 > y0) [inside, outside] = [[x0, y0], [x0 - 1, y0]]
    else [inside, outside] = [[x0 - 1, y1], [x0, y1]]
    const a = coverage(inside[0], inside[1])
    const b = coverage(outside[0], outside[1])
    const t = a - b > 1e-6 ? Math.min(0.95, Math.max(0.05, (a - 0.5) / (a - b))) : 0.5
    out.push([inside[0] + 0.5 + t * (outside[0] - inside[0]), inside[1] + 0.5 + t * (outside[1] - inside[1])])
  }
  return out
}

/** The same closed loop as points an even `spacing` apart along it, so later steps can count points as distance. */
export function resampleLoop(loop: readonly Point[], spacing = 1): Point[] {
  const n = loop.length
  let length = 0
  for (let i = 0; i < n; i++) {
    const [a, b] = [loop[i] as Point, loop[(i + 1) % n] as Point]
    length += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  const count = Math.max(3, Math.round(length / spacing))
  const step = length / count
  const out: Point[] = []
  let walked = 0
  let next = 0
  for (let i = 0; i < n && out.length < count; i++) {
    const [a, b] = [loop[i] as Point, loop[(i + 1) % n] as Point]
    const piece = Math.hypot(b[0] - a[0], b[1] - a[1])
    while (next <= walked + piece && out.length < count) {
      const t = piece === 0 ? 0 : (next - walked) / piece
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      next += step
    }
    walked += piece
  }
  return out
}

/** One piece of an outline: a straight line to `to`, or a cubic curve through two control points. */
export type Segment = { to: Point; c1?: Point; c2?: Point }
export interface Outline {
  start: Point
  segments: Segment[]
}

/** How far (px) a run may bow away from its chord and still be a straight line. */
const LINE_TOLERANCE = 0.3
/** How far (px) a fitted curve may stray from the traced edge. */
const CURVE_TOLERANCE = 0.45
/** A turn sharper than this (radians) within CORNER_REACH points is a corner, not a curve. */
const CORNER_ANGLE = (50 * Math.PI) / 180
const CORNER_REACH = 3

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]]
const add2 = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]]
const mul = (a: Point, s: number): Point => [a[0] * s, a[1] * s]
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1]
const unit = (a: Point): Point => {
  const length = Math.hypot(a[0], a[1]) || 1
  return [a[0] / length, a[1] / length]
}

/** The best straight line through a run's points (away from its ends): a point on it and its direction. */
function lineThrough(points: readonly Point[]): { at: Point; dir: Point } {
  const skip = points.length > 8 ? 2 : points.length > 4 ? 1 : 0
  const used = points.slice(skip, points.length - skip)
  const n = used.length
  const cx = used.reduce((s, p) => s + p[0], 0) / n
  const cy = used.reduce((s, p) => s + p[1], 0) / n
  let xx = 0
  let xy = 0
  let yy = 0
  for (const [x, y] of used) {
    xx += (x - cx) * (x - cx)
    xy += (x - cx) * (y - cy)
    yy += (y - cy) * (y - cy)
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy)
  return { at: [cx, cy], dir: [Math.cos(angle), Math.sin(angle)] }
}

/** Whether a run is a straight edge: its points (away from the ends) all lie on one line. */
function isLine(points: readonly Point[]): boolean {
  if (points.length < 3) return true
  const { at, dir } = lineThrough(points)
  const off = (p: Point) => Math.abs((p[0] - at[0]) * dir[1] - (p[1] - at[1]) * dir[0])
  const skip = points.length > 8 ? 2 : points.length > 4 ? 1 : 0
  for (let i = skip; i < points.length - skip; i++) if (off(points[i] as Point) > LINE_TOLERANCE) return false
  // The ends are rounded off by their corners, but must still be close to the line.
  return off(points[0] as Point) <= 1.5 && off(points[points.length - 1] as Point) <= 1.5
}

function intersect(a: { at: Point; dir: Point }, b: { at: Point; dir: Point }): Point | null {
  const cross = a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0]
  if (Math.abs(cross) < 0.2) return null
  const d = sub(b.at, a.at)
  const t = (d[0] * b.dir[1] - d[1] * b.dir[0]) / cross
  return add2(a.at, mul(a.dir, t))
}

const bezier = (p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point => {
  const m = 1 - t
  const a = m * m * m
  const b = 3 * m * m * t
  const c = 3 * m * t * t
  const d = t * t * t
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]
}

/** Schneider's curve fitting: cubic curves through `points` that leave along `t1` and arrive against `t2`. */
function fitCurve(points: readonly Point[], t1: Point, t2: Point, tolerance: number, out: Segment[], depth = 0): void {
  const first = points[0] as Point
  const last = points[points.length - 1] as Point
  if (points.length <= 2) {
    out.push({ to: last })
    return
  }
  // Chord-length parameters.
  let u: number[] = [0]
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1] as Point, points[i] as Point]
    u.push((u[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  const total = u[u.length - 1] || 1
  u = u.map((value) => value / total)
  let best: { c1: Point; c2: Point; error: number; at: number } | null = null
  for (let round = 0; round < 4; round++) {
    // Least squares for the two handle lengths.
    let c00 = 0
    let c01 = 0
    let c11 = 0
    let x0 = 0
    let x1 = 0
    for (let i = 0; i < points.length; i++) {
      const t = u[i] as number
      const m = 1 - t
      const a1 = mul(t1, 3 * m * m * t)
      const a2 = mul(t2, 3 * m * t * t)
      c00 += dot(a1, a1)
      c01 += dot(a1, a2)
      c11 += dot(a2, a2)
      const base = add2(mul(first, m * m * m + 3 * m * m * t), mul(last, 3 * m * t * t + t * t * t))
      const rest = sub(points[i] as Point, base)
      x0 += dot(a1, rest)
      x1 += dot(a2, rest)
    }
    const det = c00 * c11 - c01 * c01
    const chord = Math.hypot(last[0] - first[0], last[1] - first[1])
    let l1 = Math.abs(det) > 1e-9 ? (x0 * c11 - x1 * c01) / det : 0
    let l2 = Math.abs(det) > 1e-9 ? (c00 * x1 - c01 * x0) / det : 0
    if (l1 < chord * 1e-3 || l2 < chord * 1e-3 || l1 > total * 2 || l2 > total * 2) l1 = l2 = chord / 3
    const c1 = add2(first, mul(t1, l1))
    const c2 = add2(last, mul(t2, l2))
    let error = 0
    let at = Math.floor(points.length / 2)
    for (let i = 1; i < points.length - 1; i++) {
      const p = bezier(first, c1, c2, last, u[i] as number)
      const distance = Math.hypot(p[0] - (points[i] as Point)[0], p[1] - (points[i] as Point)[1])
      if (distance > error) {
        error = distance
        at = i
      }
    }
    if (!best || error < best.error) best = { c1, c2, error, at }
    if (error <= tolerance) break
    // Newton step: move each parameter towards the nearest point of the curve.
    u = u.map((t, i) => {
      const p = points[i] as Point
      const q = bezier(first, c1, c2, last, t)
      const d1 = add2(add2(mul(sub(c1, first), 3 * (1 - t) * (1 - t)), mul(sub(c2, c1), 6 * (1 - t) * t)), mul(sub(last, c2), 3 * t * t))
      const d2 = add2(mul(add2(sub(c2, mul(c1, 2)), first), 6 * (1 - t)), mul(add2(sub(last, mul(c2, 2)), c1), 6 * t))
      const diff = sub(q, p)
      const denominator = dot(d1, d1) + dot(diff, d2)
      return Math.abs(denominator) < 1e-9 ? t : Math.min(1, Math.max(0, t - dot(diff, d1) / denominator))
    })
  }
  const fit = best as { c1: Point; c2: Point; error: number; at: number }
  if (fit.error <= tolerance || points.length <= 4 || depth > 12) {
    out.push({ c1: fit.c1, c2: fit.c2, to: last })
    return
  }
  const at = Math.min(points.length - 2, Math.max(1, fit.at))
  const centre = unit(sub(points[at - 1] as Point, points[at + 1] as Point))
  fitCurve(points.slice(0, at + 1), t1, centre, tolerance, out, depth + 1)
  fitCurve(points.slice(at), mul(centre, -1), t2, tolerance, out, depth + 1)
}

/**
 * Turns a closed loop of edge points (about a pixel apart) into a clean outline: corners stay
 * corners, straight edges become single lines meeting at their true corner, and everything else
 * becomes smooth curves that stay within CURVE_TOLERANCE of the edge.
 */
export function fitLoop(loop: readonly Point[]): Outline | null {
  const n = loop.length
  if (n < 6) return null
  const at = (i: number) => loop[((i % n) + n) % n] as Point
  // Turn at each point, looking CORNER_REACH points each way.
  const turn = loop.map((_, i) => {
    const a = unit(sub(at(i), at(i - CORNER_REACH)))
    const b = unit(sub(at(i + CORNER_REACH), at(i)))
    return Math.acos(Math.min(1, Math.max(-1, dot(a, b))))
  })
  const corners: number[] = []
  for (let i = 0; i < n; i++) {
    const here = turn[i] as number
    if (here < CORNER_ANGLE) continue
    let peak = true
    for (let k = 1; k <= CORNER_REACH && peak; k++) {
      // Ties go to the earlier point, so a plateau gives one corner.
      if ((turn[(i - k + n) % n] as number) >= here || (turn[(i + k) % n] as number) > here) peak = false
    }
    if (peak) corners.push(i)
  }
  const isCorner = new Set(corners)
  // A loop with fewer than two corners still needs two places to start and end its curves.
  const anchors = [...corners]
  if (anchors.length < 2) {
    const base = anchors[0] ?? 0
    anchors.push((base + Math.floor(n / 2)) % n)
    if (anchors.length < 2) anchors.push(base)
    anchors.sort((a, b) => a - b)
  }
  const runs = anchors.map((from, k) => {
    const to = anchors[(k + 1) % anchors.length] as number
    const length = ((to - from + n) % n) || n
    const points = Array.from({ length: length + 1 }, (_, j) => at(from + j))
    return { from, to, points, line: isLine(points) }
  })
  // Where two straight edges meet, the corner is where their lines cross (the trace rounds it off).
  const position = new Map<number, Point>()
  runs.forEach((run, k) => {
    const next = runs[(k + 1) % runs.length] as (typeof runs)[number]
    if (!run.line || !next.line || !isCorner.has(run.to) || run.points.length < 4 || next.points.length < 4) return
    const cross = intersect(lineThrough(run.points), lineThrough(next.points))
    const traced = at(run.to)
    if (cross && Math.hypot(cross[0] - traced[0], cross[1] - traced[1]) <= 2) position.set(run.to, cross)
  })
  const placed = (i: number) => position.get(i) ?? at(i)
  const tangent = (i: number, direction: 1 | -1): Point => {
    if (isCorner.has(i)) return unit(sub(at(i + 2 * direction), at(i)))
    return unit(mul(sub(at(i + 2), at(i - 2)), direction))
  }
  const segments: Segment[] = []
  for (const run of runs) {
    if (run.line) {
      segments.push({ to: placed(run.to) })
      continue
    }
    const points = [...run.points]
    points[0] = placed(run.from)
    points[points.length - 1] = placed(run.to)
    fitCurve(points, tangent(run.from, 1), tangent(run.to, -1), CURVE_TOLERANCE, segments)
  }
  return { start: placed((runs[0] as (typeof runs)[number]).from), segments }
}

/** Coordinate pairs an outline needs when written as a path. */
export const outlinePoints = (outline: Outline): number => outline.segments.reduce((sum, segment) => sum + (segment.c1 ? 3 : 1), 0)

/** SVG path data for an outline, with each coordinate passed through `unit`. */
export function outlinePath(outline: Outline, format: (value: number) => string): string {
  const pair = (point: Point) => `${format(point[0])} ${format(point[1])}`
  return `M${pair(outline.start)}${outline.segments.map((s) => (s.c1 && s.c2 ? `C${pair(s.c1)} ${pair(s.c2)} ${pair(s.to)}` : `L${pair(s.to)}`)).join('')}Z`
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

/**
 * The outlines of a frame, one layer per main colour other than the background, largest first.
 * Empty when the frame is one flat colour or is not flat graphics.
 */
export function traceFrame(data: Uint8Array, width: number, height: number, options: TraceOptions): TracedLayer[] {
  const order = options.order ?? 'rgba'
  const palette = measurePalette(data, width, height, { order, maxColors: 12 }).filter((color) => color.share >= 0.004)
  if (palette.length < 2) return []
  const [ri, bi] = order === 'bgra' ? [2, 0] : [0, 2]
  /** Each pixel's nearest colour among `colors` (255 if none is close enough). */
  const assign = (colors: readonly (typeof palette)[number][], limit: number): Uint8Array => {
    const out = new Uint8Array(width * height)
    for (let i = 0; i < width * height; i++) {
      const r = data[i * 4 + ri] as number
      const g = data[i * 4 + 1] as number
      const b = data[i * 4 + bi] as number
      let best = 255
      let bestDistance = limit
      colors.forEach((color, k) => {
        const distance = Math.hypot(r - color.rgb[0], g - color.rgb[1], b - color.rgb[2])
        if (distance < bestDistance) {
          bestDistance = distance
          best = k
        }
      })
      out[i] = best
    }
    return out
  }
  // Soft edges show up as extra in-between colours that only exist as a thin rim around shapes.
  // A colour is solid if its area is thick: more than a pixel and a half of area per pixel of rim.
  const first = assign(palette, MAX_DISTANCE)
  const solid = palette.filter((_, k) => {
    if (k === 0) return true
    let pixels = 0
    let rim = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (first[y * width + x] !== k) continue
        pixels++
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || first[y * width + x - 1] !== k || first[y * width + x + 1] !== k || first[(y - 1) * width + x] !== k || first[(y + 1) * width + x] !== k) rim++
      }
    }
    return rim > 0 && pixels / rim > 1.5
  })
  if (solid.length < 2) return []
  // Rim pixels then go to whichever solid colour they are nearer, which puts the edge half way.
  // A soft edge pixel can be far from both colours it blends (mid grey between black and white),
  // so a pixel also counts when it lies on the straight blend between its two nearest colours.
  // Pixels far from every solid colour and every blend (a gradient, a photo) stay out of every layer.
  const nearest = new Uint8Array(width * height).fill(255)
  for (let i = 0; i < width * height; i++) {
    const pixel: [number, number, number] = [data[i * 4 + ri] as number, data[i * 4 + 1] as number, data[i * 4 + bi] as number]
    let first = -1
    let second = -1
    let d1 = Infinity
    let d2 = Infinity
    solid.forEach((color, k) => {
      const distance = Math.hypot(pixel[0] - color.rgb[0], pixel[1] - color.rgb[1], pixel[2] - color.rgb[2])
      if (distance < d1) [second, d2, first, d1] = [first, d1, k, distance]
      else if (distance < d2) [second, d2] = [k, distance]
    })
    if (d1 < MAX_DISTANCE * 1.5) nearest[i] = first
    else if (second >= 0) {
      const a = (solid[first] as (typeof palette)[number]).rgb
      const b = (solid[second] as (typeof palette)[number]).rgb
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const
      const t = Math.min(1, Math.max(0, ((pixel[0] - a[0]) * ab[0] + (pixel[1] - a[1]) * ab[1] + (pixel[2] - a[2]) * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1)))
      if (Math.hypot(pixel[0] - a[0] - ab[0] * t, pixel[1] - a[1] - ab[1] * t, pixel[2] - a[2] - ab[2] * t) < BLEND_DISTANCE) nearest[i] = first
    }
  }
  const maxPoints = options.maxPoints ?? 1500
  const layers: TracedLayer[] = []
  let total = 0
  // Index 0 is the background (the largest share).
  const distanceTo = (i: number, color: (typeof palette)[number]) =>
    Math.hypot((data[i * 4 + ri] as number) - color.rgb[0], (data[i * 4 + 1] as number) - color.rgb[1], (data[i * 4 + bi] as number) - color.rgb[2])
  for (let k = 1; k < solid.length; k++) {
    const mask = new Uint8Array(width * height)
    for (let i = 0; i < mask.length; i++) mask[i] = nearest[i] === k ? 1 : 0
    // How much a pixel belongs to this colour rather than the nearest other one: a soft edge
    // pixel is in between, which places the outline inside the pixel instead of on its border.
    const coverage = (x: number, y: number): number => {
      if (x < 0 || y < 0 || x >= width || y >= height) return 0
      const i = y * width + x
      const own = distanceTo(i, solid[k] as (typeof palette)[number])
      let other = Infinity
      for (let j = 0; j < solid.length; j++) if (j !== k) other = Math.min(other, distanceTo(i, solid[j] as (typeof palette)[number]))
      return own + other === 0 ? 0.5 : other / (own + other)
    }
    const outlines = traceLoops(mask, width, height)
      .filter((loop) => area(loop) >= MIN_AREA)
      .map((loop) => fitLoop(smoothLoop(resampleLoop(refineLoop(loop, coverage)), 1)))
      .filter((outline): outline is Outline => outline !== null && outline.segments.length >= 2)
    if (outlines.length === 0) continue
    const points = outlines.reduce((sum, outline) => sum + outlinePoints(outline), 0)
    total += points
    if (total > maxPoints) return []
    const format = (value: number) => String(Math.round((value / options.scale) * 100) / 100)
    const d = outlines.map((outline) => outlinePath(outline, format)).join('')
    const [r, g, b] = (solid[k] as (typeof palette)[number]).rgb
    layers.push({ color: hex(r, g, b), d, points })
  }
  return layers
}

export interface TracedFrame {
  timestampMs: number
  /** `rest` for a resting state, `moving` for an in-between shape of a movement. */
  state: 'rest' | 'moving'
  layers: TracedLayer[]
}

/**
 * The traced frames without the outlines that lie inside `boxes` (CSS px): text that is set in
 * a real font instead needs no outline, and they would crowd the prompt.
 */
export function withoutBoxes(frames: readonly TracedFrame[], boxes: readonly { x: number; y: number; width: number; height: number }[], margin = 2): TracedFrame[] {
  if (boxes.length === 0) return [...frames]
  const inside = (subpath: string) => {
    const numbers = [...subpath.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]))
    if (numbers.length < 2) return false
    const xs = numbers.filter((_, i) => i % 2 === 0)
    const ys = numbers.filter((_, i) => i % 2 === 1)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    return boxes.some((box) => x0 >= box.x - margin && x1 <= box.x + box.width + margin && y0 >= box.y - margin && y1 <= box.y + box.height + margin)
  }
  return frames.map((frame) => ({
    ...frame,
    layers: frame.layers.flatMap((layer) => {
      const kept = layer.d.split(/(?=M)/).filter((subpath) => subpath && !inside(subpath))
      return kept.length ? [{ ...layer, d: kept.join('') }] : []
    }),
  }))
}

/** The traced frames as lines for the model's prompt; empty if there are none. */
export function describeTraces(frames: readonly TracedFrame[]): string {
  const traced = frames.filter((frame) => frame.layers.length > 0)
  if (traced.length === 0) return ''
  const lines = [
    'Traced outlines: gil traced these shapes from the capture\'s own pixels. They are exact, in CSS px from the top left of the region, one SVG path per flat colour (fill each with fill-rule="evenodd"). Use them as the geometry of letters, logos, marks, icons and other drawn shapes: place these paths (or paths with the same coordinates) instead of drawing the shape yourself or typing text in a font. For a shape that morphs, the frames marked "moving" are its real in-between shapes at those moments: make the animated path pass through them at those times. Keep paths that morph into each other compatible (same number and order of points) by resampling them. A traced frame can also contain page content that was passing behind the thing (large text or blocks cut off by the edge of the region): leave those out.',
  ]
  for (const frame of traced) {
    lines.push(`At ${frame.timestampMs} ms (${frame.state === 'rest' ? 'at rest' : 'mid-movement'}):`)
    for (const layer of frame.layers) lines.push(`  fill ${layer.color}: ${layer.d}`)
  }
  return lines.join('\n')
}
