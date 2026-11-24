import { z } from 'zod'

/**
 * The user's edits to a recreation, kept apart from what Claude wrote so they can be changed
 * again or reverted. `recreation/base.html` is the model's document, `recreation/edits.json`
 * holds these edits, and `recreation/index.html` is the base with the edits compiled into one
 * stylesheet at the end, so readers of the asset only ever need index.html.
 *
 * Two kinds of edit, both plain CSS so they also work in the sandboxed preview:
 * - values: new values for the custom properties the recreation declares on :root (timings,
 *   easings, colors, sizes);
 * - rules: style overrides for one element, addressed by a structural selector.
 *
 * Pure; everything that reaches CSS is validated here.
 */

export const EDITS_VERSION = 1

/** The style properties the element editor can set. */
export const EDITABLE_PROPERTIES = [
  'translate',
  'color',
  'background-color',
  'border-width',
  'border-style',
  'border-color',
  'border-radius',
  'padding',
  'margin',
  'width',
  'height',
  'font-size',
  'font-weight',
  'letter-spacing',
  'opacity',
  'box-shadow',
] as const

export type EditableProperty = (typeof EDITABLE_PROPERTIES)[number]

const VAR_NAME = /^--[A-Za-z0-9_-]{1,80}$/
/** Structural selectors as the preview builds them: `body > div:nth-child(2) > span:nth-child(1)`. */
const SELECTOR = /^body(?: > [a-z][a-z0-9-]*:nth-child\(\d{1,4}\)){0,40}$/

/** A CSS value that cannot break out of its declaration or load anything. */
export function isSafeValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 300 &&
    !/[;{}<>\\]/.test(value) &&
    !/url\s*\(|@import|expression\s*\(/i.test(value)
  )
}

const valueSchema = z.string().trim().refine(isSafeValue, { message: 'Not an allowed CSS value' })

export const editsSchema = z.object({
  version: z.literal(EDITS_VERSION),
  vars: z.record(z.string().regex(VAR_NAME), valueSchema),
  rules: z
    .array(
      z.object({
        selector: z.string().regex(SELECTOR),
        styles: z.partialRecord(z.enum(EDITABLE_PROPERTIES), valueSchema),
      }),
    )
    .max(200),
})

export type Edits = z.infer<typeof editsSchema>

export const NO_EDITS: Edits = { version: EDITS_VERSION, vars: {}, rules: [] }

export function hasEdits(edits: Edits): boolean {
  return Object.keys(edits.vars).length > 0 || edits.rules.some((rule) => Object.keys(rule.styles).length > 0)
}

/** The edits as one stylesheet. Values that are not safe are dropped rather than written. */
export function compileEdits(edits: Edits): string {
  const lines: string[] = []
  const vars = Object.entries(edits.vars).filter(([name, value]) => VAR_NAME.test(name) && isSafeValue(value))
  if (vars.length > 0) {
    // On :root at the end of the document, so it wins over the recreation's own :root.
    lines.push(`:root { ${vars.map(([name, value]) => `${name}: ${value};`).join(' ')} }`)
  }
  for (const rule of edits.rules) {
    if (!SELECTOR.test(rule.selector)) continue
    const declarations = Object.entries(rule.styles)
      .filter(([, value]) => typeof value === 'string' && isSafeValue(value))
      .map(([property, value]) => `${property}: ${value} !important;`)
    if (declarations.length > 0) lines.push(`${rule.selector} { ${declarations.join(' ')} }`)
  }
  return lines.join('\n')
}

// Also matches the attribute recreations were saved with before the rename from Gilbert.
const EDITS_STYLE = /\n?<style data-(?:gil|gilbert)-edits>[\s\S]*?<\/style>/g

/** The recreation with the edits applied: the base document plus one stylesheet at the end. */
export function applyEdits(baseHtml: string, edits: Edits): string {
  const clean = baseHtml.replace(EDITS_STYLE, '')
  const css = compileEdits(edits)
  if (!css) return clean
  const style = `\n<style data-gil-edits>\n${css}\n</style>`
  const close = clean.search(/<\/body>/i)
  return close === -1 ? `${clean}${style}` : `${clean.slice(0, close)}${style}${clean.slice(close)}`
}

export type VarKind = 'duration' | 'easing' | 'color' | 'length' | 'number' | 'text'

export interface RootVar {
  name: string
  value: string
  kind: VarKind
}

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.*\)|transparent)$/i

export function varKind(value: string): VarKind {
  const v = value.trim()
  if (/^-?\d*\.?\d+m?s$/.test(v)) return 'duration'
  if (/^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$|^(cubic-bezier|steps|linear)\(/i.test(v)) {
    return 'easing'
  }
  if (COLOR.test(v)) return 'color'
  if (/^-?\d*\.?\d+(px|rem|em|%|vw|vh|deg)$/.test(v)) return 'length'
  if (/^-?\d*\.?\d+$/.test(v)) return 'number'
  return 'text'
}

/** The style elements' contents, script elements' contents, and the markup without either. */
export function splitRecreation(html: string): { markup: string; css: string; js: string } {
  const css: string[] = []
  const js: string[] = []
  const markup = html
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, body: string) => {
      css.push(body.trim())
      return ''
    })
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, body: string) => {
      js.push(body.trim())
      return ''
    })
    .replace(/\n\s*\n+/g, '\n')
    .trim()
  return { markup, css: css.filter(Boolean).join('\n\n'), js: js.filter(Boolean).join('\n\n') }
}

/** The custom properties declared in the recreation's :root rules, in order, last value winning. */
export function parseRootVars(html: string): RootVar[] {
  const { css } = splitRecreation(html)
  const found = new Map<string, string>()
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const block of withoutComments.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const declaration of (block[1] ?? '').split(';')) {
      const match = /^\s*(--[A-Za-z0-9_-]+)\s*:\s*([\s\S]+?)\s*$/.exec(declaration)
      if (match?.[1] && match[2]) {
        found.delete(match[1])
        found.set(match[1], match[2])
      }
    }
  }
  return [...found].map(([name, value]) => ({ name, value, kind: varKind(value) }))
}
