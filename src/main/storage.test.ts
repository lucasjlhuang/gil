import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCaptureAsset, newAssetId } from '../shared/asset'
import {
  commitStagedAsset,
  createStagingDir,
  discardStagingDir,
  findAssetById,
  moveLegacyLibrary,
  renameAsset,
  renameAssetTo,
  updateAsset,
  scanLibrary,
  writeFileAtomic,
} from './storage'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gil-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function buildAsset(id: string, now: Date) {
  return (name: string) =>
    createCaptureAsset({
      id,
      name,
      title: 'Capture',
      userContext: null,
      capture: {
        mode: 'recording',
        width: 100,
        height: 50,
        scale: 2,
        durationMs: 1000,
        isStill: false,
      },
      now,
    })
}

async function stageAndCommit(baseName: string, now = new Date('2026-10-13T18:04:11Z')) {
  const id = newAssetId(now)
  const staging = await createStagingDir(root, id)
  await writeFile(join(staging, 'capture', 'clip.mp4'), 'clip')
  await writeFile(join(staging, 'capture', 'poster.png'), 'poster')
  return commitStagedAsset(root, staging, baseName, buildAsset(id, now))
}

describe('writeFileAtomic', () => {
  it('writes the file and leaves no temp files behind', async () => {
    await writeFileAtomic(join(root, 'a.json'), '{}')
    expect(await readdir(root)).toEqual(['a.json'])
    expect(await readFile(join(root, 'a.json'), 'utf8')).toBe('{}')
  })

  it('replaces an existing file', async () => {
    await writeFileAtomic(join(root, 'a.json'), 'one')
    await writeFileAtomic(join(root, 'a.json'), 'two')
    expect(await readFile(join(root, 'a.json'), 'utf8')).toBe('two')
  })
})

describe('commitStagedAsset', () => {
  it('publishes the documented folder layout', async () => {
    const asset = await stageAndCommit('capture-20261013-180411')
    expect(asset.name).toBe('capture-20261013-180411')
    expect(await readdir(root)).toEqual(['capture-20261013-180411'])
    expect((await readdir(join(root, asset.name))).sort()).toEqual(['asset.json', 'capture'])
    expect((await readdir(join(root, asset.name, 'capture'))).sort()).toEqual([
      'clip.mp4',
      'poster.png',
    ])
    const onDisk = JSON.parse(await readFile(join(root, asset.name, 'asset.json'), 'utf8'))
    expect(onDisk).toEqual(asset)
  })

  it('picks the next free name and keeps name equal to folder', async () => {
    await stageAndCommit('card')
    const second = await stageAndCommit('card')
    expect(second.name).toBe('card-2')
    const onDisk = JSON.parse(await readFile(join(root, 'card-2', 'asset.json'), 'utf8'))
    expect(onDisk.name).toBe('card-2')
  })
})

describe('scanLibrary', () => {
  it('creates a missing library folder and returns nothing', async () => {
    const fresh = join(root, 'nested', 'gil')
    expect(await scanLibrary(fresh)).toEqual({ assets: [], skipped: [] })
  })

  it('returns assets newest first', async () => {
    await stageAndCommit('older', new Date('2026-10-13T10:00:00Z'))
    await stageAndCommit('newer', new Date('2026-10-13T11:00:00Z'))
    const { assets } = await scanLibrary(root)
    expect(assets.map((asset) => asset.name)).toEqual(['newer', 'older'])
  })

  it('ignores staging folders and loose files', async () => {
    await createStagingDir(root, newAssetId())
    await writeFile(join(root, '.DS_Store'), '')
    await writeFile(join(root, 'readme.txt'), '')
    expect(await scanLibrary(root)).toEqual({ assets: [], skipped: [] })
  })

  it('upgrades a version 1 asset.json on disk', async () => {
    const asset = await stageAndCommit('old-capture')
    const capture = { ...asset.capture }
    delete capture.mode
    const path = join(root, 'old-capture', 'asset.json')
    await writeFile(path, JSON.stringify({ ...asset, schemaVersion: 1, capture }))

    const { assets, skipped } = await scanLibrary(root)
    expect(skipped).toEqual([])
    expect(assets).toEqual([asset])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(asset)
  })

  it('skips and reports invalid folders without touching them', async () => {
    await mkdir(join(root, 'no-json'))
    await mkdir(join(root, 'bad-json'))
    await writeFile(join(root, 'bad-json', 'asset.json'), '{nope')
    await mkdir(join(root, 'wrong-shape'))
    await writeFile(join(root, 'wrong-shape', 'asset.json'), '{"schemaVersion":1}')
    const valid = await stageAndCommit('real-name')
    await mkdir(join(root, 'renamed-by-hand'))
    await writeFile(join(root, 'renamed-by-hand', 'asset.json'), JSON.stringify(valid))

    const { assets, skipped } = await scanLibrary(root)
    expect(assets.map((asset) => asset.name)).toEqual(['real-name'])
    expect(skipped.map((entry) => entry.folder).sort()).toEqual([
      'bad-json',
      'no-json',
      'renamed-by-hand',
      'wrong-shape',
    ])
    expect((await readdir(root)).length).toBe(5)
  })
})

describe('discardStagingDir', () => {
  it('removes the staging folder', async () => {
    const staging = await createStagingDir(root, newAssetId())
    await discardStagingDir(staging)
    expect(await readdir(root)).toEqual([])
  })
})

describe('updateAsset and renameAsset', () => {
  it('updates asset.json and keeps unknown fields', async () => {
    const asset = await stageAndCommit('card')
    const path = join(root, 'card', 'asset.json')
    await writeFile(path, JSON.stringify({ ...asset, futureField: 1 }))
    const updated = await updateAsset(root, 'card', (current) => ({ ...current, status: 'ready' }))
    expect(updated.status).toBe('ready')
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ status: 'ready', futureField: 1 })
  })

  it('refuses to change the name through updateAsset', async () => {
    await stageAndCommit('card')
    await expect(updateAsset(root, 'card', (a) => ({ ...a, name: 'other' }))).rejects.toThrow()
  })

  it('renames folder and name together, picking a free name', async () => {
    const first = await stageAndCommit('capture-20261013-180411')
    await stageAndCommit('glass-nav')
    const renamed = await renameAsset(root, first.name, 'glass-nav')
    expect(renamed.name).toBe('glass-nav-2')
    expect(renamed.id).toBe(first.id)
    expect((await readdir(root)).sort()).toEqual(['glass-nav', 'glass-nav-2'])
    const onDisk = JSON.parse(await readFile(join(root, 'glass-nav-2', 'asset.json'), 'utf8'))
    expect(onDisk.name).toBe('glass-nav-2')
    expect((await findAssetById(root, first.id))?.name).toBe('glass-nav-2')
  })
})

describe('renameAssetTo', () => {
  it('renames to exactly the name given', async () => {
    const asset = await stageAndCommit('card')
    const renamed = await renameAssetTo(root, 'card', 'soft-lift-card')
    expect(renamed).toMatchObject({ id: asset.id, name: 'soft-lift-card' })
    expect(await readdir(root)).toEqual(['soft-lift-card'])
  })

  it('refuses a taken or invalid name and leaves the asset alone', async () => {
    await stageAndCommit('card')
    await stageAndCommit('other')
    await expect(renameAssetTo(root, 'card', 'other')).rejects.toThrow('already taken')
    await expect(renameAssetTo(root, 'card', 'Not Valid')).rejects.toThrow('not a valid name')
    expect((await readdir(root)).sort()).toEqual(['card', 'other'])
  })
})

describe('moveLegacyLibrary', () => {
  it('moves the old library folder to the new place', async () => {
    const legacy = join(root, 'Gilbert')
    const current = join(root, 'gil')
    await mkdir(join(legacy, 'card'), { recursive: true })
    expect(await moveLegacyLibrary(current, legacy)).toBe('moved')
    expect(await readdir(root)).toEqual(['gil'])
    expect(await readdir(current)).toEqual(['card'])
  })

  it('never merges into an existing library or invents one', async () => {
    const legacy = join(root, 'Gilbert')
    const current = join(root, 'gil')
    expect(await moveLegacyLibrary(current, legacy)).toBe('kept')
    await mkdir(legacy)
    await mkdir(current)
    expect(await moveLegacyLibrary(current, legacy)).toBe('kept')
    expect((await readdir(root)).sort()).toEqual(['Gilbert', 'gil'])
  })
})
