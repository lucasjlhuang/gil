import type { BridgeError, CaptureMeta, CaptureSaved } from '../shared/bridge'
import { BRIDGE_HOST, BRIDGE_PATHS, BRIDGE_PORT, META_HEADER } from '../shared/bridgeConstants'
import type { CaptureResult } from './messages'

const BASE = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`
const NOT_RUNNING = 'gil is not running. Open gil, then try again.'

/** Base64 of the UTF-8 bytes, so a header can carry any text. */
function encodeMeta(meta: CaptureMeta): string {
  const bytes = new TextEncoder().encode(JSON.stringify(meta))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function errorFrom(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as BridgeError | null
  return body?.error ?? `gil answered ${response.status}`
}

/** Sends a capture to gil, which crops and saves it. */
export async function uploadCapture(
  pairingCode: string,
  meta: CaptureMeta,
  body: Blob,
): Promise<CaptureResult> {
  let response: Response
  try {
    response = await fetch(`${BASE}${BRIDGE_PATHS.captures}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pairingCode}`,
        [META_HEADER]: encodeMeta(meta),
        'Content-Type': body.type || 'application/octet-stream',
      },
      body,
    })
  } catch {
    return { ok: false, error: NOT_RUNNING }
  }
  if (!response.ok) return { ok: false, error: await errorFrom(response) }
  const saved = (await response.json()) as CaptureSaved
  return { ok: true, name: saved.name }
}

/** Checks that gil is running and accepts the pairing code. */
export async function ping(pairingCode: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${BASE}${BRIDGE_PATHS.ping}`, {
      headers: { Authorization: `Bearer ${pairingCode}` },
    })
    return response.ok ? { ok: true } : { ok: false, error: await errorFrom(response) }
  } catch {
    return { ok: false, error: NOT_RUNNING }
  }
}
