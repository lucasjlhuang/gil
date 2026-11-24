import { z } from 'zod'

/**
 * A design system: a named bundle of assets the user groups (type, colour, spacing, components,
 * motion), so an AI tool gets all of it from one name. Its members are kept by asset id in
 * `design-system.json`, so renaming a member does not break the bundle.
 */

export const DESIGN_SYSTEM_FILE = 'design-system.json'
export const DESIGN_SYSTEM_VERSION = 1
export const MAX_MEMBERS = 100

const idSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)

export const designSystemSchema = z.looseObject({
  version: z.literal(DESIGN_SYSTEM_VERSION),
  members: z.array(idSchema).max(MAX_MEMBERS),
})
export type DesignSystem = z.infer<typeof designSystemSchema>

/** Members cleaned up: each once, in the order given, never the bundle itself. */
export function normalizeMembers(ids: readonly string[], selfId: string): string[] {
  const unique = [...new Set(ids)].filter((id) => id !== selfId && idSchema.safeParse(id).success)
  if (unique.length > MAX_MEMBERS) throw new Error(`A design system can hold ${MAX_MEMBERS} assets`)
  return unique
}

/** Reads design-system.json text; missing or unreadable is an empty bundle. */
export function parseDesignSystem(text: string | null): DesignSystem {
  if (!text) return { version: DESIGN_SYSTEM_VERSION, members: [] }
  try {
    return designSystemSchema.parse(JSON.parse(text))
  } catch {
    return { version: DESIGN_SYSTEM_VERSION, members: [] }
  }
}
