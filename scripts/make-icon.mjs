// Draws gil's app icon, build/icon.png, from the Dot cloud in src/shared/dotCloud.ts: light
// points on a dark rounded square, flares out (the "ready" look), at Apple's icon grid size
// (an 824 px square inside 1024), the mark about 630 px across. Run with: pnpm exec electron scripts/make-icon.mjs
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const source = readFileSync(join(root, 'src/shared/dotCloud.ts'), 'utf8')
const loop = Number(/LOOP_SECONDS = (\d+)/.exec(source)[1])
const drawing = /DOT_CLOUD_SCRIPT = `([\s\S]*?)`/.exec(source)[1].replace('${LOOP_SECONDS}', String(loop))
const ready = /ready: (\{[^}]*\})/.exec(source)[1]

const page = `<!doctype html><script>${drawing}
function icon() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  const x = 100, size = 824, r = 185;
  const fill = ctx.createLinearGradient(0, x, 0, x + size);
  fill.addColorStop(0, '#2a2a2e');
  fill.addColorStop(1, '#0b0b0d');
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, x, size, size, r);
  ctx.fill();
  // The mark is drawn smaller than the square so it has the same breathing room as the owner's
  // other apps' icons (Burr's and Peri's marks span about 560–710 px of 1024).
  const mark = 620;
  ctx.translate(512 - mark / 2, 512 - mark / 2);
  ctx.fillStyle = '#ffffff';
  drawDotCloud(ctx, mark, ${ready}, 1.3);
  return canvas.toDataURL('image/png');
}</script>`

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
  const url = await window.webContents.executeJavaScript('icon()')
  writeFileSync(join(root, 'build/icon.png'), Buffer.from(url.split(',')[1], 'base64'))
  console.log('Wrote build/icon.png')
  app.quit()
})
