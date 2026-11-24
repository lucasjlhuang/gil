import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { ASSET_SCHEMA_VERSION, assetSchema, formatTimestamp, newAssetId, type Asset } from '../shared/asset'
import { closestWeight, findFamily, type CatalogEntry } from '../shared/fontCatalog'
import { fontSpecimenPage, grayOf, inkSimilarity, normalizeInk, type FontResult } from '../shared/fontMatch'
import { SPEC_SCHEMA_VERSION, specToMarkdown, type Spec } from '../shared/spec'
import { createClient, identify } from './analysis/claude'
import { renderStill } from './analysis/render'
import { fontCatalog, fontFile } from './fonts'
import {
  CAPTURE_DIR,
  commitStagedAsset,
  createStagingDir,
  discardStagingDir,
  findAssetById,
  POSTER_FILE,
  RECREATION_BASE_FILE,
  RECREATION_DIR,
  RECREATION_FILE,
  SPEC_FILE,
  SPEC_MD_FILE,
  writeFileAtomic,
} from './storage'

/**
 * Font identification: Claude reads the text and names the typeface and free look-alikes; gil
 * then sets the same text in each look-alike from the Google Fonts catalogue, on this Mac, and
 * ranks them by how closely their letter shapes match the capture (shared/fontMatch.ts). The
 * result is a new font asset beside the source.
 */

export const FONT_FILE = 'font.json'
/** Candidates compared (the model's guess and twelve look-alikes); each needs a font download the first time. */
const MAX_CANDIDATES = 13
/** Best matches embedded in the font asset's page. */
const SHOWN = 3

/** The text set in `family`, black on white, rendered and reduced to its ink. */
async function inkOf(text: string, data: Buffer, weight: number, italic: boolean, height: number): Promise<Uint8Array | null> {
  const size = Math.max(24, Math.min(160, Math.round(height * 0.6)))
  const width = Math.min(4000, Math.round(size * Math.max(4, text.length) * 0.9) + 40)
  const html = `<style>@font-face{font-family:c;src:url(data:font/woff2;base64,${data.toString('base64')}) format("woff2");font-weight:${weight};font-style:${italic ? 'italic' : 'normal'}}
html,body{margin:0;background:#fff}p{margin:0;padding:10px 20px;font:${italic ? 'italic ' : ''}${weight} ${size}px/1.2 c;color:#000;white-space:nowrap}</style><p>${text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</p>`
  const image = await renderStill(html, width, size * 1.2 + 20)
  const { width: w, height: h } = image.getSize()
  return normalizeInk(grayOf(image.toBitmap(), w, h), w, h)
}

export interface RankedFont {
  entry: CatalogEntry
  weight: number
  score: number
  data: Buffer
}

/**
 * Sets `text` in each family and ranks them by how closely their letter shapes match the image
 * at `posterPath`. No model call: the benchmark's `fonts` command uses it directly.
 */
export async function rankFonts(
  posterPath: string,
  cssHeight: number,
  text: string,
  weight: number,
  italic: boolean,
  families: readonly string[],
  box: { x: number; y: number; width: number; height: number } | null = null,
): Promise<{ ranked: RankedFont[]; unknown: string[] }> {
  const full = nativeImage.createFromPath(posterPath)
  if (full.isEmpty()) throw new Error(`gil could not read ${posterPath}`)
  // Only the text being identified, so other text in the capture does not count.
  const size = full.getSize()
  const crop = box ? cropRect(box, size.width, size.height) : null
  const poster = crop ? full.crop(crop) : full
  const { width, height } = poster.getSize()
  const textHeight = crop ? (cssHeight * crop.height) / size.height : cssHeight
  const target = normalizeInk(grayOf(poster.toBitmap(), width, height), width, height)
  if (!target) throw new Error('There is no text to identify in this capture')
  const catalog = await fontCatalog()
  const unknown: string[] = []
  const entries: CatalogEntry[] = []
  for (const name of families) {
    const entry = findFamily(catalog, name)
    if (!entry) unknown.push(name)
    else if (!entries.includes(entry)) entries.push(entry)
  }
  const ranked: RankedFont[] = []
  for (const entry of entries.slice(0, MAX_CANDIDATES)) {
    try {
      const candidateWeight = closestWeight(entry, weight)
      const data = await fontFile(entry, candidateWeight, italic)
      const ink = await inkOf(text, data, candidateWeight, italic, textHeight)
      if (ink) ranked.push({ entry, weight: candidateWeight, score: inkSimilarity(target, ink), data })
    } catch (error) {
      console.error(`Could not compare ${entry.family}`, error)
    }
  }
  ranked.sort((a, b) => b.score - a.score)
  return { ranked, unknown }
}

/** A fractional box as whole pixels, with a small margin, clamped to the image. */
function cropRect(box: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  const margin = 0.01
  const x = Math.floor(clamp(box.x - margin) * width)
  const y = Math.floor(clamp(box.y - margin) * height)
  const right = Math.ceil(clamp(box.x + box.width + margin) * width)
  const bottom = Math.ceil(clamp(box.y + box.height + margin) * height)
  return right - x >= 4 && bottom - y >= 4 ? { x, y, width: right - x, height: bottom - y } : null
}

export async function identifyFont(root: string, id: string, apiKey: string): Promise<Asset> {
  const source = await findAssetById(root, id)
  if (!source?.capture) throw new Error('Font identification needs a capture or an image of text')
  const posterPath = join(root, source.name, CAPTURE_DIR, POSTER_FILE)
  const height = source.capture.height

  const client = createClient(apiKey)
  const answer = await identify(client, { timestampMs: 0, data: await readFile(posterPath), mediaType: 'image/png' })
  const read = answer.output
  // The model's own guess is compared too when it is a free font.
  const families = [...(read.modelGuess ? [read.modelGuess] : []), ...read.candidates]
  const { ranked: scored } = await rankFonts(posterPath, height, read.text, read.weight, read.italic, families, read.box)
  const guess = read.modelGuess ? findFamily(await fontCatalog(), read.modelGuess) : null

  const result: FontResult = {
    version: 1,
    text: read.text,
    modelGuess: read.modelGuess,
    category: read.category,
    weight: read.weight,
    italic: read.italic,
    traits: read.traits,
    matches: scored.map(({ entry, weight, score }) => ({ family: entry.family, id: entry.id, weight, score })),
  }
  const best = scored[0]
  const title = `${best?.entry.family ?? read.modelGuess ?? 'Font'} (from ${source.title})`
  const spec: Spec = {
    schemaVersion: SPEC_SCHEMA_VERSION,
    description: `The typeface of ${source.name}${read.modelGuess ? `, which looks like ${read.modelGuess}` : ''}. ${best ? `The closest free font by shape is ${best.entry.family} (${best.score}% match).` : 'No free match was found.'}`,
    tokens: {
      colors: [],
      typography: [
        {
          level: 'display',
          role: `the text "${read.text}"`,
          family: `${read.category}; ${read.traits.join(', ')}`,
          fontName: best?.entry.family ?? read.modelGuess,
          // The text's height in CSS px (cap to descender), from the box the model gave.
          size: Math.round(Math.min(1, Math.max(0, read.box.height)) * height),
          lineHeight: null,
          weight: read.weight,
          letterSpacing: 0,
          confidence: { family: 'estimated', size: 'estimated', lineHeight: 'estimated', weight: 'estimated', letterSpacing: 'estimated' },
        },
      ],
      radii: [],
      spacing: [],
      shadows: [],
      effects: [],
    },
    layout: { description: 'A font has no layout.', regions: [] },
    motion: [],
    states: [],
    caveats: [
      ...(read.modelGuess && !guess ? [`${read.modelGuess} is not a free Google Font; the matches are its closest free alternatives.`] : []),
      ...result.matches.map((match) => `${match.family} ${match.weight}: ${match.score}% shape match`),
    ],
  }

  const newId = newAssetId()
  let staging: string | null = await createStagingDir(root, newId)
  try {
    await mkdir(join(staging, CAPTURE_DIR), { recursive: true })
    await mkdir(join(staging, RECREATION_DIR), { recursive: true })
    await copyFile(posterPath, join(staging, CAPTURE_DIR, POSTER_FILE))
    await writeFileAtomic(join(staging, FONT_FILE), `${JSON.stringify(result, null, 2)}\n`)
    await writeFileAtomic(join(staging, SPEC_FILE), `${JSON.stringify(spec, null, 2)}\n`)
    const page = fontSpecimenPage(
      result,
      scored.slice(0, SHOWN).map(({ entry, weight, data }) => ({ family: entry.family, weight, dataUrl: `data:font/woff2;base64,${data.toString('base64')}` })),
      title,
    )
    await writeFileAtomic(join(staging, RECREATION_DIR, RECREATION_BASE_FILE), page)
    await writeFileAtomic(join(staging, RECREATION_DIR, RECREATION_FILE), page)
    const now = formatTimestamp(new Date())
    const baseName = `${source.name}-font`.slice(0, 48).replace(/-+$/, '')
    const asset = await commitStagedAsset(root, staging, baseName, (name) =>
      assetSchema.parse({
        schemaVersion: ASSET_SCHEMA_VERSION,
        id: newId,
        name,
        title,
        aliases: [],
        tags: ['font', read.category],
        kind: 'font',
        lens: 'font',
        origin: source.origin,
        status: 'ready',
        summary: best ? `Closest free font: ${best.entry.family} (${best.score}% shape match).` : read.modelGuess ? `Looks like ${read.modelGuess}.` : null,
        userContext: null,
        source: source.source,
        capture: { ...source.capture, mode: 'screenshot', durationMs: 0, isStill: true },
        analysis: { model: answer.model, rounds: 1, error: null, usage: answer.usage },
        createdAt: now,
        updatedAt: now,
      }),
    )
    staging = null
    await writeFileAtomic(join(root, asset.name, SPEC_MD_FILE), specToMarkdown(spec, { title: asset.title, name: asset.name }))
    return asset
  } finally {
    if (staging) await discardStagingDir(staging)
  }
}
