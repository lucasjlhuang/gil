import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import {
  CATALOG_MAX_AGE_MS,
  CATALOG_URL,
  catalogFileSchema,
  catalogFromApi,
  FONT_HOSTS,
  fontFileUrl,
  type CatalogEntry,
} from '../shared/fontCatalog'
import { embedFontData, FONT_KEY, fontKeysIn } from '../shared/fontEmbed'
import { writeFileAtomic } from './storage'

/**
 * The font catalogue and font files on this Mac: fetched from Fontsource the first time they
 * are needed and kept in gil's settings folder, never in the library. Only these fetches leave
 * the Mac, and they carry nothing about any capture.
 */

const FETCH_TIMEOUT_MS = 30_000
/** Larger files are refused; a Latin WOFF2 is usually under 100 KB. */
const MAX_FONT_BYTES = 2 * 1024 * 1024

const fontsDir = () => join(app.getPath('userData'), 'fonts')

async function get(url: string): Promise<Response> {
  if (!FONT_HOSTS.includes(new URL(url).hostname)) throw new Error(`gil does not fetch from ${url}`)
  // No redirects: a redirect could lead to a host gil does not fetch from.
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' })
  if (!response.ok) throw new Error(`Fetching ${url} failed (${response.status})`)
  return response
}

/** The catalogue, from the cache if it is recent, else downloaded again (or the old copy if offline). */
export async function fontCatalog(): Promise<CatalogEntry[]> {
  const path = join(fontsDir(), 'catalog.json')
  const cached = await readFile(path, 'utf8')
    .then((text) => catalogFileSchema.parse(JSON.parse(text)))
    .catch(() => null)
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < CATALOG_MAX_AGE_MS) return cached.fonts
  try {
    const fonts = catalogFromApi(await (await get(CATALOG_URL)).json())
    await mkdir(fontsDir(), { recursive: true })
    await writeFileAtomic(path, JSON.stringify({ fetchedAt: new Date().toISOString(), fonts }))
    return fonts
  } catch (error) {
    if (cached) return cached.fonts
    throw new Error(`gil could not download the font list: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/** The key of one font file: what a recreation's `url(gil-font:<key>)` names. */
export function fontKey(entry: CatalogEntry, weight: number, italic: boolean): string {
  return `${entry.id}-${weight}-${italic && entry.styles.includes('italic') ? 'italic' : 'normal'}`
}

/**
 * A recreation with its font placeholders replaced by the fonts themselves, from the cache on
 * this Mac only: the keys come from AI-written code, so they never cause a download and are
 * never used as a path unless they are plain keys. A font that is not there is left as it is.
 */
export async function embedFonts(html: string): Promise<string> {
  const keys = fontKeysIn(html)
  if (keys.length === 0) return html
  const fonts = new Map<string, string>()
  for (const key of keys) {
    if (!FONT_KEY.test(key)) continue
    const data = await readFile(join(fontsDir(), 'files', `${key}.woff2`)).catch(() => null)
    if (data) fonts.set(key, data.toString('base64'))
  }
  return embedFontData(html, fonts)
}

/** One font file (WOFF2, Latin), from the cache or downloaded. */
export async function fontFile(entry: CatalogEntry, weight: number, italic: boolean): Promise<Buffer> {
  const path = join(fontsDir(), 'files', `${fontKey(entry, weight, italic)}.woff2`)
  if (await stat(path).then(() => true, () => false)) return readFile(path)
  const response = await get(fontFileUrl(entry, weight, italic))
  if (Number(response.headers.get('content-length') ?? 0) > MAX_FONT_BYTES) throw new Error(`${entry.family} is too large to compare`)
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length > MAX_FONT_BYTES) throw new Error(`${entry.family} is too large to compare`)
  await mkdir(join(fontsDir(), 'files'), { recursive: true })
  await writeFileAtomic(path, data)
  return data
}
