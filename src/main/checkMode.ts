import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { CHECK_FLAG, describeUseCheck, useCheckRequestSchema, type UseCheckAnswer } from '../shared/useCheck'
import { readAsset, writeFileAtomic } from './storage'
import { checkUse } from './useCheck'

/**
 * Check mode: gil started by its own MCP server with `--gil-check <request file>` to play a
 * draft and compare it with a capture (shared/useCheck.ts). No windows, tray, shortcut or
 * update check; it answers in the file the request names and quits. It keeps its own settings
 * folder so it can run while gil is open.
 */

/** The request file, if gil was started in check mode. */
export function checkRequestPath(argv: readonly string[]): string | null {
  const at = argv.indexOf(CHECK_FLAG)
  return at >= 0 ? (argv[at + 1] ?? null) : null
}

async function answer(requestPath: string): Promise<void> {
  const request = useCheckRequestSchema.parse(JSON.parse(await readFile(requestPath, 'utf8')))
  let result: UseCheckAnswer
  try {
    const asset = await readAsset(request.root, request.name)
    const { check, original, draft, images, styles } = await checkUse(request.root, asset, request.html, request.width, request.height)
    result = {
      ok: true,
      pass: check.pass,
      text: describeUseCheck(check, original, draft, request.checksLeft, images.length, styles),
      images: images.map((image) => ({ atMs: image.atMs, data: image.png.toString('base64'), original: image.original?.toString('base64') ?? null })),
    }
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  await writeFileAtomic(request.out, JSON.stringify(result))
}

export function runCheckMode(requestPath: string): void {
  app.setPath('userData', join(app.getPath('appData'), 'gil-check'))
  if (process.platform === 'darwin') app.dock?.hide()
  app.on('window-all-closed', () => undefined)
  void app
    .whenReady()
    .then(() => answer(requestPath))
    .then(
      () => app.exit(0),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error)
        app.exit(1)
      },
    )
}
