import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

/**
 * Automatic updates (docs/ARCHITECTURE.md, Publishing). Only a release build carries
 * `app-update.yml`; local builds (`pnpm package`) and `pnpm dev` skip all of this.
 *
 * On launch, gil checks for an update before it starts. If there is one, it shows a small
 * "Updating gil" window with progress, installs it and relaunches into the new version on its
 * own, the way a game patches before letting you in. There is no skip. If the server cannot be
 * reached quickly, the download fails or stalls, gil starts as it is, so being offline never
 * locks anyone out. While running, it also checks every six hours and downloads in the
 * background; that update installs on the next launch or quit, or from the menu bar.
 */

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
/** How long the launch check may take before gil starts anyway. */
const LAUNCH_CHECK_TIMEOUT_MS = 5_000
/** A download with no progress for this long is given up on, and gil starts as it is. */
const STALL_TIMEOUT_MS = 60_000

function updatesEnabled(): boolean {
  return app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
}

function timeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))
}

/**
 * Runs before anything else starts. Resolves `'start'` when gil should start normally, or
 * `'installing'` when it is about to quit and relaunch into a new version.
 */
export async function updateBeforeLaunch(): Promise<'start' | 'installing'> {
  if (!updatesEnabled()) return 'start'
  const { autoUpdater } = electronUpdater
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('error', (error) => console.error('Update failed', error))

  const check = await Promise.race([
    autoUpdater.checkForUpdates().catch(() => null),
    timeout(LAUNCH_CHECK_TIMEOUT_MS),
  ])
  if (check === 'timeout' || !check?.isUpdateAvailable) return 'start'

  const window = showUpdatingWindow(check.updateInfo.version)
  const finished = await new Promise<boolean>((resolve) => {
    let stall = setTimeout(() => resolve(false), STALL_TIMEOUT_MS)
    autoUpdater.on('download-progress', (progress) => {
      clearTimeout(stall)
      stall = setTimeout(() => resolve(false), STALL_TIMEOUT_MS)
      setProgress(window, progress.percent)
    })
    autoUpdater.once('update-downloaded', () => {
      clearTimeout(stall)
      resolve(true)
    })
    // An update downloaded earlier in the background is reused, so this is quick.
    autoUpdater.downloadUpdate().catch(() => {
      clearTimeout(stall)
      resolve(false)
    })
  })
  if (!finished) {
    window.destroy()
    return 'start'
  }
  // The window stays up until the app quits, so the relaunch does not look like a crash.
  setProgress(window, 100, 'Restarting…')
  // A window that cannot be closed would also stop the app from quitting to install.
  window.setClosable(true)
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
  return 'installing'
}

/** The background check for a gil that keeps running; the menu bar offers the restart. */
export function startBackgroundUpdates(onReady: (version: string) => void): void {
  if (!updatesEnabled()) return
  const { autoUpdater } = electronUpdater
  autoUpdater.autoDownload = true
  autoUpdater.on('update-downloaded', (info) => onReady(info.version))
  const check = () => {
    autoUpdater.checkForUpdates().catch((error: unknown) => console.error('Update check failed', error))
  }
  // Soon after starting too, in case the launch check timed out on a slow connection.
  setTimeout(check, 60_000)
  setInterval(check, CHECK_EVERY_MS)
}

export function restartToUpdate(): void {
  electronUpdater.autoUpdater.quitAndInstall(true, true)
}

const UPDATING_PAGE = (version: string) => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root { color-scheme: light dark; }
body { margin: 0; height: 100vh; display: flex; flex-direction: column; justify-content: center; gap: 12px;
  padding: 0 24px; box-sizing: border-box; font: 13px -apple-system, BlinkMacSystemFont, sans-serif;
  background: Canvas; color: CanvasText; -webkit-user-select: none; -webkit-app-region: drag; }
h1 { margin: 0; font-size: 15px; font-weight: 600; }
.bar { height: 6px; border-radius: 3px; background: color-mix(in srgb, CanvasText 12%, transparent); overflow: hidden; }
.fill { height: 100%; width: 0; border-radius: 3px; background: #0a6cff; transition: width .2s; }
.note { color: color-mix(in srgb, CanvasText 60%, transparent); font-variant-numeric: tabular-nums; }
</style></head><body>
<h1>✌️ Updating gil to ${version}</h1>
<div class="bar"><div class="fill" id="fill"></div></div>
<div class="note" id="note">Downloading…</div>
<script>window.setProgress=function(p,label){document.getElementById('fill').style.width=p+'%';document.getElementById('note').textContent=label||('Downloading… '+Math.round(p)+'%')}</script>
</body></html>`

function showUpdatingWindow(version: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 380,
    height: 130,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // No way to dismiss it: the update is not skippable.
    closable: false,
    titleBarStyle: 'hidden',
    title: 'Updating gil',
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.once('ready-to-show', () => {
    window.show()
    app.focus({ steal: true })
  })
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(UPDATING_PAGE(version))}`)
  return window
}

function setProgress(window: BrowserWindow, percent: number, label?: string): void {
  if (window.isDestroyed()) return
  const value = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  window.webContents
    .executeJavaScript(`window.setProgress && window.setProgress(${value}, ${JSON.stringify(label ?? null)})`)
    .catch(() => undefined)
}
