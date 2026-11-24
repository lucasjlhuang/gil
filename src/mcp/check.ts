import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CHECK_FLAG, useCheckAnswerSchema, type UseCheckAnswer, type UseCheckRequest } from '../shared/useCheck'

/**
 * Playing a draft needs a browser, which this server (plain Node) does not have: it starts gil
 * itself in check mode (main/checkMode.ts), hands it the request in a file and reads the answer
 * from another. gil shows nothing while it checks, and it works whether or not gil is open.
 */

const TIMEOUT_MS = 90_000

export type Checker = (request: Omit<UseCheckRequest, 'out'>) => Promise<UseCheckAnswer>

/** `scriptPath` is this server's own file, `<app>/out/main/mcp.js`. */
export function createChecker(execPath: string, scriptPath: string): Checker {
  // An installed gil knows its own app; Electron run from the project needs to be told.
  const appPath = resolve(scriptPath, '..', '..', '..')
  const args = (requestPath: string) => (/\.asar/.test(scriptPath) ? [CHECK_FLAG, requestPath] : [appPath, CHECK_FLAG, requestPath])
  return async (request) => {
    const dir = await mkdtemp(join(tmpdir(), 'gil-check-'))
    try {
      const out = join(dir, 'answer.json')
      const requestPath = join(dir, 'request.json')
      await writeFile(requestPath, JSON.stringify({ ...request, out }))
      // This server runs gil's binary as Node; the check needs it as the app.
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      await new Promise<void>((done, fail) => {
        const child = spawn(execPath, args(requestPath), { env, stdio: 'ignore' })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          fail(new Error('The check took too long'))
        }, TIMEOUT_MS)
        child.on('error', (error) => {
          clearTimeout(timer)
          fail(error)
        })
        child.on('exit', () => {
          clearTimeout(timer)
          done()
        })
      })
      const text = await readFile(out, 'utf8').catch(() => null)
      if (text === null) return { ok: false, error: 'gil could not run the check' }
      return useCheckAnswerSchema.parse(JSON.parse(text))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
