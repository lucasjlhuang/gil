import { describe, expect, it } from 'vitest'
import { assetSchema, createCaptureAsset, formatTimestamp, migrateAsset, newAssetId } from './asset'

/** The example from docs/ASSET_FORMAT.md, verbatim. */
const documentedExample = {
  schemaVersion: 4,
  id: '01JAB3X9K2M4Q7R8S5T6V0W1YZ',
  name: 'glass-nav-hover',
  title: 'Glass nav hover',
  aliases: ['frosted nav'],
  tags: ['navigation', 'hover', 'glassmorphism'],
  kind: 'motion',
  lens: 'auto',
  origin: 'capture',
  status: 'ready',
  summary: 'Nav links with a frosted pill that slides between items on hover.',
  userContext: 'Just the pill sliding between links, ignore the logo.',
  source: { app: 'Arc', windowTitle: 'Example — Home', url: null },
  capture: {
    mode: 'recording',
    width: 640,
    height: 96,
    scale: 2,
    durationMs: 4200,
    isStill: false,
  },
  analysis: { model: '…', rounds: 2, error: null },
  createdAt: '2026-10-13T18:04:11Z',
  updatedAt: '2026-10-13T18:05:02Z',
}

describe('assetSchema', () => {
  it('accepts the documented example', () => {
    expect(assetSchema.parse(documentedExample)).toEqual(documentedExample)
  })

  it('preserves unknown fields at every level', () => {
    const withExtras = {
      ...documentedExample,
      futureField: { nested: true },
      capture: { ...documentedExample.capture, fps: 60 },
    }
    expect(assetSchema.parse(withExtras)).toEqual(withExtras)
  })

  it('rejects an invalid name', () => {
    expect(assetSchema.safeParse({ ...documentedExample, name: 'Glass Nav' }).success).toBe(false)
  })

  it('rejects another schema version', () => {
    expect(assetSchema.safeParse({ ...documentedExample, schemaVersion: 2 }).success).toBe(false)
    expect(assetSchema.safeParse({ ...documentedExample, schemaVersion: 3 }).success).toBe(false)
    expect(assetSchema.safeParse({ ...documentedExample, schemaVersion: 5 }).success).toBe(false)
  })

  it('rejects an unknown capture mode', () => {
    const capture = { ...documentedExample.capture, mode: 'gif' }
    expect(assetSchema.safeParse({ ...documentedExample, capture }).success).toBe(false)
  })

  it('rejects an unknown status', () => {
    expect(assetSchema.safeParse({ ...documentedExample, status: 'done' }).success).toBe(false)
  })
})

describe('createCaptureAsset', () => {
  const now = new Date('2026-10-13T18:04:11.532Z')
  const base = {
    id: newAssetId(now),
    name: 'capture-20261013-180411',
    title: 'Capture 2026-10-13 18:04:11',
    capture: {
      mode: 'recording' as const,
      width: 640,
      height: 96,
      scale: 2,
      durationMs: 4200,
      isStill: false,
    },
    now,
  }

  it('writes a stored, unanalyzed capture in the documented shape', () => {
    const asset = createCaptureAsset({ ...base, userContext: 'just the hover' })
    expect(Object.keys(asset)).toEqual(Object.keys(documentedExample))
    expect(asset).toMatchObject({
      schemaVersion: 4,
      kind: 'other',
      origin: 'capture',
      status: 'stored',
      summary: null,
      userContext: 'just the hover',
      source: { app: null, windowTitle: null, url: null },
      analysis: null,
      aliases: [],
      tags: [],
      createdAt: '2026-10-13T18:04:11Z',
      updatedAt: '2026-10-13T18:04:11Z',
    })
  })

  it('records the source app and window title when known', () => {
    const asset = createCaptureAsset({
      ...base,
      userContext: null,
      source: { app: 'Google Chrome', windowTitle: 'Pricing' },
    })
    expect(asset.source).toEqual({ app: 'Google Chrome', windowTitle: 'Pricing', url: null })
  })

  it('stores empty context as null', () => {
    expect(createCaptureAsset({ ...base, userContext: '   ' }).userContext).toBeNull()
    expect(createCaptureAsset({ ...base, userContext: null }).userContext).toBeNull()
  })
})

describe('migrateAsset', () => {
  const v1Capture: Partial<typeof documentedExample.capture> = { ...documentedExample.capture }
  delete v1Capture.mode
  const withoutLens: Partial<typeof documentedExample> = { ...documentedExample }
  delete withoutLens.lens
  const version1 = { ...withoutLens, schemaVersion: 1, kind: 'animation', capture: { ...v1Capture, fps: 60 } }
  const version2 = { ...withoutLens, schemaVersion: 2, kind: 'animation' }

  it('upgrades a version 1 capture to a recording, keeping unknown fields', () => {
    const { value, migrated } = migrateAsset({ ...version1, futureField: true })
    expect(migrated).toBe(true)
    expect(assetSchema.parse(value)).toEqual({
      ...documentedExample,
      futureField: true,
      capture: { ...documentedExample.capture, fps: 60 },
    })
  })

  it('upgrades a version 1 import, which has no capture', () => {
    const { value } = migrateAsset({ ...version1, origin: 'import', capture: null })
    expect(assetSchema.parse(value)).toMatchObject({ schemaVersion: 4, capture: null })
  })

  it('maps version 2 kinds to asset types', () => {
    const kindOf = (kind: string) => (migrateAsset({ ...version2, kind }).value as { kind: string }).kind
    expect(kindOf('animation')).toBe('motion')
    expect(kindOf('style')).toBe('component')
    expect(kindOf('illustration')).toBe('component')
    expect(kindOf('layout')).toBe('layout')
    expect(kindOf('mystery')).toBe('other')
    expect(assetSchema.parse(migrateAsset(version2).value)).toEqual(documentedExample)
  })

  it('upgrades version 3 by its number alone, keeping every field', () => {
    const version3 = { ...documentedExample, schemaVersion: 3, futureField: 1 }
    expect(migrateAsset(version3)).toEqual({ value: { ...documentedExample, futureField: 1 }, migrated: true })
  })

  it('leaves current and unrecognised versions alone', () => {
    expect(migrateAsset(documentedExample)).toEqual({ value: documentedExample, migrated: false })
    expect(migrateAsset({ schemaVersion: 9 }).migrated).toBe(false)
    expect(migrateAsset('nope').migrated).toBe(false)
  })
})

describe('ids and timestamps', () => {
  it('generates ULIDs the schema accepts', () => {
    const id = newAssetId()
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(newAssetId()).not.toBe(id)
  })

  it('formats timestamps to the second in UTC', () => {
    expect(formatTimestamp(new Date('2026-10-13T18:04:11.999Z'))).toBe('2026-10-13T18:04:11Z')
  })
})

describe('notes', () => {
  it('summarises a note on one line, shortened', async () => {
    const { noteSummary } = await import('./asset')
    expect(noteSummary('  a\n\nb  ')).toBe('a b')
    expect(noteSummary('')).toBeNull()
    expect(noteSummary('x'.repeat(300))?.length).toBe(200)
  })
})

describe('lens', () => {
  it('reads an asset without a lens as auto', () => {
    const noLens: Record<string, unknown> = { ...documentedExample }
    delete noLens.lens
    expect(assetSchema.parse(noLens).lens).toBe('auto')
  })
})
