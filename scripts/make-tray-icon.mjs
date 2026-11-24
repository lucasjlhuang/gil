// Generates the menu bar template icon (a viewfinder: four corner brackets and a dot).
// Run with `node scripts/make-tray-icon.mjs`; the PNGs it writes are committed.
import { writeFileSync } from 'node:fs'
import { deflateSync, crc32 } from 'node:zlib'

function png(size, alphaAt) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1)
    for (let x = 0; x < size; x++) {
      // Template images are black with alpha; macOS tints them for light and dark menu bars.
      raw[row + 1 + x * 4 + 3] = alphaAt(x, y) ? 255 : 0
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function viewfinder(scale) {
  const size = 16 * scale
  return png(size, (px, py) => {
    const x = px / scale
    const y = py / scale
    const inset = 2
    const far = 16 - inset
    const arm = 4.5
    const stroke = 1.5
    const nearEdgeX = (x >= inset && x < inset + stroke) || (x >= far - stroke && x < far)
    const nearEdgeY = (y >= inset && y < inset + stroke) || (y >= far - stroke && y < far)
    const inArmX = (x >= inset && x < inset + arm) || (x >= far - arm && x < far)
    const inArmY = (y >= inset && y < inset + arm) || (y >= far - arm && y < far)
    const bracket = (nearEdgeX && inArmY) || (nearEdgeY && inArmX)
    const dot = Math.hypot(x + 0.5 / scale - 8, y + 0.5 / scale - 8) <= 2
    return bracket || dot
  })
}

writeFileSync(new URL('../resources/trayTemplate.png', import.meta.url), viewfinder(1))
writeFileSync(new URL('../resources/trayTemplate@2x.png', import.meta.url), viewfinder(2))
