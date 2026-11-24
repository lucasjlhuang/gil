import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createChecker } from './check'
import { handleLine } from './protocol'
import { createServer } from './server'

/**
 * Entry point of gil's MCP server, run by AI tools as a separate process over stdio. It runs on
 * gil's own Electron binary in Node mode (ELECTRON_RUN_AS_NODE=1), so it needs no Node install;
 * see docs/ARCHITECTURE.md. stdout carries only protocol messages; anything else goes to stderr.
 *
 * GIL_LIBRARY overrides the library folder (for tests and other setups).
 */

const root = process.env.GIL_LIBRARY || join(homedir(), 'Documents', 'gil')
const server = createServer(root, __GIL_VERSION__, { check: createChecker(process.execPath, __filename) })

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
// Answer in order, one message at a time.
let queue = Promise.resolve()
input.on('line', (line) => {
  if (!line.trim()) return
  queue = queue.then(async () => {
    const answer = await handleLine(server, line)
    if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`)
  })
})
input.on('close', () => {
  void queue.then(() => process.exit(0))
})
