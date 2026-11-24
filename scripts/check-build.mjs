// Run after `electron-vite build`. Sandboxed preload scripts can only require 'electron';
// a shared chunk or a node_modules import would make them fail at runtime, silently
// breaking the window's IPC. Fail the build instead.
import { readdirSync, readFileSync } from 'node:fs'

const dir = new URL('../out/preload/', import.meta.url)
const expected = ['library.js', 'overlay.js', 'recorder.js']
const files = readdirSync(dir).sort()
let failed = false

if (JSON.stringify(files) !== JSON.stringify(expected)) {
  console.error(`Preload output should be exactly ${expected.join(', ')} but is ${files.join(', ')}`)
  failed = true
}
for (const file of files) {
  const source = readFileSync(new URL(file, dir), 'utf8')
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    if (match[1] !== 'electron') {
      console.error(`${file} requires "${match[1]}", which a sandboxed preload cannot load`)
      failed = true
    }
  }
}
// The MCP server runs on gil's binary in Node mode, where Electron's APIs do not exist: check
// mcp.js and every chunk it loads, directly or through other chunks.
const mainDir = new URL('../out/main/', import.meta.url)
const seen = new Set()
const pending = ['mcp.js']
while (pending.length) {
  const file = pending.pop()
  if (seen.has(file)) continue
  seen.add(file)
  const source = readFileSync(new URL(file, mainDir), 'utf8')
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1]
    if (name === 'electron') {
      console.error(`${file} is loaded by the MCP server but requires "electron"`)
      failed = true
    } else if (name.startsWith('.')) {
      pending.push(new URL(name, new URL(file, mainDir)).pathname.slice(mainDir.pathname.length))
    }
  }
}
process.exit(failed ? 1 : 0)
