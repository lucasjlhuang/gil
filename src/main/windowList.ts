import { execFile } from 'node:child_process'
import { parseWindowList, type WindowInfo } from '../shared/windowList'

/**
 * Asks macOS for the on-screen windows, front to back, through JavaScript for Automation and
 * CoreGraphics. No native module and no Automation permission: it calls
 * CGWindowListCopyWindowInfo directly, not another app. Window titles need Screen Recording
 * permission; bounds do not. Takes about 100 ms, so it runs as soon as selection starts.
 */
const SCRIPT = `
ObjC.import('CoreGraphics');
const options = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
const list = $.CGWindowListCopyWindowInfo(options, $.kCGNullWindowID);
JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject(list)));
`

export function listWindows(): Promise<WindowInfo[]> {
  if (process.platform !== 'darwin') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', SCRIPT],
      { timeout: 3000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          console.error(`Could not list windows: ${error.message}`)
          return resolve([])
        }
        try {
          resolve(parseWindowList(JSON.parse(stdout)))
        } catch {
          resolve([])
        }
      },
    )
  })
}
