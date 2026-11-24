import { z } from 'zod'

/**
 * The free font catalogue gil identifies fonts against: the Google Fonts families, listed and
 * served by Fontsource (api.fontsource.org for the list, jsDelivr for the files), which needs no
 * API key. gil downloads the list the first time it is needed and font files one by one as it
 * compares them; nothing about the capture is sent anywhere.
 */

export const CATALOG_URL = 'https://api.fontsource.org/v1/fonts?type=google'
/** The list is fetched again after this long. */
export const CATALOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export const catalogEntrySchema = z.looseObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  family: z.string().min(1),
  subsets: z.array(z.string()),
  weights: z.array(z.number().int()),
  styles: z.array(z.string()),
  category: z.string(),
  license: z.string().optional(),
})
export type CatalogEntry = z.infer<typeof catalogEntrySchema>

export const catalogFileSchema = z.object({
  fetchedAt: z.string(),
  fonts: z.array(catalogEntrySchema),
})
export type CatalogFile = z.infer<typeof catalogFileSchema>

/** The API's answer as a catalogue: entries that do not parse, or have no Latin subset, are left out. */
export function catalogFromApi(json: unknown): CatalogEntry[] {
  if (!Array.isArray(json)) throw new Error('The font list was not in the expected format')
  return json.flatMap((item) => {
    const parsed = catalogEntrySchema.safeParse(item)
    return parsed.success && parsed.data.subsets.includes('latin') && parsed.data.weights.length > 0 ? [parsed.data] : []
  })
}

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The catalogue entry for a family name the model gave, ignoring case, spaces and punctuation. */
export function findFamily(catalog: readonly CatalogEntry[], name: string): CatalogEntry | null {
  const wanted = normalize(name)
  if (!wanted) return null
  return catalog.find((entry) => normalize(entry.family) === wanted) ?? null
}

/** The weight a family has that is closest to `weight` (ties go to the heavier one). */
export function closestWeight(entry: CatalogEntry, weight: number): number {
  return [...entry.weights].sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight) || b - a)[0] ?? 400
}

/** Where one font file is: the Latin subset, as WOFF2. */
export function fontFileUrl(entry: CatalogEntry, weight: number, italic: boolean): string {
  const style = italic && entry.styles.includes('italic') ? 'italic' : 'normal'
  return `https://cdn.jsdelivr.net/fontsource/fonts/${entry.id}@latest/latin-${weight}-${style}.woff2`
}

/** Hosts gil fetches fonts from; nothing else. */
export const FONT_HOSTS = ['api.fontsource.org', 'cdn.jsdelivr.net']
