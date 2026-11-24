import { app, globalShortcut, Menu, nativeImage, screen, session, Tray } from 'electron'
import { AnalysisQueue } from './analysis/queue'
import { Bridge } from './bridge'
import { hasApiKey } from './apiKey'
import { AppSwitcherPresence } from './appSwitcher'
import { CaptureController } from './capture'
import { checkRequestPath, runCheckMode } from './checkMode'
import { appInfo, legacyLibraryRoot, LibraryWindow, libraryRoot, registerAssetScheme } from './library'
import { moveLegacyLibrary } from './storage'
import { OverlayManager } from './overlay'
import { screenPermission } from './permissions'
import { restartToUpdate, startBackgroundUpdates, updateBeforeLaunch } from './updates'
import { Recorder } from './recorder'

/** gil's logo for now. The app icon is build/icon.png, rendered from the same emoji. */
const TRAY_LOGO = '✌️'
const CAPTURE_SHORTCUT = 'CommandOrControl+Shift+2'

registerAssetScheme()

// Kept at module scope so the tray is not garbage collected.
let tray: Tray | null = null

function createTray(
  actions: { capture: () => void; library: () => void },
  shortcutOk: boolean,
): (updateVersion: string | null) => void {
  // The menu bar shows gil's logo, the ✌️ emoji, as text (an image there would have to be a
  // one-colour template).
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle(TRAY_LOGO)
  tray.setToolTip('gil')
  // Rebuilt when an update is ready, to offer the restart.
  const setMenu = (updateVersion: string | null) =>
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        // Which build this is, so the user can tell versions apart.
        { label: `gil ${appInfo().label}`, enabled: false },
        { type: 'separator' },
        shortcutOk
          ? { label: 'Capture Region', accelerator: CAPTURE_SHORTCUT, click: actions.capture }
          : { label: 'Capture Region (shortcut in use by another app)', click: actions.capture },
        { label: 'Open Library', click: actions.library },
        { type: 'separator' },
        ...(updateVersion
          ? [{ label: `Restart to Update to ${updateVersion}`, click: restartToUpdate }, { type: 'separator' as const }]
          : []),
        { label: 'Quit gil', role: 'quit' },
      ]),
    )
  setMenu(null)
  return setMenu
}

function main(): void {
  // A menu bar app: no Dock icon until one of its windows opens (see appSwitcher.ts), and it
  // never becomes the active app just to show the overlay.
  if (process.platform === 'darwin') app.setActivationPolicy('accessory')
  app.setAboutPanelOptions({ applicationVersion: app.getVersion(), version: __GIL_COMMIT__ })

  // Renderers on the default session get no permissions at all; only the recorder's own
  // session can capture the screen (see recorder.ts).
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )

  const overlays = new OverlayManager()
  const recorder = new Recorder()
  let controller: CaptureController | null = null

  const library = new LibraryWindow((force) => startCapture(force))
  const analysis = new AnalysisQueue({ libraryRoot, onChanged: () => library.notifyChanged() })
  library.analysis = analysis
  const startCapture = (force = false) => {
    if (!controller) return
    // Stopping or cancelling must always work; only starting needs the permission.
    if (controller.isIdle && !force && screenPermission() !== 'granted') {
      // The library explains what is missing.
      library.show()
      library.notifyChanged()
      return
    }
    controller.toggle()
  }

  controller = new CaptureController({
    overlays,
    recorder,
    libraryRoot,
    // Saving never brings gil forward; the library updates if it is open. With an API key,
    // every new capture is analyzed in the background.
    onSaved: (asset) => {
      library.notifyChanged()
      void hasApiKey().then((has) => (has || asset.lens === 'color' ? analysis.enqueue(asset.id) : undefined))
    },
  })

  // The Chrome extension's capture bridge, on the loopback address only (see bridge.ts).
  const bridge = new Bridge({
    libraryRoot,
    onSaved: (asset) => {
      library.notifyChanged()
      void hasApiKey().then((has) => (has || asset.lens === 'color' ? analysis.enqueue(asset.id) : undefined))
    },
  })
  library.bridge = bridge
  void bridge.init().catch((error: unknown) => console.error('Could not start the capture bridge', error))

  library.onImported = (asset) => {
    void hasApiKey().then((has) => (has ? analysis.enqueue(asset.id) : undefined))
  }

  // gil is in Cmd+Tab (and the Dock) only while its library window is open.
  const switcher = new AppSwitcherPresence()
  library.onWindowCreated = (window) => switcher.track(window)

  library.init()
  void analysis.resume()
  recorder.init()
  overlays.rebuild()
  const rebuildWhenIdle = () => {
    if (controller.isIdle) overlays.rebuild()
  }
  screen.on('display-added', rebuildWhenIdle)
  screen.on('display-removed', rebuildWhenIdle)
  screen.on('display-metrics-changed', rebuildWhenIdle)

  const shortcutOk = globalShortcut.register(CAPTURE_SHORTCUT, () => startCapture())
  const setTrayMenu = createTray(
    { capture: () => startCapture(), library: () => library.show() },
    shortcutOk,
  )
  startBackgroundUpdates((version) => setTrayMenu(version))

  app.on('second-instance', () => library.show())
  library.show()
}

// Started by gil's own MCP server to check a draft: answer and quit, beside a running gil.
const checkRequest = checkRequestPath(process.argv)
if (checkRequest) {
  runCheckMode(checkRequest)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Closing the library window leaves gil running in the menu bar.
  app.on('window-all-closed', () => undefined)
  app.on('will-quit', () => globalShortcut.unregisterAll())
  void app
    .whenReady()
    // Like a game patching before it lets you in: a pending update installs first.
    .then(() => updateBeforeLaunch().catch(() => 'start' as const))
    .then(async (next) => {
      if (next === 'installing') return
      await moveLegacyLibrary(libraryRoot(), legacyLibraryRoot()).catch((error: unknown) =>
        console.error('Could not move the old library folder', error),
      )
      main()
    })
}
