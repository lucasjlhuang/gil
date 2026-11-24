import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { ASSET_SCHEMA_VERSION, assetSchema, formatTimestamp, newAssetId, type Asset } from '../shared/asset'
import { measureLayout } from '../shared/layoutMeasure'
import { PAGE_STYLES_FILE, pageStylesSchema } from '../shared/pageStyles'
import { measureSpacing, spacingPage, spacingSystemSpec, type Box } from '../shared/spacingSystem'
import { parseSpec, specToMarkdown } from '../shared/spec'
import { cssGray } from './analysis/check'
import {
  CAPTURE_DIR,
  commitStagedAsset,
  createStagingDir,
  discardStagingDir,
  findAssetById,
  readAsset,
  POSTER_FILE,
  RECREATION_BASE_FILE,
  RECREATION_DIR,
  RECREATION_FILE,
  SPEC_FILE,
  SPEC_MD_FILE,
  writeFileAtomic,
} from './storage'

/**
 * The spacing lens: turns any asset with an image into a spacing and grid system, measured on
 * the Mac with no model call (shared/spacingSystem.ts). The boxes come from the page itself when
 * the capture came through the Chrome extension, otherwise they are cut from the pixels.
 */

/** The boxes in a capture, in CSS px: the page's own when there are enough, else from the pixels. */
async function boxesOf(captureDir: string, width: number, height: number): Promise<Box[]> {
  const page = await readFile(join(captureDir, PAGE_STYLES_FILE), 'utf8')
    .then((text) => pageStylesSchema.parse(JSON.parse(text)))
    .catch(() => null)
  const fromPage = (page?.boxes ?? []).filter((box) => box.width >= 2 && box.height >= 2)
  if (fromPage.length >= 3) return fromPage
  const image = nativeImage.createFromPath(join(captureDir, POSTER_FILE))
  if (image.isEmpty()) return []
  const { gray, pxPerCss } = cssGray(image, width, height)
  return measureLayout(gray).map((box) => ({ x: box.x / pxPerCss, y: box.y / pxPerCss, width: box.width / pxPerCss, height: box.height / pxPerCss }))
}

/** The boxes gil measures spacing from, for one asset (for the benchmark's debugging). */
export async function boxesOfAsset(root: string, name: string): Promise<Box[]> {
  const asset = await readAsset(root, name)
  if (!asset.capture) return []
  return boxesOf(join(root, name, CAPTURE_DIR), asset.capture.width, asset.capture.height)
}

export async function makeSpacingSystem(root: string, id: string): Promise<Asset> {
  const source = await findAssetById(root, id)
  if (!source?.capture) throw new Error('The spacing lens needs an asset with a capture or an image')
  const captureDir = join(root, source.name, CAPTURE_DIR)
  const boxes = await boxesOf(captureDir, source.capture.width, source.capture.height)
  if (boxes.length < 2) throw new Error(`gil found too few separate things in ${source.name} to measure spacing; it needs a plain background between them`)
  // An analysis of the same capture already named the spacing values the design meant.
  const analyzed = await readFile(join(root, source.name, SPEC_FILE), 'utf8').then(parseSpec).catch(() => null)
  const system = measureSpacing(boxes, source.capture.width, analyzed?.tokens.spacing.map((step) => step.value) ?? [])
  if (system.measured === 0) throw new Error(`gil found no spaces between things in ${source.name}`)
  const spec = spacingSystemSpec(system, source.name)
  const title = `${source.title} spacing`

  const newId = newAssetId()
  let staging: string | null = await createStagingDir(root, newId)
  try {
    await mkdir(join(staging, CAPTURE_DIR), { recursive: true })
    await mkdir(join(staging, RECREATION_DIR), { recursive: true })
    await copyFile(join(captureDir, POSTER_FILE), join(staging, CAPTURE_DIR, POSTER_FILE))
    const page = spacingPage(system, title, source.capture)
    await writeFileAtomic(join(staging, RECREATION_DIR, RECREATION_BASE_FILE), page)
    await writeFileAtomic(join(staging, RECREATION_DIR, RECREATION_FILE), page)
    await writeFileAtomic(join(staging, SPEC_FILE), `${JSON.stringify(spec, null, 2)}\n`)
    const now = formatTimestamp(new Date())
    const summary = [
      system.unit ? `${system.unit} px unit` : 'no common unit',
      `${system.scale.length} spacing step${system.scale.length === 1 ? '' : 's'}`,
      system.grid ? `${system.grid.columns}-column grid` : '',
    ].filter(Boolean)
    const stagingDir = staging
    const asset = await commitStagedAsset(root, stagingDir, `${source.name}-spacing`.slice(0, 48).replace(/-+$/, ''), (name) =>
      assetSchema.parse({
        schemaVersion: ASSET_SCHEMA_VERSION,
        id: newId,
        name,
        title,
        aliases: [],
        tags: ['spacing', ...source.tags.filter((tag) => tag !== 'spacing')].slice(0, 20),
        kind: 'spacing-system',
        lens: 'spacing',
        origin: source.origin,
        status: 'ready',
        summary: `${summary.join(', ')}, measured from ${source.name}.`,
        userContext: null,
        source: source.source,
        capture: { ...source.capture, mode: 'screenshot', durationMs: 0, isStill: true },
        analysis: null,
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
