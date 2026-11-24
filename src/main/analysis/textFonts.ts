import { nativeImage } from 'electron'
import { closestWeight, findFamily, type CatalogEntry } from '../../shared/fontCatalog'
import { fitText, type FittedText } from '../../shared/fontEmbed'
import { grayOf, inkMask, inkSimilarity, normalizeInk } from '../../shared/fontMatch'
import type { Frame } from './claude'
import { fontCatalog, fontFile, fontKey } from '../fonts'
import { renderStill } from './render'

/**
 * Text as real fonts: for each run of text the plan lists, gil sets the same text in the free
 * fonts the plan suggests (and the page's own font, when the Chrome extension read it), keeps the
 * one whose letter shapes match the capture best, and measures the size, letter spacing and
 * position that put its ink exactly on the capture's. The build then sets real text instead of
 * drawing letters from traced outlines, which look lumpy at small sizes. No model call; only
 * font downloads leave the Mac, and they carry nothing about the capture.
 */

/** One run of text from the plan, in CSS px from the region's top left. */
export interface PlanText {
  text: string
  x: number
  y: number
  width: number
  height: number
  weight: number
  italic: boolean
  fontName: string
  candidates: string[]
}

/** Texts matched per analysis, and fonts tried per text; each font is a download the first time. */
const MAX_TEXTS = 6
const MAX_CANDIDATES = 9
/** Samples are set at this size, large enough to measure well. */
const SAMPLE_PX = 120
/**
 * Small text (ink lower than this, CSS px) takes the best match if it is at least SMALL_OK: at
 * that size a clean real font beats a traced outline even when the match is loose. Larger text
 * must match LARGE_OK, or it stays traced: it may be lettering no free font has.
 */
const SMALL_TEXT_PX = 14
const SMALL_OK = 35
const LARGE_OK = 75
/** Around the plan's box (CSS px), since the model's boxes are a little off. */
const MARGIN_PX = 3

type Box = { x: number; y: number; width: number; height: number }

const escape = (text: string) => text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)

/** The text set in a font at SAMPLE_PX: its ink for comparing, and its ink box from the element's top left. */
async function sample(text: string, data: Buffer, weight: number, italic: boolean) {
  const pad = SAMPLE_PX
  const width = Math.min(6000, Math.round(SAMPLE_PX * Math.max(2, [...text].length) * 1.1) + pad * 2)
  const html = `<style>@font-face{font-family:c;src:url(data:font/woff2;base64,${data.toString('base64')}) format("woff2");font-weight:${weight};font-style:${italic ? 'italic' : 'normal'}}
html,body{margin:0;background:#fff}p{position:absolute;left:${pad}px;top:${pad}px;margin:0;font:${italic ? 'italic ' : ''}${weight} ${SAMPLE_PX}px/1 c;color:#000;white-space:nowrap}</style><p>${escape(text)}</p>`
  const image = await renderStill(html, width, SAMPLE_PX + pad * 2)
  const size = image.getSize()
  const gray = grayOf(image.toBitmap(), size.width, size.height)
  const ink = inkMask(gray, size.width, size.height)
  const normal = normalizeInk(gray, size.width, size.height)
  if (!ink || !normal) return null
  // The window may be drawn at more than one pixel per CSS px.
  const scale = size.width / width
  return { normal, box: { x: ink.box.x / scale - pad, y: ink.box.y / scale - pad, width: ink.box.width / scale, height: ink.box.height / scale } }
}

/**
 * Matches and measures the plan's texts against `frame` (a resting frame of the capture).
 * `pageFamilies` are font families the page itself used, tried first. Texts with no good
 * enough match are left out, and so is everything if the fonts cannot be reached.
 */
export async function fitTexts(
  frame: Frame,
  capture: { width: number; height: number },
  texts: readonly PlanText[],
  pageFamilies: readonly string[] = [],
): Promise<FittedText[]> {
  const wanted = texts.filter((text) => text.text.trim() && text.width > 0 && text.height > 0).slice(0, MAX_TEXTS)
  if (wanted.length === 0) return []
  let catalog: CatalogEntry[]
  try {
    catalog = await fontCatalog()
  } catch (error) {
    console.error('Could not get the font list; text stays traced', error)
    return []
  }
  const image = nativeImage.createFromBuffer(Buffer.from(frame.data))
  const size = image.getSize()
  const scale = size.width / capture.width
  // Every font tried for every text; lines that share their suggestions then share one font.
  const tried: { text: PlanText; small: boolean; options: (FittedText & { sample: Box })[] }[] = []
  for (const text of wanted) {
    try {
      const left = Math.max(0, Math.floor((text.x - MARGIN_PX) * scale))
      const top = Math.max(0, Math.floor((text.y - MARGIN_PX) * scale))
      const right = Math.min(size.width, Math.ceil((text.x + text.width + MARGIN_PX) * scale))
      const bottom = Math.min(size.height, Math.ceil((text.y + text.height + MARGIN_PX) * scale))
      if (right - left < 4 || bottom - top < 4) continue
      const crop = image.crop({ x: left, y: top, width: right - left, height: bottom - top })
      const cropSize = crop.getSize()
      const gray = grayOf(crop.toBitmap(), cropSize.width, cropSize.height)
      const ink = inkMask(gray, cropSize.width, cropSize.height)
      const target = normalizeInk(gray, cropSize.width, cropSize.height)
      if (!ink || !target) continue
      // A crop can be drawn at a different pixel size than asked for.
      const cropScale = (cropSize.width / (right - left)) * scale
      const inkBox = {
        x: left / scale + ink.box.x / cropScale,
        y: top / scale + ink.box.y / cropScale,
        width: ink.box.width / cropScale,
        height: ink.box.height / cropScale,
      }
      const entries: CatalogEntry[] = []
      // The page's own fonts first, but only a couple, so the plan's suggestions are always tried.
      for (const name of [...new Set(pageFamilies)].slice(0, 2).concat(text.fontName, text.candidates)) {
        const entry = findFamily(catalog, name)
        if (entry && !entries.includes(entry)) entries.push(entry)
      }
      const options: (FittedText & { sample: Box })[] = []
      for (const entry of entries.slice(0, MAX_CANDIDATES)) {
        const weight = closestWeight(entry, text.weight)
        // One font that cannot be fetched or drawn must not cost the others.
        const data = await fontFile(entry, weight, text.italic).catch(() => null)
        const set = data ? await sample(text.text, data, weight, text.italic).catch(() => null) : null
        if (!set) continue
        const score = inkSimilarity(target, set.normal)
        const fit = fitText(text.text, SAMPLE_PX, set.box, inkBox)
        if (!fit) continue
        const round = (value: number) => Math.round(value * 10) / 10
        options.push({
          text: text.text,
          family: entry.family,
          weight,
          italic: text.italic && entry.styles.includes('italic'),
          key: fontKey(entry, weight, text.italic),
          score,
          ...fit,
          sample: set.box,
          ink: { x: round(inkBox.x), y: round(inkBox.y), width: round(inkBox.width), height: round(inkBox.height) },
        })
      }
      if (options.length) tried.push({ text, small: inkBox.height < SMALL_TEXT_PX, options })
    } catch (error) {
      console.error(`Could not match a font for "${text.text}"; it stays traced`, error)
    }
  }
  const fitted: FittedText[] = []
  const groupOf = (text: PlanText) => `${text.weight}|${text.italic}|${text.fontName}|${text.candidates.join(',')}`
  for (const group of new Set(tried.map((entry) => groupOf(entry.text)))) {
    const members = tried.filter((entry) => groupOf(entry.text) === group)
    // The font with the best total match over the group's lines, among those every line could be set in.
    const totals = new Map<string, number>()
    for (const member of members) for (const option of member.options) totals.set(option.key, (totals.get(option.key) ?? 0) + option.score)
    const shared = [...totals].filter(([key]) => members.every((member) => member.options.some((option) => option.key === key))).sort((a, b) => b[1] - a[1])[0]?.[0]
    const chosen = members.flatMap((member) => {
      const choice = member.options.find((option) => option.key === shared) ?? [...member.options].sort((a, b) => b.score - a.score)[0]
      return choice && choice.score >= (member.small ? SMALL_OK : LARGE_OK) ? [choice] : []
    })
    // Lines of one paragraph are one size: sizes within a tenth of each other take the size of
    // the longest line, whose measurement is the steadiest.
    const longest = [...chosen].sort((a, b) => b.ink.width - a.ink.width)[0]
    for (const choice of chosen) {
      const { sample: box, ...text } = choice
      const same = longest && choice !== longest && choice.key === longest.key && Math.abs(choice.fontSize - longest.fontSize) <= longest.fontSize * 0.1
      const refit = same ? fitText(text.text, SAMPLE_PX, box, text.ink, longest.fontSize) : null
      fitted.push(refit ? { ...text, ...refit } : text)
    }
  }
  return fitted
}
