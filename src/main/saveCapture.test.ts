import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newAssetId } from '../shared/asset'
import { saveScreenshot } from './saveCapture'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gil-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('saveScreenshot', () => {
  it('writes only poster.png and a screenshot capture in CSS pixels', async () => {
    const asset = await saveScreenshot({
      id: newAssetId(),
      root,
      context: 'the card',
      source: { app: 'Google Chrome', windowTitle: 'Pricing', url: 'https://example.com/' },
      crop: { x: 10, y: 20, width: 641, height: 97 },
      scale: 2,
      png: new Uint8Array([1, 2, 3]),
    })
    expect(asset.capture).toEqual({
      mode: 'screenshot',
      width: 321,
      height: 49,
      scale: 2,
      durationMs: 0,
      isStill: true,
    })
    expect(asset.userContext).toBe('the card')
    expect(asset.source.url).toBe('https://example.com/')
    expect(await readdir(root)).toEqual([asset.name])
    expect(await readdir(join(root, asset.name, 'capture'))).toEqual(['poster.png'])
    expect([...(await readFile(join(root, asset.name, 'capture', 'poster.png')))]).toEqual([1, 2, 3])
  })
})
