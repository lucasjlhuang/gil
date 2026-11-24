import { app, type BrowserWindow } from 'electron'

/**
 * gil is a menu bar app, but while one of its ordinary windows (the library) is
 * open it should be reachable with Cmd+Tab. macOS only lists regular apps there, and a regular app
 * always has a Dock icon, so gil is a regular app exactly while such a window is open and
 * goes back to menu-bar-only when the last one closes. Overlays and the hidden recorder do not
 * count.
 */
export class AppSwitcherPresence {
  private readonly windows = new Set<BrowserWindow>()

  track(window: BrowserWindow): void {
    this.windows.add(window)
    window.on('closed', () => {
      this.windows.delete(window)
      this.update()
    })
    this.update()
  }

  private update(): void {
    if (process.platform !== 'darwin') return
    app.setActivationPolicy(this.windows.size > 0 ? 'regular' : 'accessory')
  }
}
