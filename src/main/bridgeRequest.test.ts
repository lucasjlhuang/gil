import { describe, expect, it } from 'vitest'
import { checkRequest, decodeMeta, isRejection } from './bridgeRequest'

const expected = { port: 47823, token: 'secret-token' }
const good = {
  host: '127.0.0.1:47823',
  origin: 'chrome-extension://abcdefghijklmnop',
  authorization: 'Bearer secret-token',
}

describe('checkRequest', () => {
  it('accepts the paired extension', () => {
    expect(checkRequest(good, expected)).toBeNull()
    expect(checkRequest({ ...good, host: 'localhost:47823' }, expected)).toBeNull()
  })

  it('rejects another host, which is what a DNS rebinding attack looks like', () => {
    expect(checkRequest({ ...good, host: 'evil.example:47823' }, expected)?.status).toBe(403)
    expect(checkRequest({ ...good, host: undefined }, expected)?.status).toBe(403)
  })

  it('rejects web pages and requests without an origin', () => {
    expect(checkRequest({ ...good, origin: 'https://example.com' }, expected)?.status).toBe(403)
    expect(checkRequest({ ...good, origin: undefined }, expected)?.status).toBe(403)
  })

  it('rejects a missing or wrong pairing code', () => {
    expect(checkRequest({ ...good, authorization: undefined }, expected)?.status).toBe(401)
    expect(checkRequest({ ...good, authorization: 'Bearer secret-tokem' }, expected)?.status).toBe(401)
    expect(checkRequest({ ...good, authorization: 'Bearer secret' }, expected)?.status).toBe(401)
  })
})

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

const screenshot = {
  mode: 'screenshot',
  region: { x: 10, y: 20, width: 300, height: 200 },
  viewport: { width: 1440, height: 900 },
  context: 'the café menu',
  url: 'https://example.com/',
  title: 'Example',
  browser: 'Chrome',
}

describe('decodeMeta', () => {
  it('decodes a screenshot, including non-ASCII text', () => {
    expect(decodeMeta(encode(screenshot))).toEqual(screenshot)
  })

  it('requires the frame size and duration for a recording', () => {
    expect(isRejection(decodeMeta(encode({ ...screenshot, mode: 'recording' })))).toBe(true)
    const recording = {
      ...screenshot,
      mode: 'recording',
      frame: { width: 2880, height: 1800 },
      durationMs: 4200,
    }
    expect(decodeMeta(encode(recording))).toEqual(recording)
  })

  it('rejects missing, malformed and invalid metadata', () => {
    expect(isRejection(decodeMeta(undefined))).toBe(true)
    expect(isRejection(decodeMeta('not base64 json'))).toBe(true)
    expect(isRejection(decodeMeta(encode({ ...screenshot, region: { x: 0, y: 0, width: 0, height: 5 } })))).toBe(true)
    expect(isRejection(decodeMeta(encode({ ...screenshot, mode: 'gif' })))).toBe(true)
  })
})
