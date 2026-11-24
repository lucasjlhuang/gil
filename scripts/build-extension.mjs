// Builds the Chrome extension into out/extension, ready for "Load unpacked".
// Each script is a single self-contained file: a content script injected with
// chrome.scripting cannot import modules, so every entry is built on its own as an IIFE.
import { cpSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = `${root}out/extension`
const entries = ['background', 'offscreen', 'overlay', 'options']

rmSync(outDir, { recursive: true, force: true })
for (const name of entries) {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'chrome116',
      lib: {
        entry: `${root}src/extension/${name}.ts`,
        formats: ['iife'],
        name: `gil_${name}`,
        fileName: () => `${name}.js`,
      },
    },
  })
}
cpSync(`${root}src/extension/public`, outDir, { recursive: true })
console.log(`Chrome extension built in ${outDir}`)
