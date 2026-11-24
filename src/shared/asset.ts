import { ulid } from 'ulid'
import { z } from 'zod'
import { isValidSlug } from './slug'

/**
 * Schema for `asset.json`. The on-disk format is a public contract, described in
 * docs/ASSET_FORMAT.md; change the two together and bump `ASSET_SCHEMA_VERSION`.
 *
 * Objects are loose on purpose: readers must ignore unknown fields and writers must
 * preserve them.
 */

export const ASSET_SCHEMA_VERSION = 4

/**
 * What an asset is, which decides what gil extracts, saves and serves for it (see
 * docs/ASSET_FORMAT.md). `type-system`, `font` and `design-system` are in the format ahead of
 * the features that make them.
 */
export const assetKindSchema = z.enum([
  'motion',
  'component',
  'layout',
  'type-system',
  'color-system',
  'spacing-system',
  'effect',
  'icon-style',
  'font',
  'design-system',
  'note',
  'other',
])
export type AssetKind = z.infer<typeof assetKindSchema>

/** Version 2 kinds and what each became in version 3. */
const KIND_FROM_V2: Record<string, AssetKind> = {
  component: 'component',
  animation: 'motion',
  style: 'component',
  layout: 'layout',
  illustration: 'component',
  other: 'other',
}
/** capture: from gil's overlay; import: an image added by drag, paste or Import; written: a note the user typed. */
/**
 * What the user asked gil to look for when capturing, or when running another lens on an asset:
 * auto lets analysis decide. The colour lens runs on the Mac with no model call.
 */
export const assetLensSchema = z.enum(['auto', 'motion', 'component', 'layout', 'type', 'color', 'font', 'spacing', 'effects', 'icons', 'transition', 'scroll'])
export type AssetLens = z.infer<typeof assetLensSchema>

export const assetOriginSchema = z.enum(['capture', 'import', 'written'])
export const assetStatusSchema = z.enum(['analyzing', 'ready', 'failed', 'stored'])

export const slugSchema = z.string().refine(isValidSlug, { message: 'Not a valid asset name' })

const timestampSchema = z.iso.datetime()

export const assetSourceSchema = z.looseObject({
  app: z.string().nullable(),
  windowTitle: z.string().nullable(),
  url: z.string().nullable(),
})

/** A recording has a clip; a screenshot is a single image and has no clip. */
export const captureModeSchema = z.enum(['recording', 'screenshot'])

export const assetCaptureSchema = z.looseObject({
  mode: captureModeSchema,
  /** CSS pixels. */
  width: z.number().int().positive(),
  /** CSS pixels. */
  height: z.number().int().positive(),
  /** Video pixels per CSS pixel. */
  scale: z.number().positive(),
  durationMs: z.number().int().nonnegative(),
  isStill: z.boolean(),
})

/** Tokens and dollars spent on an asset's analysis, refinements included. */
export const assetUsageSchema = z.looseObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** US dollars at the prices in shared/cost.ts; null for a model gil has no price for. */
  costUsd: z.number().nonnegative().nullable(),
})
export type AssetUsage = z.infer<typeof assetUsageSchema>

export const assetAnalysisSchema = z.looseObject({
  model: z.string(),
  rounds: z.number().int().nonnegative(),
  error: z.string().nullable(),
  /** Missing on assets analyzed before usage was recorded. */
  usage: assetUsageSchema.optional(),
})

export const assetSchema = z.looseObject({
  schemaVersion: z.literal(ASSET_SCHEMA_VERSION),
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Not a ULID'),
  name: slugSchema,
  title: z.string().min(1),
  aliases: z.array(z.string()),
  tags: z.array(z.string()),
  kind: assetKindSchema,
  /** Defaults to auto for files written before the field existed. */
  lens: assetLensSchema.default('auto'),
  origin: assetOriginSchema,
  status: assetStatusSchema,
  summary: z.string().nullable(),
  userContext: z.string().nullable(),
  source: assetSourceSchema,
  capture: assetCaptureSchema.nullable(),
  analysis: assetAnalysisSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export type Asset = z.infer<typeof assetSchema>
export type AssetCapture = z.infer<typeof assetCaptureSchema>
export type CaptureMode = z.infer<typeof captureModeSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Upgrades a parsed asset.json from an older schema version to the current one, keeping every
 * field it does not know about. Anything it does not recognise as an older version is returned
 * as is, for the schema to accept or reject.
 *
 * - 1 -> 2: `capture.mode` added. Every version 1 capture was a recording.
 * - 2 -> 3: `kind` takes the asset types: animation becomes motion; style and illustration
 *   become component. `lens` is added as auto.
 * - 3 -> 4: new kinds (`spacing-system`, `effect`, `icon-style`) and lenses (`spacing`,
 *   `effects`, `icons`, `transition`, `scroll`). Nothing in a version 3 file changes.
 */
export function migrateAsset(json: unknown): { value: unknown; migrated: boolean } {
  if (!isRecord(json)) return { value: json, migrated: false }
  let value: Record<string, unknown> = json
  if (value['schemaVersion'] === 1) {
    const capture = value['capture']
    value = { ...value, schemaVersion: 2, capture: isRecord(capture) ? { mode: 'recording', ...capture } : capture }
  }
  if (value['schemaVersion'] === 2) {
    const kind = typeof value['kind'] === 'string' ? KIND_FROM_V2[value['kind']] : undefined
    value = { ...value, schemaVersion: 3, kind: kind ?? 'other', lens: 'auto' }
  }
  if (value['schemaVersion'] === 3) value = { ...value, schemaVersion: 4 }
  return value === json ? { value: json, migrated: false } : { value, migrated: true }
}

export function newAssetId(now: Date = new Date()): string {
  return ulid(now.getTime())
}

/** ISO 8601 UTC, to the second, as used in asset.json. */
export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export interface NewCaptureAsset {
  id: string
  name: string
  title: string
  userContext: string | null
  /** Where the capture came from, when known. */
  source?: { app: string | null; windowTitle: string | null; url?: string | null }
  capture: AssetCapture
  now: Date
  /** `import` for an image added from a file or the clipboard. */
  origin?: 'capture' | 'import'
  lens?: AssetLens
}

/** A capture that has been saved but not analyzed: everything analysis fills in later is empty. */
export function createCaptureAsset(input: NewCaptureAsset): Asset {
  const timestamp = formatTimestamp(input.now)
  const context = input.userContext?.trim()
  return assetSchema.parse({
    schemaVersion: ASSET_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    title: input.title,
    aliases: [],
    tags: [],
    kind: 'other',
    lens: input.lens ?? 'auto',
    origin: input.origin ?? 'capture',
    status: 'stored',
    summary: null,
    userContext: context ? context : null,
    source: {
      app: input.source?.app ?? null,
      windowTitle: input.source?.windowTitle ?? null,
      url: input.source?.url ?? null,
    },
    capture: input.capture,
    analysis: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
}

/** Longest summary a note gets from its text. */
const NOTE_SUMMARY_LENGTH = 200

/** The summary of a note: its text on one line, shortened. */
export function noteSummary(text: string): string | null {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return null
  return line.length > NOTE_SUMMARY_LENGTH ? `${line.slice(0, NOTE_SUMMARY_LENGTH - 1).trimEnd()}…` : line
}

/** A note: a guideline or a term of the user's own, with no capture. Its text is notes.md. */
export function createNoteAsset(input: { id: string; name: string; title: string; text: string; now: Date }): Asset {
  const timestamp = formatTimestamp(input.now)
  return assetSchema.parse({
    schemaVersion: ASSET_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    title: input.title,
    aliases: [],
    tags: [],
    kind: 'note',
    lens: 'auto',
    origin: 'written',
    status: 'ready',
    summary: noteSummary(input.text),
    userContext: null,
    source: { app: null, windowTitle: null, url: null },
    capture: null,
    analysis: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
}

/** A design system: a named bundle of other assets (design-system.json lists them). */
export function createDesignSystemAsset(input: { id: string; name: string; title: string; memberCount: number; now: Date }): Asset {
  const timestamp = formatTimestamp(input.now)
  return assetSchema.parse({
    schemaVersion: ASSET_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    title: input.title,
    aliases: [],
    tags: [],
    kind: 'design-system',
    lens: 'auto',
    origin: 'written',
    status: 'ready',
    summary: designSystemSummary(input.memberCount),
    userContext: null,
    source: { app: null, windowTitle: null, url: null },
    capture: null,
    analysis: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
}

export function designSystemSummary(memberCount: number): string {
  return `A design system bundling ${memberCount} ${memberCount === 1 ? 'asset' : 'assets'}.`
}
