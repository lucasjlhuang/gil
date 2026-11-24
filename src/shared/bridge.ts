import { z } from 'zod'
import { MAX_CONTEXT_LENGTH } from './overlayChannel'
import { pageStylesSchema } from './pageStyles'

/**
 * The local bridge: an HTTP endpoint on 127.0.0.1 that the gil Chrome extension sends
 * captures to. Main validates with these schemas; the extension uses the constants and types.
 */

export * from './bridgeConstants'

const cssRect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
})
const cssSize = z.object({
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
})
const pixelSize = z.object({ width: z.number().int().min(2), height: z.number().int().min(2) })

const common = {
  /** The selection in the tab's viewport, in CSS pixels. */
  region: cssRect,
  /** The tab's viewport (`innerWidth` × `innerHeight`) in CSS pixels. */
  viewport: cssSize,
  context: z.string().max(MAX_CONTEXT_LENGTH),
  url: z.string().max(4096).nullable(),
  title: z.string().max(1000).nullable(),
  /** The browser's name, for `source.app`. */
  browser: z.string().max(100).nullable(),
  /** Exact style values read from the page for the selection (shared/pageStyles.ts). */
  pageStyles: pageStylesSchema.nullable().optional(),
}

/**
 * Metadata sent with each capture. The body is the whole visible tab: a PNG for a screenshot,
 * a video (any format ffmpeg reads) for a recording. gil does the cropping.
 */
export const captureMetaSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('screenshot'), ...common }),
  z.object({
    mode: z.literal('recording'),
    ...common,
    /** Real size of the recorded frames in pixels. */
    frame: pixelSize,
    durationMs: z.number().finite().nonnegative(),
  }),
])

export type CaptureMeta = z.infer<typeof captureMetaSchema>

/** What the bridge answers to a saved capture. */
export interface CaptureSaved {
  name: string
}

/** What the bridge answers to an error. */
export interface BridgeError {
  error: string
}
