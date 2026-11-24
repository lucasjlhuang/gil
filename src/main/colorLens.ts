import { copyFile, cp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { ASSET_SCHEMA_VERSION, assetSchema, formatTimestamp, newAssetId, type Asset, type AssetLens } from '../shared/asset'
import { PAGE_STYLES_FILE } from '../shared/pageStyles'
import { isProvisionalName, provisionalName } from '../shared/slug'
import { assignRoles, colorSystemSpec, swatchPage, withAnalysisColors } from '../shared/colorSystem'
import { describePalette, edgeColor, measurePalette, type PaletteColor } from '../shared/palette'
import { parseSpec, specToMarkdown } from '../shared/spec'
import {
  CAPTURE_DIR,
  CLIP_FILE,
  commitStagedAsset,
  createStagingDir,
  discardStagingDir,
  FILES_DIR,
  findAssetById,
  POSTER_FILE,
  readAsset,
  RECREATION_BASE_FILE,
  RECREATION_DIR,
  RECREATION_FILE,
  SPEC_FILE,
  SPEC_MD_FILE,
  renameAsset,
  updateAsset,
  writeFileAtomic,
} from './storage'

/**
 * The colour lens: turns any asset with an image into a colour system asset, with colours
 * measured from its pixels and a swatch page written by gil. No model call, so it is free,
 * instant and always gives the same result.
 */

/** The palette of an image file and the colour along its edges, as prompt lines; '' if it cannot be read. */
export function describeImagePalette(path: string): string {
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) return ''
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  const palette = measurePalette(bitmap, width, height, { order: 'bgra' })
  return describePalette(palette, edgeColor(bitmap, width, height, palette, 'bgra'))
}

/** The palette of an image file (PNG or JPEG). */
export function paletteOfImage(path: string): PaletteColor[] {
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) return []
  const { width, height } = image.getSize()
  // toBitmap is BGRA on macOS.
  return measurePalette(image.toBitmap(), width, height, { order: 'bgra' })
}

export async function makeColorSystem(root: string, id: string): Promise<Asset> {
  const source = await findAssetById(root, id)
  if (!source?.capture) throw new Error('The colour lens needs an asset with a capture or an image')
  const poster = join(root, source.name, CAPTURE_DIR, POSTER_FILE)
  const palette = paletteOfImage(poster)
  if (palette.length === 0) throw new Error(`gil could not read the colours of ${source.name}`)
  // An analysis of the same capture already named the colours and knows the ones too small to measure.
  const analyzed = await readFile(join(root, source.name, SPEC_FILE), 'utf8').then(parseSpec).catch(() => null)
  const roles = analyzed ? withAnalysisColors(assignRoles(palette), analyzed.tokens.colors) : assignRoles(palette)
  const spec = colorSystemSpec(roles, source.name)
  const title = `${source.title} colours`

  const newId = newAssetId()
  let staging: string | null = await createStagingDir(root, newId)
  try {
    await mkdir(join(staging, CAPTURE_DIR), { recursive: true })
    await mkdir(join(staging, RECREATION_DIR), { recursive: true })
    await copyFile(poster, join(staging, CAPTURE_DIR, POSTER_FILE))
    const page = swatchPage(roles, title)
    await writeFileAtomic(join(staging, RECREATION_DIR, RECREATION_BASE_FILE), page)
    await writeFileAtomic(join(staging, RECREATION_DIR, RECREATION_FILE), page)
    await writeFileAtomic(join(staging, SPEC_FILE), `${JSON.stringify(spec, null, 2)}\n`)
    const now = formatTimestamp(new Date())
    const stagingDir = staging
    const asset = await commitStagedAsset(root, stagingDir, `${source.name}-colors`.slice(0, 48).replace(/-+$/, ''), (name) => {
      const built = assetSchema.parse({
        schemaVersion: ASSET_SCHEMA_VERSION,
        id: newId,
        name,
        title,
        aliases: [],
        tags: ['colors', ...source.tags.filter((tag) => tag !== 'colors')].slice(0, 20),
        kind: 'color-system',
        lens: 'color',
        origin: source.origin,
        status: 'ready',
        summary: `${roles.length} colours from ${source.name}, ${roles.filter((role) => !role.estimated).length} measured.`,
        userContext: null,
        source: source.source,
        capture: { ...source.capture, mode: 'screenshot', durationMs: 0, isStill: true },
        analysis: null,
        createdAt: now,
        updatedAt: now,
      })
      return built
    })
    staging = null
    await writeFileAtomic(join(root, asset.name, SPEC_MD_FILE), specToMarkdown(spec, { title: asset.title, name: asset.name }))
    return asset
  } finally {
    if (staging) await discardStagingDir(staging)
  }
}

/**
 * The colour lens chosen at capture: the captured asset itself becomes the colour system,
 * renamed from its capture-time name to `colors` (or `colors-2`…).
 */
export async function applyColorLens(root: string, name: string): Promise<Asset> {
  const asset = await readAsset(root, name)
  if (!asset.capture) throw new Error('The colour lens needs a capture or an image')
  const palette = paletteOfImage(join(root, name, CAPTURE_DIR, POSTER_FILE))
  if (palette.length === 0) throw new Error(`gil could not read the colours of ${name}`)
  const roles = assignRoles(palette)
  const spec = colorSystemSpec(roles, 'this capture')
  const title = isProvisionalName(name) ? asset.title.replace(/^(Capture|Image)/, 'Colours') : asset.title
  await mkdir(join(root, name, RECREATION_DIR), { recursive: true })
  const page = swatchPage(roles, title)
  await writeFileAtomic(join(root, name, RECREATION_DIR, RECREATION_BASE_FILE), page)
  await writeFileAtomic(join(root, name, RECREATION_DIR, RECREATION_FILE), page)
  await writeFileAtomic(join(root, name, SPEC_FILE), `${JSON.stringify(spec, null, 2)}\n`)
  let saved = await updateAsset(root, name, (current) => ({
    ...current,
    title,
    kind: 'color-system',
    status: 'ready',
    summary: `${palette.length} colours measured from the capture.`,
    tags: current.tags.includes('colors') ? current.tags : ['colors', ...current.tags].slice(0, 20),
    capture: current.capture ? { ...current.capture, isStill: true } : current.capture,
    analysis: null,
    updatedAt: formatTimestamp(new Date()),
  }))
  if (isProvisionalName(saved.name)) saved = await renameAsset(root, saved.name, 'colors')
  await writeFileAtomic(join(root, saved.name, SPEC_MD_FILE), specToMarkdown(spec, { title: saved.title, name: saved.name }))
  return saved
}

/**
 * Another lens on a saved asset: a new asset with the same capture (clip and poster), set to
 * `lens`, not analyzed yet. Named `<source>-<lens>`.
 */
export async function duplicateForLens(root: string, id: string, lens: Exclude<AssetLens, 'auto' | 'color' | 'font' | 'spacing'>): Promise<Asset> {
  const source = await findAssetById(root, id)
  if (!source?.capture) throw new Error('Another lens needs an asset with a capture or an image')
  const newId = newAssetId()
  let staging: string | null = await createStagingDir(root, newId)
  try {
    // The capture as captured (clip, poster, page styles) and an imported original; not what
    // analysis made from it (frames, measured motion), which the new lens makes again.
    await mkdir(join(staging, CAPTURE_DIR), { recursive: true })
    for (const file of [CLIP_FILE, POSTER_FILE, PAGE_STYLES_FILE]) {
      await copyFile(join(root, source.name, CAPTURE_DIR, file), join(staging, CAPTURE_DIR, file)).catch(() => undefined)
    }
    await cp(join(root, source.name, FILES_DIR), join(staging, FILES_DIR), { recursive: true }).catch(() => undefined)
    const now = new Date()
    const label = { motion: 'motion', component: 'component', layout: 'layout', type: 'type', effects: 'effects', icons: 'icons', transition: 'transition', scroll: 'scroll' }[lens]
    // A capture not named yet gets a fresh capture-time name, so analysis can still name it.
    const baseName = isProvisionalName(source.name)
      ? provisionalName(now, source.origin === 'import' ? 'image' : 'capture')
      : `${source.name}-${label}`.slice(0, 48).replace(/-+$/, '')
    const timestamp = formatTimestamp(now)
    const asset = await commitStagedAsset(root, staging, baseName, (name) =>
      assetSchema.parse({
        schemaVersion: ASSET_SCHEMA_VERSION,
        id: newId,
        name,
        title: `${source.title} (${label})`,
        aliases: [],
        tags: source.tags,
        kind: 'other',
        lens,
        origin: source.origin,
        status: 'stored',
        summary: null,
        userContext: null,
        source: source.source,
        capture: source.capture,
        analysis: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    )
    staging = null
    return asset
  } finally {
    if (staging) await discardStagingDir(staging)
  }
}
