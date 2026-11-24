import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assetSchema, migrateAsset, type Asset } from '../shared/asset'
import { isValidSlug, uniqueSlug } from '../shared/slug'

/**
 * The library is a folder of asset folders and the files are the source of truth.
 * This module does not import Electron so it can be tested against a temp directory.
 */

export const ASSET_FILE = 'asset.json'
export const CAPTURE_DIR = 'capture'
export const CLIP_FILE = 'clip.mp4'
export const POSTER_FILE = 'poster.png'
/** The part of the capture the user asked for, when that is not all of it: the clip cut in time and area, and its first frame. */
export const FOCUS_CLIP_FILE = 'focus.mp4'
export const FOCUS_POSTER_FILE = 'focus.png'
export const FOCUS_FILE = 'focus.json'
/** Original files of an imported asset. */
export const FILES_DIR = 'files'
/** The user's notes on an asset, and a note asset's text. */
export const NOTES_FILE = 'notes.md'

/** Work-in-progress folders start with a dot so every reader skips them. */
const STAGING_PREFIX = '.staging-'

export interface SkippedFolder {
  folder: string
  reason: string
}

export interface LibraryScan {
  /** Newest first. */
  assets: Asset[]
  /** Folders without a valid asset.json. Reported, never deleted. */
  skipped: SkippedFolder[]
}

/** Writes to a temp name in the same directory, then renames, so readers never see a partial file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, data)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export async function writeAssetJson(assetDir: string, asset: Asset): Promise<void> {
  await writeFileAtomic(join(assetDir, ASSET_FILE), `${JSON.stringify(asset, null, 2)}\n`)
}

async function listFolders(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
}

/**
 * Reads every asset in the library. `readOnly` (for the MCP server) neither creates the library
 * folder nor writes upgraded asset.json files back; upgrades then happen in memory only.
 */
export async function scanLibrary(root: string, options: { readOnly?: boolean } = {}): Promise<LibraryScan> {
  if (!options.readOnly) await mkdir(root, { recursive: true })
  const assets: Asset[] = []
  const skipped: SkippedFolder[] = []

  for (const folder of await listFolders(root)) {
    let raw: string
    try {
      raw = await readFile(join(root, folder, ASSET_FILE), 'utf8')
    } catch {
      skipped.push({ folder, reason: `${ASSET_FILE} is missing or unreadable` })
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      skipped.push({ folder, reason: `${ASSET_FILE} is not valid JSON` })
      continue
    }
    const { value, migrated } = migrateAsset(json)
    const parsed = assetSchema.safeParse(value)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.join('.') || ASSET_FILE
      skipped.push({ folder, reason: `${where}: ${issue?.message ?? 'invalid'}` })
      continue
    }
    if (parsed.data.name !== folder) {
      skipped.push({ folder, reason: `name "${parsed.data.name}" does not match the folder name` })
      continue
    }
    if (migrated && !options.readOnly) {
      try {
        await writeAssetJson(join(root, folder), parsed.data)
      } catch {
        // Still usable in memory; the upgrade is retried on the next scan.
      }
    }
    assets.push(parsed.data)
  }

  assets.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  return { assets, skipped }
}

/**
 * Creates a hidden folder inside the library to assemble a new capture in.
 * It lives in the library so the final rename is on one volume and therefore atomic.
 */
export async function createStagingDir(root: string, id: string): Promise<string> {
  const dir = join(root, `${STAGING_PREFIX}${id}`)
  await mkdir(join(dir, CAPTURE_DIR), { recursive: true })
  return dir
}

export async function discardStagingDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

function isNameTaken(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOTEMPTY' || code === 'EEXIST'
}

/**
 * Publishes a staged capture as an asset folder. Picks a free name starting from `baseName`,
 * writes asset.json with that name, then renames the staging folder into place in one step.
 */
export async function commitStagedAsset(
  root: string,
  stagingDir: string,
  baseName: string,
  build: (name: string) => Asset,
): Promise<Asset> {
  const taken = new Set(await listFolders(root))
  for (;;) {
    const name = uniqueSlug(baseName, taken)
    const asset = assetSchema.parse(build(name))
    if (asset.name !== name) throw new Error('Asset name must equal its folder name')
    await writeAssetJson(stagingDir, asset)
    try {
      await rename(stagingDir, join(root, name))
      return asset
    } catch (error) {
      // Another writer took the name between listing and renaming: try the next one.
      if (!isNameTaken(error)) throw error
      taken.add(name)
    }
  }
}

export const FRAMES_DIR = 'frames'
/** Motion measured from every frame of the clip (see shared/motion.ts). */
export const MOTION_FILE = 'motion.json'
export const SPEC_FILE = 'spec.json'
export const SPEC_MD_FILE = 'spec.md'
export const RECREATION_DIR = 'recreation'
export const RECREATION_FILE = 'index.html'
/** What Claude wrote, kept so the user's edits can be changed or reverted. */
export const RECREATION_BASE_FILE = 'base.html'
/** The recreation as first made by analysis, kept through every Refine and edit. */
export const RECREATION_FIRST_FILE = 'first.html'
export const EDITS_FILE = 'edits.json'
/** The changes the user asked for with Refine, so later rounds keep them. */
export const REFINEMENTS_FILE = 'refinements.json'

/** Reads and validates one asset, upgrading an older format in memory. */
export async function readAsset(root: string, name: string): Promise<Asset> {
  const json: unknown = JSON.parse(await readFile(join(root, name, ASSET_FILE), 'utf8'))
  const asset = assetSchema.parse(migrateAsset(json).value)
  if (asset.name !== name) throw new Error(`name "${asset.name}" does not match the folder name`)
  return asset
}

/**
 * Applies `change` to an asset's asset.json and writes it back atomically, keeping fields this
 * version does not know about. The name cannot be changed here; use `renameAsset`.
 */
export async function updateAsset(
  root: string,
  name: string,
  change: (asset: Asset) => Asset,
): Promise<Asset> {
  const current = await readAsset(root, name)
  const next = assetSchema.parse(change(current))
  if (next.name !== name || next.id !== current.id) throw new Error('updateAsset cannot rename')
  await writeAssetJson(join(root, name), next)
  return next
}

/** Finds an asset by its permanent id, whatever it is called now. */
export async function findAssetById(root: string, id: string): Promise<Asset | null> {
  const { assets } = await scanLibrary(root)
  return assets.find((asset) => asset.id === id) ?? null
}

/**
 * Renames an asset to exactly `newName`, folder and asset.json together, or fails if the name
 * is not valid or already taken. For names the user types.
 */
export async function renameAssetTo(root: string, name: string, newName: string): Promise<Asset> {
  if (!isValidSlug(newName)) throw new Error(`"${newName}" is not a valid name`)
  if (newName === name) return readAsset(root, name)
  if ((await listFolders(root)).includes(newName)) throw new Error(`"${newName}" is already taken`)
  const current = await readAsset(root, name)
  try {
    await rename(join(root, name), join(root, newName))
  } catch (error) {
    if (isNameTaken(error)) throw new Error(`"${newName}" is already taken`, { cause: error })
    throw error
  }
  const renamed = assetSchema.parse({ ...current, name: newName })
  await writeAssetJson(join(root, newName), renamed)
  return renamed
}

/**
 * Renames an asset: picks a free name starting from `baseName`, moves the folder, and writes
 * the new name into asset.json, so folder and name always agree once it returns.
 */
export async function renameAsset(root: string, name: string, baseName: string): Promise<Asset> {
  const current = await readAsset(root, name)
  const taken = new Set((await listFolders(root)).filter((folder) => folder !== name))
  for (;;) {
    const next = uniqueSlug(baseName, taken)
    if (next === name) return current
    try {
      await rename(join(root, name), join(root, next))
    } catch (error) {
      if (!isNameTaken(error)) throw error
      taken.add(next)
      continue
    }
    const renamed = assetSchema.parse({ ...current, name: next })
    await writeAssetJson(join(root, next), renamed)
    return renamed
  }
}

/**
 * Moves the library from where an earlier version kept it (the app was called Gilbert, with
 * the library at ~/Documents/Gilbert) to its current place, in one rename. Does nothing if
 * there is no old folder, or if the new one already exists, so nothing is ever merged or lost.
 */
export async function moveLegacyLibrary(root: string, legacyRoot: string): Promise<'moved' | 'kept'> {
  const exists = (path: string) =>
    stat(path).then(
      (stats) => stats.isDirectory(),
      () => false,
    )
  if (!(await exists(legacyRoot)) || (await exists(root))) return 'kept'
  await rename(legacyRoot, root)
  return 'moved'
}
