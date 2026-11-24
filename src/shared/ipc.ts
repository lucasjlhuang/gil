import { z } from 'zod'
import { assetLensSchema } from './asset'
import { editsSchema } from './edits'
import { MAX_CONTEXT_LENGTH } from './overlayChannel'

/** Validation for payloads arriving in main from a renderer. Types live in `channels.ts`. */

export const rectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
})

export const assetIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)

export const apiKeyInputSchema = z.string().trim().min(20).max(500).regex(/^\S+$/)

export const renameRequestSchema = z.object({
  id: assetIdSchema,
  name: z.string().max(100),
  title: z.string().max(200),
})

export const tagsRequestSchema = z.object({
  id: assetIdSchema,
  tags: z.array(z.string().max(200)).max(100),
})

export const saveEditsRequestSchema = z.object({ id: assetIdSchema, edits: editsSchema })

export const refineRequestSchema = z.object({
  id: assetIdSchema,
  instruction: z.string().trim().min(1).max(4000),
})

export const copyTextSchema = z.string().max(5_000_000)

export const recordRequestSchema = z.object({
  rect: rectSchema,
  context: z.string().max(MAX_CONTEXT_LENGTH),
  // Font is not a capture lens: it is run on a saved asset.
  lens: assetLensSchema.exclude(['font', 'spacing']),
})

export const recorderStartedSchema = z.object({
  width: z.number().int().min(2),
  height: z.number().int().min(2),
  mimeType: z.string().max(200),
})

export const recorderStoppedSchema = z.object({
  durationMs: z.number().finite().nonnegative(),
})

export const recorderFailedSchema = z.string().max(2000)

/** The glossary from Settings; rows are cleaned up before saving (see shared/glossary.ts). */
export const glossaryInputSchema = z
  .array(z.object({ term: z.string().max(1000), meaning: z.string().max(10000) }))
  .max(2000)

export const importPathsSchema = z.array(z.string().min(1).max(4096)).min(1).max(200)

export const noteRequestSchema = z.object({ title: z.string().max(200), text: z.string().max(100_000) })

export const notesRequestSchema = z.object({ id: assetIdSchema, text: z.string().max(100_000) })
/** What the user wants recreated from a capture, in their words; empty for everything. */
export const focusRequestSchema = z.object({ id: assetIdSchema, text: z.string().max(MAX_CONTEXT_LENGTH) })

export const runLensRequestSchema = z.object({
  id: assetIdSchema,
  lens: z.enum(['motion', 'component', 'layout', 'type', 'color', 'font', 'spacing', 'effects', 'icons', 'transition', 'scroll']),
})

export const designSystemRequestSchema = z.object({ title: z.string().max(200), memberIds: z.array(assetIdSchema).max(100) })

export const membersRequestSchema = z.object({ id: assetIdSchema, memberIds: z.array(assetIdSchema).max(100) })
