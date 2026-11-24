import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { shell } from 'electron'
import { formatTimestamp, type Asset } from '../shared/asset'
import { applyEdits, editsSchema, hasEdits, NO_EDITS, type Edits } from '../shared/edits'
import { normalizeTags } from '../shared/slug'
import { migrateSpec, specSchema, specToMarkdown } from '../shared/spec'
import {
  EDITS_FILE,
  findAssetById,
  RECREATION_BASE_FILE,
  RECREATION_DIR,
  RECREATION_FILE,
  renameAssetTo,
  SPEC_FILE,
  SPEC_MD_FILE,
  updateAsset,
  writeFileAtomic,
} from './storage'

/** Changes the user makes to an asset from the library. Main validates the inputs first. */

async function requireIdle(root: string, id: string): Promise<Asset> {
  const asset = await findAssetById(root, id)
  if (!asset) throw new Error('That asset no longer exists')
  if (asset.status === 'analyzing') throw new Error('Wait for the analysis to finish first')
  return asset
}

/** spec.md carries the name and title, so it is regenerated when either changes. */
export async function writeSpecMarkdown(root: string, asset: Asset): Promise<void> {
  const text = await readFile(join(root, asset.name, SPEC_FILE), 'utf8').catch(() => null)
  if (!text) return
  const parsed = specSchema.safeParse(migrateSpec(JSON.parse(text)))
  if (!parsed.success) return
  await writeFileAtomic(
    join(root, asset.name, SPEC_MD_FILE),
    specToMarkdown(parsed.data, { title: asset.title, name: asset.name }),
  )
}

export async function renameAndRetitle(
  root: string,
  id: string,
  change: { name: string; title: string },
): Promise<Asset> {
  const asset = await requireIdle(root, id)
  const renamed = await renameAssetTo(root, asset.name, change.name)
  const title = change.title.trim() || renamed.title
  const saved = await updateAsset(root, renamed.name, (current) => ({
    ...current,
    title,
    updatedAt: formatTimestamp(new Date()),
  }))
  await writeSpecMarkdown(root, saved)
  return saved
}

export async function setTags(root: string, id: string, tags: readonly string[]): Promise<Asset> {
  const asset = await requireIdle(root, id)
  return updateAsset(root, asset.name, (current) => ({
    ...current,
    tags: normalizeTags(tags),
    updatedAt: formatTimestamp(new Date()),
  }))
}

/** Moves the asset folder to the macOS Trash, where the user can still restore it. */
export async function trashAsset(root: string, id: string): Promise<void> {
  const asset = await requireIdle(root, id)
  await shell.trashItem(join(root, asset.name))
}

export interface Recreation {
  /** What Claude wrote. */
  base: string
  edits: Edits
}

/** The recreation as the editor needs it. Assets analyzed before editing existed have no base. */
export async function readRecreation(root: string, name: string): Promise<Recreation | null> {
  const dir = join(root, name, RECREATION_DIR)
  const base =
    (await readFile(join(dir, RECREATION_BASE_FILE), 'utf8').catch(() => null)) ??
    (await readFile(join(dir, RECREATION_FILE), 'utf8').catch(() => null))
  if (base === null) return null
  const text = await readFile(join(dir, EDITS_FILE), 'utf8').catch(() => null)
  let edits = NO_EDITS
  if (text) {
    try {
      edits = editsSchema.parse(JSON.parse(text))
    } catch {
      // Unreadable edits are ignored rather than breaking the asset.
    }
  }
  return { base, edits }
}

/**
 * Saves the user's edits: edits.json, and index.html rebuilt as the base plus the edits.
 * Saving no edits reverts to exactly what Claude wrote.
 */
export async function saveEdits(root: string, id: string, edits: Edits): Promise<Asset> {
  const asset = await requireIdle(root, id)
  const recreation = await readRecreation(root, asset.name)
  if (!recreation) throw new Error('This asset has no recreation to edit yet')
  const dir = join(root, asset.name, RECREATION_DIR)
  // Older assets have only index.html: keep it as the base before the first edit.
  await writeFileAtomic(join(dir, RECREATION_BASE_FILE), recreation.base)
  if (hasEdits(edits)) {
    await writeFileAtomic(join(dir, EDITS_FILE), `${JSON.stringify(edits, null, 2)}\n`)
  } else {
    await rm(join(dir, EDITS_FILE), { force: true })
  }
  await writeFileAtomic(join(dir, RECREATION_FILE), applyEdits(recreation.base, edits))
  return updateAsset(root, asset.name, (current) => ({ ...current, updatedAt: formatTimestamp(new Date()) }))
}
