import { z } from 'zod'

/**
 * The user's glossary: their own design terms and what they mean ("chip: the small rounded
 * label we use for status"), served to AI tools next to the assets so a prompt in the user's
 * words is understood. Kept in the library folder as `glossary.json` (docs/ASSET_FORMAT.md).
 */

export const GLOSSARY_FILE = 'glossary.json'
export const GLOSSARY_VERSION = 1
export const MAX_TERMS = 500
export const MAX_TERM_LENGTH = 80
export const MAX_MEANING_LENGTH = 2000

export const glossaryTermSchema = z.object({
  term: z.string().trim().min(1).max(MAX_TERM_LENGTH),
  meaning: z.string().trim().min(1).max(MAX_MEANING_LENGTH),
})
export type GlossaryTerm = z.infer<typeof glossaryTermSchema>

export const glossarySchema = z.looseObject({
  version: z.literal(GLOSSARY_VERSION),
  terms: z.array(glossaryTermSchema).max(MAX_TERMS),
})
export type Glossary = z.infer<typeof glossarySchema>

export const EMPTY_GLOSSARY: Glossary = { version: GLOSSARY_VERSION, terms: [] }

/**
 * Terms cleaned up for saving: rows with neither a term nor a meaning dropped, one entry per
 * term (the last wins), sorted. Throws, naming the row, if a row is half filled or too long, or
 * there are too many, so nothing the user typed disappears silently.
 */
export function normalizeTerms(terms: readonly { term: string; meaning: string }[]): GlossaryTerm[] {
  const byTerm = new Map<string, GlossaryTerm>()
  for (const entry of terms) {
    if (!entry.term.trim() && !entry.meaning.trim()) continue
    const parsed = glossaryTermSchema.safeParse(entry)
    if (!parsed.success) {
      const label = entry.term.trim() || 'a term'
      if (!entry.term.trim() || !entry.meaning.trim()) throw new Error(`Give ${label} both a term and a meaning`)
      throw new Error(`"${label.slice(0, 40)}" is too long: terms can be ${MAX_TERM_LENGTH} characters and meanings ${MAX_MEANING_LENGTH}`)
    }
    byTerm.set(parsed.data.term.toLowerCase(), parsed.data)
  }
  if (byTerm.size > MAX_TERMS) throw new Error(`The glossary can hold ${MAX_TERMS} terms`)
  return [...byTerm.values()].sort((a, b) => a.term.localeCompare(b.term))
}

/**
 * Reads glossary.json text. A missing file is an empty glossary; a file that is there but not
 * valid is null, so callers can refuse to overwrite it.
 */
export function readGlossaryText(text: string | null): Glossary | null {
  if (text === null) return EMPTY_GLOSSARY
  try {
    return glossarySchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}

/** For readers that only show the glossary: anything unreadable shows as empty. */
export function parseGlossary(text: string | null): Glossary {
  return readGlossaryText(text) ?? EMPTY_GLOSSARY
}

/** The glossary as text for an AI tool. */
export function glossaryText(glossary: Glossary): string {
  if (glossary.terms.length === 0) return 'The user has not added any terms to their gil glossary yet.'
  return [
    "The user's own design terms, from their gil glossary. When they use one of these words, they mean this:",
    ...glossary.terms.map((entry) => `- ${entry.term}: ${entry.meaning}`),
  ].join('\n')
}
