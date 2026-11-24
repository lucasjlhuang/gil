import { timingSafeEqual } from 'node:crypto'
import { BRIDGE_HOST, captureMetaSchema, type CaptureMeta } from '../shared/bridge'

/**
 * Checks for requests to the local bridge. No Electron here, so it is unit tested.
 *
 * Three things keep anything but the paired extension out:
 * - the Host header must be the loopback address and port, which defeats DNS rebinding;
 * - the Origin must be a Chrome extension, so an ordinary web page cannot send a capture even
 *   though it can reach 127.0.0.1;
 * - the bearer token must match the pairing code.
 */

export interface RequestHeaders {
  host: string | undefined
  origin: string | undefined
  authorization: string | undefined
}

export type Rejection = { status: number; error: string }

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function checkRequest(
  headers: RequestHeaders,
  expected: { port: number; token: string },
): Rejection | null {
  const hosts = [`${BRIDGE_HOST}:${expected.port}`, `localhost:${expected.port}`]
  if (!headers.host || !hosts.includes(headers.host)) return { status: 403, error: 'Wrong host' }
  if (!headers.origin?.startsWith('chrome-extension://')) {
    return { status: 403, error: 'Only the gil extension can send captures' }
  }
  const match = /^Bearer (.+)$/.exec(headers.authorization ?? '')
  if (!match?.[1] || !sameSecret(match[1], expected.token)) {
    return { status: 401, error: 'Pairing code does not match. Pair the extension again.' }
  }
  return null
}

/** Decodes the metadata header: base64 of UTF-8 JSON. */
export function decodeMeta(header: string | undefined): CaptureMeta | Rejection {
  if (!header) return { status: 400, error: 'Missing capture metadata' }
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
  } catch {
    return { status: 400, error: 'Capture metadata is not valid JSON' }
  }
  const parsed = captureMetaSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { status: 400, error: `Invalid capture metadata: ${issue?.path.join('.')} ${issue?.message}` }
  }
  return parsed.data
}

export function isRejection(value: unknown): value is Rejection {
  return typeof value === 'object' && value !== null && 'status' in value && 'error' in value
}
