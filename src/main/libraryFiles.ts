import { cp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { GLOSSARY_FILE, GLOSSARY_VERSION, normalizeTerms, parseGlossary, readGlossaryText, type GlossaryTerm } from '../shared/glossary'
import { createDesignSystemAsset, createNoteAsset, designSystemSummary, formatTimestamp, newAssetId, noteSummary, type Asset } from '../shared/asset'
import { DESIGN_SYSTEM_FILE, DESIGN_SYSTEM_VERSION, normalizeMembers, parseDesignSystem } from '../shared/designSystem'
import { slugify } from '../shared/slug'
import { commitStagedAsset, createStagingDir, discardStagingDir, findAssetById, NOTES_FILE, scanLibrary, updateAsset, writeFileAtomic } from './storage'

/** Library-level files beside the asset folders, and copying an asset out. No Electron. */

export async function readGlossary(root: string): Promise<GlossaryTerm[]> {
  return parseGlossary(await readFile(join(root, GLOSSARY_FILE), 'utf8').catch(() => null)).terms
}

export async function saveGlossary(root: string, terms: readonly { term: string; meaning: string }[]): Promise<void> {
  const terms_ = normalizeTerms(terms)
  const current = readGlossaryText(
    await readFile(join(root, GLOSSARY_FILE), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    }),
  )
  // A file that is there but unreadable (hand-edited, or from a newer gil) is never overwritten.
  if (!current) throw new Error(`${GLOSSARY_FILE} in the library folder could not be read, so it was left as it is`)
  // Keeps fields a newer version may have added.
  const next = { ...current, version: GLOSSARY_VERSION, terms: terms_ }
  await writeFileAtomic(join(root, GLOSSARY_FILE), `${JSON.stringify(next, null, 2)}\n`)
}

/**
 * Copies an asset's folder into `destination`, as `<name>`, or `<name>-2`… if that is taken.
 * Returns the new folder's path.
 */
export async function exportAsset(root: string, id: string, destination: string): Promise<string> {
  const asset = await findAssetById(root, id)
  if (!asset) throw new Error('That asset is no longer in the library')
  for (let n = 1; n < 1000; n++) {
    const target = join(destination, n === 1 ? asset.name : `${asset.name}-${n}`)
    const taken = await stat(target).then(() => true, () => false)
    if (taken) continue
    await cp(join(root, asset.name), target, { recursive: true, errorOnExist: true, force: false })
    return target
  }
  throw new Error('Could not find a free name in that folder')
}

export const MAX_NOTE_LENGTH = 100_000

/** A new note asset, named after its title, with its text in notes.md. */
export async function createNote(root: string, title: string, text: string): Promise<Asset> {
  const cleanTitle = title.trim()
  if (!cleanTitle) throw new Error('Give the note a title')
  if (text.length > MAX_NOTE_LENGTH) throw new Error('That note is too long')
  const id = newAssetId()
  let staging: string | null = await createStagingDir(root, id)
  try {
    await writeFileAtomic(join(staging, NOTES_FILE), text)
    const asset = await commitStagedAsset(root, staging, slugify(cleanTitle) ?? 'note', (name) =>
      createNoteAsset({ id, name, title: cleanTitle, text, now: new Date() }),
    )
    staging = null
    return asset
  } finally {
    if (staging) await discardStagingDir(staging)
  }
}

/** The user's notes on an asset (a note's text); '' when there are none. */
export async function readNotes(root: string, name: string): Promise<string> {
  return readFile(join(root, name, NOTES_FILE), 'utf8').catch(() => '')
}

/**
 * Sets what the user wants recreated from a capture, in their own words; empty clears it. The
 * next analysis reads it (the plan describes only that part and gil cuts its work to it).
 */
export async function setFocus(root: string, id: string, text: string): Promise<void> {
  const asset = await findAssetById(root, id)
  if (!asset) throw new Error('That asset is no longer in the library')
  if (!asset.capture) throw new Error('Only captures can be analyzed')
  // Analysis may rename the folder when it finishes.
  if (asset.status === 'analyzing') throw new Error('Wait for the analysis to finish first')
  const context = text.trim() || null
  await updateAsset(root, asset.name, (current) => ({ ...current, userContext: context, updatedAt: formatTimestamp(new Date()) }))
}

/** Saves an asset's notes; empty notes remove the file. A note's summary follows its text. */
export async function saveNotes(root: string, id: string, text: string): Promise<void> {
  if (text.length > MAX_NOTE_LENGTH) throw new Error('Those notes are too long')
  const asset = await findAssetById(root, id)
  if (!asset) throw new Error('That asset is no longer in the library')
  // Analysis may rename the folder when it finishes.
  if (asset.status === 'analyzing') throw new Error('Wait for the analysis to finish first')
  const dir = join(root, asset.name)
  if (text.trim()) await writeFileAtomic(join(dir, NOTES_FILE), text)
  else await rm(join(dir, NOTES_FILE), { force: true })
  await updateAsset(root, asset.name, (current) => ({
    ...current,
    summary: current.kind === 'note' ? noteSummary(text) : current.summary,
    updatedAt: formatTimestamp(new Date()),
  }))
}

/** Only ids of assets in the library that are not design systems themselves. */
async function existingMembers(root: string, ids: readonly string[]): Promise<string[]> {
  const { assets } = await scanLibrary(root)
  const allowed = new Set(assets.filter((asset) => asset.kind !== 'design-system').map((asset) => asset.id))
  return ids.filter((id) => allowed.has(id))
}

/** A new design system asset bundling `memberIds`. */
export async function createDesignSystem(root: string, title: string, memberIds: readonly string[]): Promise<Asset> {
  const cleanTitle = title.trim()
  if (!cleanTitle) throw new Error('Give the design system a name')
  const id = newAssetId()
  const members = await existingMembers(root, normalizeMembers(memberIds, id))
  let staging: string | null = await createStagingDir(root, id)
  try {
    await writeFileAtomic(join(staging, DESIGN_SYSTEM_FILE), `${JSON.stringify({ version: DESIGN_SYSTEM_VERSION, members }, null, 2)}\n`)
    const asset = await commitStagedAsset(root, staging, slugify(cleanTitle) ?? 'design-system', (name) =>
      createDesignSystemAsset({ id, name, title: cleanTitle, memberCount: members.length, now: new Date() }),
    )
    staging = null
    return asset
  } finally {
    if (staging) await discardStagingDir(staging)
  }
}

/** The ids a design system bundles; [] for any other asset. */
export async function readMembers(root: string, name: string): Promise<string[]> {
  return parseDesignSystem(await readFile(join(root, name, DESIGN_SYSTEM_FILE), 'utf8').catch(() => null)).members
}

export async function setMembers(root: string, id: string, memberIds: readonly string[]): Promise<void> {
  const asset = await findAssetById(root, id)
  if (!asset) throw new Error('That asset is no longer in the library')
  if (asset.kind !== 'design-system') throw new Error('Only a design system has members')
  const path = join(root, asset.name, DESIGN_SYSTEM_FILE)
  const current = parseDesignSystem(await readFile(path, 'utf8').catch(() => null))
  const members = await existingMembers(root, normalizeMembers(memberIds, id))
  await writeFileAtomic(path, `${JSON.stringify({ ...current, version: DESIGN_SYSTEM_VERSION, members }, null, 2)}\n`)
  await updateAsset(root, asset.name, (latest) => ({ ...latest, summary: designSystemSummary(members.length), updatedAt: formatTimestamp(new Date()) }))
}
