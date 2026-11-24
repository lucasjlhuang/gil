/**
 * Asset names are identifiers: the folder name and the handle users type in other tools.
 * Rules (docs/ASSET_FORMAT.md): lowercase letters, digits and hyphens, starting with a letter,
 * at most 48 characters, unique across the library.
 */

export const MAX_SLUG_LENGTH = 48

const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export function isValidSlug(value: string): boolean {
  return value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value)
}

/** Best-effort conversion of free text to a valid slug. Returns null if nothing usable is left. */
export function slugify(text: string): string | null {
  const base = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  return isValidSlug(base) ? base : null
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0')

/**
 * Name given to a capture before analysis has suggested a real one,
 * for example `capture-20261013-180411` (local time).
 */
export function provisionalName(date: Date, prefix: 'capture' | 'image' = 'capture'): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${prefix}-${day}-${time}`
}

/** Human-readable counterpart of `provisionalName`, for example `Capture 2026-10-13 18:04:11`. */
export function provisionalTitle(date: Date, label = 'Capture'): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${label} ${day} ${time}`
}

/**
 * Returns `base` if it is free, otherwise `base-2`, `base-3`, … trimming `base` as needed to
 * stay within the length limit.
 */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!isValidSlug(base)) throw new Error(`Not a valid asset name: ${base}`)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '') + suffix
    if (!taken.has(candidate)) return candidate
  }
}

/** Whether a name is still the one given at capture time, so analysis may replace it. */
export function isProvisionalName(name: string): boolean {
  return /^(?:capture|image)-\d{8}-\d{6}(?:-\d+)?$/.test(name)
}

export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 40

/** Tags as stored: trimmed, lowercase, single-spaced, unique, in the order given. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const tag of tags) {
    const clean = tag.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^#+/, '').slice(0, MAX_TAG_LENGTH).trim()
    if (clean) seen.add(clean)
  }
  return [...seen].slice(0, MAX_TAGS)
}
