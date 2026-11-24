/** Runtime-dependency-free, so the Chrome extension can import it without bundling zod. */

export const BRIDGE_HOST = '127.0.0.1'
export const BRIDGE_PORT = 47823
export const BRIDGE_PATHS = { ping: '/v1/ping', captures: '/v1/captures' } as const
/** Request header carrying the capture's metadata as base64-encoded UTF-8 JSON. */
export const META_HEADER = 'x-gil-capture'
/** Largest upload accepted: a 10 s tab recording at the extension's bitrate is well under this. */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024
