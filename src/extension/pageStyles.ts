import type { Rect } from '../shared/geometry'
import { collectStyles, MAX_PAGE_BOXES, MAX_PAGE_MOTIONS, px, transitionsOf, type PageBox, type PageMotion, type PageStyles } from '../shared/pageStyles'

/**
 * Reads the computed styles of what is inside the selection, in the page (the overlay's
 * isolated world can read the page's DOM and computed styles). Values only: no code, no fonts.
 */

/** At most this many text runs inside the selection are read. */
const MAX_TEXT_NODES = 3000
/** At most this many nodes are visited in all, so a huge page cannot stall the overlay. */
const MAX_VISITED = 50_000
/** Background and border colours are sampled on a grid of this many points per side. */
const GRID = 10

function intersects(a: DOMRect, b: Rect): boolean {
  return a.width > 0 && a.height > 0 && a.right > b.x && a.left < b.x + b.width && a.bottom > b.y && a.top < b.y + b.height
}

export function readPageStyles(region: Rect, ignore: Element | null): PageStyles {
  const texts: Parameters<typeof collectStyles>[0][number][] = []
  const colors: Parameters<typeof collectStyles>[1][number][] = []
  // Whole subtrees outside the selection are skipped, so a long page scrolled far down is cheap.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element
        if (ignore && (element === ignore || ignore.contains(element))) return NodeFilter.FILTER_REJECT
        const box = element.getBoundingClientRect()
        // Elements with no box (display: contents) can still hold visible text.
        if (box.width > 0 && box.height > 0 && !intersects(box, region) && getComputedStyle(element).overflow !== 'visible') {
          return NodeFilter.FILTER_REJECT
        }
        return NodeFilter.FILTER_SKIP
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const range = document.createRange()
  let read = 0
  let visited = 0
  for (let node = walker.nextNode(); node && read < MAX_TEXT_NODES && visited < MAX_VISITED; node = walker.nextNode()) {
    visited++
    const content = node.textContent?.replace(/\s+/g, ' ').trim()
    const parent = node.parentElement
    if (!content || !parent) continue
    range.selectNodeContents(node)
    if (![...range.getClientRects()].some((rect) => intersects(rect, region))) continue
    read++
    const style = getComputedStyle(parent)
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue
    const fontSize = px(style.fontSize)
    if (fontSize === null || fontSize <= 0) continue
    const lineHeight = px(style.lineHeight)
    texts.push({
      sample: content.slice(0, 60),
      // Within the bridge's limits, so one odd value never makes it refuse the capture.
      fontFamily: style.fontFamily.slice(0, 300),
      fontSize,
      lineHeight: lineHeight !== null && lineHeight > 0 ? lineHeight : null,
      fontWeight: Number(style.fontWeight) || 400,
      letterSpacing: px(style.letterSpacing) ?? 0,
      color: style.color.slice(0, 100),
    })
    colors.push({ value: style.color.slice(0, 100), use: 'text' })
  }
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = region.x + ((i + 0.5) / GRID) * region.width
      const y = region.y + ((j + 0.5) / GRID) * region.height
      for (const element of document.elementsFromPoint(x, y)) {
        if (ignore && (element === ignore || ignore.contains(element))) continue
        const style = getComputedStyle(element)
        colors.push({ value: style.backgroundColor.slice(0, 100), use: 'background' })
        if ((px(style.borderTopWidth) ?? 0) > 0) colors.push({ value: style.borderTopColor.slice(0, 100), use: 'border' })
        // Only the topmost painted element at this point matters for its background.
        if (!/rgba\([^)]*,\s*0\)$/.test(style.backgroundColor)) break
      }
    }
  }
  return { ...collectStyles(texts, colors), boxes: readBoxes(region, ignore), motions: readMotions(region, ignore) }
}

/** The tag with its id or first class: enough to tell elements apart, never their content. */
function labelOf(element: Element): string {
  const name = element.id ? `#${element.id}` : element.classList.length ? `.${element.classList[0]}` : ''
  return `${element.tagName.toLowerCase()}${name}`.slice(0, 60)
}

const round = (value: number) => Math.round(value * 10) / 10

/** Elements that are mostly inside the selection and paint something of their own. */
function elementsIn(region: Rect, ignore: Element | null): Element[] {
  const found: Element[] = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const element = node as Element
      if (ignore && (element === ignore || ignore.contains(element))) return NodeFilter.FILTER_REJECT
      const box = element.getBoundingClientRect()
      if (box.width > 0 && box.height > 0 && !intersects(box, region) && getComputedStyle(element).overflow !== 'visible') return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let visited = 0
  for (let node = walker.nextNode(); node && visited < MAX_VISITED; node = walker.nextNode()) {
    visited++
    const element = node as Element
    const box = element.getBoundingClientRect()
    if (box.width < 2 || box.height < 2) continue
    // Clamped at 0: an element outside on both axes must not multiply two negatives into "inside".
    const inside =
      Math.max(0, Math.min(box.right, region.x + region.width) - Math.max(box.left, region.x)) *
      Math.max(0, Math.min(box.bottom, region.y + region.height) - Math.max(box.top, region.y))
    // At least half of it is in the clip.
    if (inside < box.width * box.height * 0.5) continue
    found.push(element)
  }
  return found
}

function readBoxes(region: Rect, ignore: Element | null): PageBox[] {
  const boxes: PageBox[] = []
  for (const element of elementsIn(region, ignore)) {
    const style = getComputedStyle(element)
    // Only elements that draw something or hold text directly: wrappers add nothing.
    const paints =
      !/rgba\([^)]*,\s*0\)$/.test(style.backgroundColor) ||
      (px(style.borderTopWidth) ?? 0) > 0 ||
      style.backgroundImage !== 'none' ||
      style.boxShadow !== 'none' ||
      ['IMG', 'SVG', 'VIDEO', 'CANVAS', 'BUTTON', 'INPUT'].includes(element.tagName.toUpperCase()) ||
      [...element.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())
    if (!paints) continue
    const box = element.getBoundingClientRect()
    boxes.push({
      label: labelOf(element),
      x: round(box.left - region.x),
      y: round(box.top - region.y),
      width: round(box.width),
      height: round(box.height),
      radius: style.borderRadius.slice(0, 60),
      padding: style.padding.slice(0, 60),
    })
  }
  // The largest first: the structure matters more than the smallest details.
  return boxes.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, MAX_PAGE_BOXES)
}

function readMotions(region: Rect, ignore: Element | null): PageMotion[] {
  const motions: PageMotion[] = []
  const elements = elementsIn(region, ignore)
  const inClip = new Set(elements)
  // Animations running right now (looping loaders, entrances caught mid-way).
  for (const animation of document.getAnimations()) {
    const effect = animation.effect
    if (!(effect instanceof KeyframeEffect) || !effect.target || !inClip.has(effect.target)) continue
    const timing = effect.getComputedTiming()
    const frames = effect.getKeyframes()
    const properties = [...new Set(frames.flatMap((frame) => Object.keys(frame).filter((key) => !['offset', 'easing', 'composite', 'computedOffset'].includes(key))))]
    const summary = frames
      .map((frame) => `${Math.round((frame.computedOffset ?? 0) * 100)}% ${properties.map((property) => `${property}: ${String(frame[property] ?? '')}`).join(', ')}`)
      .join(' | ')
    motions.push({
      kind: 'animation',
      label: labelOf(effect.target),
      properties: properties.join(', ').slice(0, 200),
      durationMs: typeof timing.duration === 'number' ? round(timing.duration) : 0,
      delayMs: round(timing.delay ?? 0),
      easing: String(timing.easing ?? 'linear').slice(0, 120),
      iterations: Number.isFinite(timing.iterations) ? (timing.iterations as number) : -1,
      keyframes: summary.slice(0, 400),
    })
  }
  // Transitions the page declares: what a hover or a click will use.
  const seen = new Set<string>()
  for (const element of elements) {
    for (const transition of transitionsOf(getComputedStyle(element))) {
      const key = `${labelOf(element)}|${transition.properties}|${transition.durationMs}|${transition.delayMs}|${transition.easing}`
      if (seen.has(key)) continue
      seen.add(key)
      motions.push({ kind: 'transition', label: labelOf(element), ...transition, easing: transition.easing.slice(0, 120) })
    }
  }
  return motions.slice(0, MAX_PAGE_MOTIONS)
}
