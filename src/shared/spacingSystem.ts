import { SPEC_SCHEMA_VERSION, type Spec } from './spec'

/**
 * The spacing lens without a model call: a spacing and grid system measured from the boxes in a
 * capture (from the page itself through the Chrome extension, or cut from the pixels, see
 * shared/layoutMeasure.ts). Pure.
 *
 * It finds:
 * - the spacing scale: the gaps between neighbouring boxes and their insets from the frame,
 *   grouped into the few distinct values a design uses, and the base unit they are multiples of
 *   (4 or 8 px in most systems);
 * - the grid: when boxes line up in columns, how many, how wide, the gutter between them and
 *   the margins at the sides.
 */

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface SpacingSystem {
  /**
   * The distinct spacing values, smallest first, each with how often it occurs, where it was seen
   * (between things, inside them as padding, or both), and whether it was measured or only named
   * by an earlier analysis (spaces too small or too deep inside things to measure).
   */
  scale: { value: number; count: number; use: 'between' | 'inside' | 'both' | 'named' }[]
  /** The unit the scale is built on, or null when there is none (a design spaced by eye). */
  unit: number | null
  /** Share (0–1) of the measured spaces close to a multiple of `unit`. */
  fit: number
  /** Columns, when the boxes line up in them. */
  grid: { columns: number; columnWidth: number; gutter: number; marginLeft: number; marginRight: number } | null
  /** How many spaces the scale was measured from. */
  measured: number
}

/** Spaces closer than this (px) are the same step of the scale. */
const SAME = 1.5
/** Units tried, largest first: a larger unit that fits explains the design better. */
const UNITS = [12, 10, 8, 6, 5, 4, 3, 2]
/** Share of spaces a unit must explain to count as the design's unit. */
const UNIT_FIT = 0.7
/** Spaces larger than this are layout (a hero's top margin), not the spacing scale. */
const MAX_SPACE = 96

/** The horizontal and vertical gaps between boxes that face each other with nothing between them. */
export function gapsBetween(boxes: readonly Box[]): number[] {
  const gaps: number[] = []
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0)
  for (const a of boxes) {
    // The nearest neighbour to the right and below, among boxes that share some of the other axis.
    let right = Infinity
    let below = Infinity
    for (const b of boxes) {
      if (a === b) continue
      if (overlap(a.y, a.y + a.height, b.y, b.y + b.height) > Math.min(a.height, b.height) * 0.3 && b.x >= a.x + a.width) right = Math.min(right, b.x - (a.x + a.width))
      if (overlap(a.x, a.x + a.width, b.x, b.x + b.width) > Math.min(a.width, b.width) * 0.3 && b.y >= a.y + a.height) below = Math.min(below, b.y - (a.y + a.height))
    }
    for (const gap of [right, below]) if (Number.isFinite(gap) && gap >= 1 && gap <= MAX_SPACE) gaps.push(gap)
  }
  return gaps
}

/** How far each box sits inside the smallest box that holds it, on each side: its padding. */
export function insetsWithin(boxes: readonly Box[]): number[] {
  const insets: number[] = []
  for (const child of boxes) {
    const parents = boxes.filter((b) => b !== child && b.x <= child.x && b.y <= child.y && b.x + b.width >= child.x + child.width && b.y + b.height >= child.y + child.height && b.width * b.height > child.width * child.height)
    const parent = parents.sort((a, b) => a.width * a.height - b.width * b.height)[0]
    if (!parent) continue
    // Only the sides where nothing else sits between the child and the edge count.
    const between = (side: 'left' | 'top' | 'right' | 'bottom') =>
      boxes.some((other) => other !== child && other !== parent && parents.indexOf(other) < 0 && (
        side === 'left' ? other.x + other.width <= child.x && other.x >= parent.x && other.y < child.y + child.height && other.y + other.height > child.y
        : side === 'right' ? other.x >= child.x + child.width && other.x + other.width <= parent.x + parent.width && other.y < child.y + child.height && other.y + other.height > child.y
        : side === 'top' ? other.y + other.height <= child.y && other.y >= parent.y && other.x < child.x + child.width && other.x + other.width > child.x
        : other.y >= child.y + child.height && other.y + other.height <= parent.y + parent.height && other.x < child.x + child.width && other.x + other.width > child.x))
    const sides = { left: child.x - parent.x, top: child.y - parent.y, right: parent.x + parent.width - (child.x + child.width), bottom: parent.y + parent.height - (child.y + child.height) }
    for (const [side, value] of Object.entries(sides) as [keyof typeof sides, number][]) {
      if (value >= 1 && value <= MAX_SPACE && !between(side)) insets.push(value)
    }
  }
  return insets
}

/**
 * Measured steps moved onto the values an analysis of the same capture named, where one is
 * within the measuring error: pixels blur a space by about a pixel, the design meant a round
 * number.
 */
export function snapToNamed(steps: readonly { value: number; count: number }[], named: readonly number[]): { value: number; count: number }[] {
  const out = new Map<number, number>()
  for (const step of steps) {
    const near = [...named].sort((a, b) => Math.abs(a - step.value) - Math.abs(b - step.value))[0]
    const value = near !== undefined && Math.abs(near - step.value) <= SAME ? near : step.value
    out.set(value, (out.get(value) ?? 0) + step.count)
  }
  return [...out].map(([value, count]) => ({ value, count })).sort((a, b) => a.value - b.value)
}

/** Values grouped into steps: each step is the median of values within SAME of each other. */
export function groupValues(values: readonly number[]): { value: number; count: number }[] {
  const sorted = [...values].sort((a, b) => a - b)
  const steps: number[][] = []
  for (const value of sorted) {
    const last = steps[steps.length - 1]
    if (last && value - (last[0] as number) <= SAME) last.push(value)
    else steps.push([value])
  }
  return steps.map((step) => ({ value: Math.round((step[Math.floor(step.length / 2)] as number) * 2) / 2, count: step.length }))
}

/** The largest unit most of the values are multiples of, and the share it explains. */
export function unitOf(values: readonly number[]): { unit: number | null; fit: number } {
  if (values.length < 3) return { unit: null, fit: 0 }
  for (const unit of UNITS) {
    const fits = values.filter((value) => {
      const off = value % unit
      // Measuring is good to about a pixel, but on a small unit a pixel is a large share of a step.
      return Math.min(off, unit - off) <= Math.min(1, unit / 8)
    }).length
    if (fits / values.length >= UNIT_FIT) return { unit, fit: Math.round((fits / values.length) * 100) / 100 }
  }
  return { unit: null, fit: 0 }
}

/**
 * Columns: the top-level boxes in a row that share widths and gutters. Found from the row with
 * the most boxes of nearly equal width, evenly spaced; null when there is no such row of three
 * or more, or two very wide ones.
 */
export function gridOf(boxes: readonly Box[], frameWidth: number): SpacingSystem['grid'] {
  const rows = new Map<number, Box[]>()
  for (const box of boxes) {
    const key = [...rows.keys()].find((y) => Math.abs(y - box.y) <= 8) ?? box.y
    rows.set(key, [...(rows.get(key) ?? []), box])
  }
  let best: SpacingSystem['grid'] = null
  for (const row of rows.values()) {
    const sorted = [...row].sort((a, b) => a.x - b.x)
    if (sorted.length < 2) continue
    const widths = sorted.map((box) => box.width)
    const mean = widths.reduce((sum, w) => sum + w, 0) / widths.length
    if (widths.some((w) => Math.abs(w - mean) > Math.max(4, mean * 0.06))) continue
    const gutters = sorted.slice(1).map((box, i) => box.x - ((sorted[i] as Box).x + (sorted[i] as Box).width))
    const gutter = gutters.reduce((sum, g) => sum + g, 0) / gutters.length
    if (gutters.some((g) => g < 0 || Math.abs(g - gutter) > Math.max(3, gutter * 0.15))) continue
    // Two columns only count when they fill most of the frame; otherwise it is a pair of things.
    const first = sorted[0] as Box
    const last = sorted[sorted.length - 1] as Box
    const spanned = last.x + last.width - first.x
    if (sorted.length === 2 && spanned < frameWidth * 0.6) continue
    if (!best || sorted.length > best.columns) {
      best = {
        columns: sorted.length,
        columnWidth: Math.round(mean),
        gutter: Math.round(gutter),
        marginLeft: Math.round(first.x),
        marginRight: Math.round(frameWidth - (last.x + last.width)),
      }
    }
  }
  return best
}

/**
 * The spacing system of boxes in a frame `width` px wide (CSS px): the gaps between them and
 * their insets inside one another. `named` are spacing values an analysis of the same capture
 * gave, which measured steps are snapped to when they are within the measuring error.
 */
export function measureSpacing(boxes: readonly Box[], width: number, named: readonly number[] = []): SpacingSystem {
  const between = gapsBetween(boxes)
  const inside = insetsWithin(boxes)
  const spaces = [...between, ...inside]
  const steps = snapToNamed(groupValues(spaces), named)
  // Each space counted at its snapped value, so the unit is found from what the design meant.
  const snapped = steps.flatMap((step) => Array.from({ length: step.count }, () => step.value))
  const { unit, fit } = unitOf(snapped)
  // With a unit, a step a little off it next to one on it is the same step measured badly.
  const onUnit = (value: number) => unit !== null && Math.min(value % unit, unit - (value % unit)) <= 0.5
  const merged = new Map<number, number>()
  for (const step of steps) {
    const home = unit !== null && !onUnit(step.value) ? steps.find((other) => other !== step && onUnit(other.value) && Math.abs(other.value - step.value) <= 3) : undefined
    const value = home ? home.value : step.value
    merged.set(value, (merged.get(value) ?? 0) + step.count)
  }
  const near = (list: readonly number[], value: number) => list.some((space) => Math.abs(space - value) <= 3)
  const measured = [...merged]
    .map(([value, count]) => ({ value, count, use: near(between, value) && near(inside, value) ? ('both' as const) : near(inside, value) ? ('inside' as const) : ('between' as const) }))
    .filter((step) => step.count >= 2 || spaces.length < 8)
  // Values the analysis named that nothing measured contradicts: usually the small spaces inside
  // text blocks and buttons, which the boxes cannot show.
  const extra = named
    .filter((value) => value > 0 && value <= MAX_SPACE && !measured.some((step) => Math.abs(step.value - value) <= SAME))
    .map((value) => ({ value, count: 0, use: 'named' as const }))
  const scale = [...measured, ...extra].sort((a, b) => a.value - b.value)
  return { scale, unit, fit, grid: gridOf(boxes, width), measured: spaces.length }
}

/** spec.json for a spacing system: measured spacing and grid, nothing else. */
export function spacingSystemSpec(system: SpacingSystem, sourceName: string): Spec {
  const grid = system.grid
  return {
    schemaVersion: SPEC_SCHEMA_VERSION,
    description: `The spacing and grid of ${sourceName}, measured from the boxes in it by gil.`,
    tokens: {
      colors: [],
      typography: [],
      radii: [],
      spacing: system.scale.map((step) => ({ value: step.value, confidence: step.use === 'named' ? ('estimated' as const) : ('measured' as const) })),
      shadows: [],
      effects: [],
    },
    layout: {
      description: [
        system.unit ? `Spacing is built on a ${system.unit} px unit (${Math.round(system.fit * 100)}% of the ${system.measured} measured spaces are multiples of it).` : `No common unit: the ${system.measured} measured spaces are not multiples of one value.`,
        system.scale.length > 0
          ? `Where each step was seen: ${system.scale.map((step) => `${step.value} px ${step.use === 'between' ? 'between things' : step.use === 'inside' ? 'as padding inside things' : step.use === 'both' ? 'between things and as padding' : 'named by the analysis, not measured'}`).join('; ')}.`
          : '',
        grid
          ? `A ${grid.columns}-column grid: columns ${grid.columnWidth} px wide with ${grid.gutter} px gutters, ${grid.marginLeft} px from the left edge and ${grid.marginRight} px from the right.`
          : 'No column grid: the boxes do not line up in equal columns.',
      ]
        .filter(Boolean)
        .join(' '),
      regions: [],
    },
    motion: [],
    states: [],
    caveats: [
      'Measured values are the gaps between the boxes gil found and their padding inside one another. Spaces inside something gil saw as one box (the padding of a small button, the gap between lines of text) cannot be measured; those marked estimated were named by an analysis of the same capture.',
      'Only the spaces visible in the capture are included, so this is the spacing of that screen, not a whole design system.',
    ],
  }
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** A self-contained specimen page: the scale as bars, the unit, and the grid drawn as columns. */
export function spacingPage(system: SpacingSystem, title: string, frame: { width: number; height: number }): string {
  const grid = system.grid
  const max = Math.max(1, ...system.scale.map((step) => step.value))
  const bars = system.scale
    .map((step) => `<div class="step"><span class="value">${step.value}px</span><span class="bar" style="width:${Math.max(2, (step.value / max) * 100)}%"></span><span class="count">${step.count}×${system.unit ? ` · ${Math.round((step.value / system.unit) * 10) / 10}u` : ''}</span></div>`)
    .join('')
  const columns = grid
    ? `<div class="grid" style="aspect-ratio:${frame.width}/${frame.height}">${Array.from({ length: grid.columns }, (_, i) => `<span style="left:${((grid.marginLeft + i * (grid.columnWidth + grid.gutter)) / frame.width) * 100}%;width:${(grid.columnWidth / frame.width) * 100}%"></span>`).join('')}</div>`
    : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title><style>
:root{--ink:#1d1d1f;--muted:#6e6e73;--bar:#5b6cff;--col:rgba(91,108,255,.14);--line:#e5e5ea}
body{margin:0;padding:24px;font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;color:var(--ink);background:#fff}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 16px;color:var(--muted)}
.step{display:grid;grid-template-columns:64px 1fr 80px;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid var(--line)}
.value{font-variant-numeric:tabular-nums;font-weight:600}.bar{height:10px;background:var(--bar);border-radius:2px}.count{color:var(--muted);font-size:12px}
.grid{position:relative;margin-top:20px;border:1px solid var(--line);border-radius:6px;overflow:hidden}.grid span{position:absolute;top:0;bottom:0;background:var(--col)}
</style></head><body><h1>${escape(title)}</h1><p>${escape(system.unit ? `Built on a ${system.unit} px unit.` : 'No common unit.')} ${escape(grid ? `${grid.columns} columns, ${grid.columnWidth} px wide, ${grid.gutter} px gutters.` : 'No column grid.')}</p>${bars}${columns}<script>window.replay=function(){}</script></body></html>`
}
