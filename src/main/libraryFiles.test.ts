import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCaptureAsset, newAssetId } from '../shared/asset'
import { exportAsset, readGlossary, saveGlossary, setFocus } from './libraryFiles'
import { readAsset, writeAssetJson } from './storage'

let root: string
let out: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gil-lib-'))
  out = await mkdtemp(join(tmpdir(), 'gil-out-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(out, { recursive: true, force: true })
})

describe('glossary', () => {
  it('saves cleaned terms and reads them back', async () => {
    await saveGlossary(root, [
      { term: 'pill', meaning: 'nav highlight' },
      { term: ' ', meaning: ' ' },
    ])
    expect(await readGlossary(root)).toEqual([{ term: 'pill', meaning: 'nav highlight' }])
    expect(JSON.parse(await readFile(join(root, 'glossary.json'), 'utf8')).version).toBe(1)
  })

  it('never overwrites a glossary file it cannot read', async () => {
    await writeFile(join(root, 'glossary.json'), '{"version":2,"terms":[]}')
    await expect(saveGlossary(root, [{ term: 'a', meaning: 'b' }])).rejects.toThrow(/left as it is/)
    expect(await readFile(join(root, 'glossary.json'), 'utf8')).toBe('{"version":2,"terms":[]}')
  })
})

describe('exportAsset', () => {
  it('copies the folder and picks a free name', async () => {
    const asset = createCaptureAsset({
      id: newAssetId(),
      name: 'red-button',
      title: 'Red button',
      userContext: null,
      capture: { mode: 'screenshot', width: 10, height: 10, scale: 1, durationMs: 0, isStill: true },
      now: new Date(),
    })
    await mkdir(join(root, asset.name, 'capture'), { recursive: true })
    await writeAssetJson(join(root, asset.name), asset)
    await writeFile(join(root, asset.name, 'capture', 'poster.png'), 'x')
    expect(await exportAsset(root, asset.id, out)).toBe(join(out, 'red-button'))
    expect(await exportAsset(root, asset.id, out)).toBe(join(out, 'red-button-2'))
    expect(await readFile(join(out, 'red-button-2', 'capture', 'poster.png'), 'utf8')).toBe('x')
  })
})

describe('setFocus', () => {
  it('sets and clears what the user wants recreated from a capture', async () => {
    const asset = createCaptureAsset({
      id: newAssetId(),
      name: 'name-intro',
      title: 'Name intro',
      userContext: null,
      capture: { mode: 'recording', width: 10, height: 10, scale: 1, durationMs: 1000, isStill: false },
      now: new Date(),
    })
    await mkdir(join(root, asset.name), { recursive: true })
    await writeAssetJson(join(root, asset.name), asset)
    await setFocus(root, asset.id, '  only the loading animation  ')
    expect((await readAsset(root, asset.name)).userContext).toBe('only the loading animation')
    await setFocus(root, asset.id, '   ')
    expect((await readAsset(root, asset.name)).userContext).toBeNull()
    await expect(setFocus(root, newAssetId(), 'x')).rejects.toThrow('no longer in the library')
  })
})

describe('notes', () => {
  it('creates a note asset named after its title, and keeps its summary in step with its text', async () => {
    const { createNote, readNotes, saveNotes } = await import('./libraryFiles')
    const { scanLibrary } = await import('./storage')
    const note = await createNote(root, 'Button rules', 'Primary buttons are pill shaped.')
    expect(note).toMatchObject({ name: 'button-rules', kind: 'note', origin: 'written', status: 'ready', capture: null, summary: 'Primary buttons are pill shaped.' })
    expect(await readNotes(root, 'button-rules')).toBe('Primary buttons are pill shaped.')
    await saveNotes(root, note.id, 'Never all caps.')
    const [saved] = (await scanLibrary(root)).assets
    expect(saved?.summary).toBe('Never all caps.')
    await expect(createNote(root, '  ', 'x')).rejects.toThrow(/title/)
  })
})

describe('design systems', () => {
  it('bundles assets by id and keeps its summary in step', async () => {
    const { createDesignSystem, readMembers, setMembers, createNote } = await import('./libraryFiles')
    const { scanLibrary } = await import('./storage')
    const a = await createNote(root, 'Button rules', 'Pill shaped.')
    const b = await createNote(root, 'Spacing', 'Multiples of 4.')
    const system = await createDesignSystem(root, 'Acme brand', [a.id, b.id, a.id])
    expect(system).toMatchObject({ name: 'acme-brand', kind: 'design-system', summary: 'A design system bundling 2 assets.' })
    expect(await readMembers(root, 'acme-brand')).toEqual([a.id, b.id])
    await setMembers(root, system.id, [b.id])
    const saved = (await scanLibrary(root)).assets.find((asset) => asset.id === system.id)
    expect(saved?.summary).toBe('A design system bundling 1 asset.')
    await expect(setMembers(root, a.id, [b.id])).rejects.toThrow(/Only a design system/)
  })
})
