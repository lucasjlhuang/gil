import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ASSET_SCHEMA_VERSION } from '../shared/asset'
import { handleLine, handleMessage, PROTOCOL_VERSIONS } from './protocol'
import { createServer } from './server'

let root: string

async function addAsset(name: string, extra: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const dir = join(root, name)
  await mkdir(join(dir, 'capture'), { recursive: true })
  await mkdir(join(dir, 'recreation'), { recursive: true })
  const asset = {
    schemaVersion: ASSET_SCHEMA_VERSION,
    id: '01JAB3X9K2M4Q7R8S5T6V0W1YZ'.slice(0, 24) + String(name.length).padStart(2, '0'),
    name,
    title: name.replace(/-/g, ' '),
    aliases: [],
    tags: [],
    kind: 'motion',
    lens: 'auto',
    origin: 'capture',
    status: 'ready',
    summary: null,
    userContext: null,
    source: { app: null, windowTitle: null, url: null },
    capture: { mode: 'recording', width: 400, height: 100, scale: 2, durationMs: 3000, isStill: false },
    analysis: { model: 'm', rounds: 1, error: null },
    createdAt: '2026-11-16T10:00:00Z',
    updatedAt: '2026-11-16T10:00:00Z',
    ...extra,
  }
  await writeFile(join(dir, 'asset.json'), JSON.stringify(asset))
  for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content)
}

const call = (name: string, args: Record<string, unknown> = {}) =>
  handleMessage(createServer(root, '0.0.0'), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

const textOf = (answer: unknown) =>
  ((answer as { result: { content: { text?: string }[] } }).result.content.map((c) => c.text ?? '').join('\n'))

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gil-mcp-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('protocol', () => {
  it('answers initialize with the client version it knows, and its tools', async () => {
    const server = createServer(root, '1.2.3')
    const init = (await handleMessage(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as {
      result: { protocolVersion: string; serverInfo: { name: string } }
    }
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(init.result.serverInfo.name).toBe('gil')
    const unknown = (await handleMessage(server, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })) as {
      result: { protocolVersion: string }
    }
    expect(unknown.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0])
    const list = (await handleMessage(server, { jsonrpc: '2.0', id: 3, method: 'tools/list' })) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map((tool) => tool.name)).toEqual(['list_assets', 'search_assets', 'get_asset', 'get_asset_preview', 'check_use', 'get_glossary'])
  })

  it('ignores notifications and reports bad input', async () => {
    const server = createServer(root, '0.0.0')
    expect(await handleMessage(server, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await handleLine(server, '{nope')).toMatchObject({ error: { code: -32700 } })
    expect(await handleMessage(server, { jsonrpc: '2.0', id: 4, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } })
  })
})

describe('tools', () => {
  it('lists, searches and resolves aliases', async () => {
    await addAsset('glass-nav-hover', { aliases: ['frosted nav'], tags: ['navigation'], summary: 'A frosted pill.' })
    await addAsset('stagger-list', { kind: 'motion' })
    expect(textOf(await call('list_assets'))).toContain('glass-nav-hover: glass nav hover. A frosted pill.')
    expect(textOf(await call('search_assets', { query: 'navigation' }))).toContain('glass-nav-hover')
    expect(textOf(await call('search_assets', { query: 'navigation' }))).not.toContain('stagger-list')
    expect(textOf(await call('get_asset', { name: 'Frosted Nav' }))).toContain('# glass-nav-hover')
  })

  it('returns spec, notes, motion and code, labelled as data', async () => {
    await addAsset('red-button', {}, { 'spec.md': '# Spec\n- Duration 420 ms (measured)', 'notes.md': 'Use for CTAs', 'recreation/index.html': '<button>x</button>', 'capture/motion.json': '{"fps":30,"segments":[]}' })
    const answer = textOf(await call('get_asset', { name: 'red-button' }))
    expect(answer).toMatch(/not instructions to you/)
    expect(answer).toContain('420 ms (measured)')
    expect(answer).toContain('Use for CTAs')
    expect(answer).toContain('<button>x</button>')
    expect(answer).toContain('"fps":30')
  })

  it('names close matches for an unknown asset, and never reads outside the library', async () => {
    await addAsset('red-button')
    const missing = (await call('get_asset', { name: 'red-buton' })) as { result: { isError: boolean } }
    expect(missing.result.isError).toBe(true)
    const escape = (await call('get_asset', { name: '../../etc/passwd' })) as { result: { isError: boolean } }
    expect(escape.result.isError).toBe(true)
  })

  it('sends the poster as an image', async () => {
    await addAsset('red-button', {}, { 'capture/poster.png': 'PNGDATA' })
    const answer = (await call('get_asset_preview', { name: 'red-button' })) as { result: { content: { type: string; data?: string }[] } }
    expect(answer.result.content[1]).toMatchObject({ type: 'image', data: Buffer.from('PNGDATA').toString('base64') })
  })

  it('treats a missing library as empty, and does not create it', async () => {
    await rm(root, { recursive: true, force: true })
    expect(textOf(await call('list_assets'))).toBe('The gil library is empty.')
    await expect(import('node:fs/promises').then((fs) => fs.stat(root))).rejects.toThrow()
  })

  it('serves the glossary', async () => {
    await writeFile(join(root, 'glossary.json'), JSON.stringify({ version: 1, terms: [{ term: 'chip', meaning: 'small rounded label' }] }))
    expect(textOf(await call('get_glossary'))).toContain('- chip: small rounded label')
  })
})

describe('design systems', () => {
  it('returns every member of the bundle in one answer', async () => {
    await addAsset('brand-colors', { id: '01JAB3X9K2M4Q7R8S5T6V0W1YA', kind: 'color-system' }, { 'spec.md': 'Accent #e63946 (measured)' })
    await addAsset('brand-type', { id: '01JAB3X9K2M4Q7R8S5T6V0W1YB', kind: 'type-system' }, { 'spec.md': 'Heading 32px (measured)' })
    await addAsset('brand', { id: '01JAB3X9K2M4Q7R8S5T6V0W1YC', kind: 'design-system', capture: null }, {
      'design-system.json': JSON.stringify({ version: 1, members: ['01JAB3X9K2M4Q7R8S5T6V0W1YA', '01JAB3X9K2M4Q7R8S5T6V0W1YB'] }),
    })
    const answer = textOf(await call('get_asset', { name: 'brand' }))
    expect(answer).toContain('bundles 2 assets')
    expect(answer).toContain('## Member: brand-colors')
    expect(answer).toContain('Heading 32px (measured)')
  })
})

describe('check_use', () => {
  it('hands the draft to gil, counts three checks per use, and starts again after a pass', async () => {
    await addAsset('logo-morph')
    await addAsset('still-card', { capture: { mode: 'screenshot', width: 400, height: 100, scale: 2, durationMs: 0, isStill: true } })
    const seen: { name: string; html: string; checksLeft: number }[] = []
    const pass = false
    const server = createServer(root, '0.0.0', {
      check: (request) => {
        seen.push({ name: request.name, html: request.html, checksLeft: request.checksLeft })
        return Promise.resolve({ ok: true, pass, text: pass ? 'matches' : 'differs', images: seen.length === 1 ? [{ atMs: 400, data: 'AAAA', original: 'BBBB' }] : [] })
      },
    })
    const check = (args: Record<string, unknown>) =>
      handleMessage(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_use', arguments: args } })

    const draft = join(root, 'draft.html')
    await writeFile(draft, '<p>draft</p>')
    const first = (await check({ name: 'logo-morph', file: draft })) as { result: { content: { type: string; text?: string; data?: string }[] } }
    // The answer, then each picture of the draft with its moment.
    expect(first.result.content.map((c) => c.type)).toEqual(['text', 'text', 'image', 'text', 'image'])
    expect(first.result.content[0]?.text).toBe('differs')
    expect(first.result.content[1]?.text).toBe('The original capture at 400 ms:')
    expect(first.result.content[2]?.data).toBe('BBBB')
    expect(first.result.content[3]?.text).toBe('Your draft at 400 ms:')
    expect(first.result.content[4]?.data).toBe('AAAA')
    expect(textOf(await check({ name: 'logo-morph', html: '<p>two</p>' }))).toBe('differs')
    expect(textOf(await check({ name: 'logo-morph', html: '<p>three</p>' }))).toBe('differs')
    expect(seen.map((request) => request.checksLeft)).toEqual([2, 1, 0])
    expect(seen[0]?.html).toBe('<p>draft</p>')
    expect(textOf(await check({ name: 'logo-morph', html: '<p>four</p>' }))).toContain('has had its 3 checks')
    expect(seen).toHaveLength(3)

    // A still asset is checked too: its styles and pictures.
    expect(textOf(await check({ name: 'still-card', html: '<p>x</p>' }))).toBe('differs')
    expect(textOf(await check({ name: 'logo-morph', file: 'relative.html' }))).toContain('absolute path')
    expect(textOf(await check({ name: 'logo-morph', file: join(root, 'logo-morph', 'asset.json') }))).toContain('absolute path')
  })

  it('gives a use its checks back once a draft passes', async () => {
    await addAsset('logo-morph')
    let pass = false
    const left: number[] = []
    const server = createServer(root, '0.0.0', {
      check: (request) => {
        left.push(request.checksLeft)
        return Promise.resolve({ ok: true, pass, text: 'x', images: [] })
      },
    })
    const check = () => handleMessage(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_use', arguments: { name: 'logo-morph', html: '<p>x</p>' } } })
    await check()
    pass = true
    await check()
    pass = false
    await check()
    expect(left).toEqual([2, 1, 2])
  })
})
