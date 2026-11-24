import { BrowserWindow, screen, type Display, type WebContents } from 'electron'
import { OverlayChannel, type OverlayState } from '../shared/channels'
import { loadRenderer, lockNavigation, rendererPreferences } from './windows'

export interface Overlay {
  window: BrowserWindow
  display: Display
}

/**
 * One transparent panel per display, created hidden at launch so the shortcut only has to
 * show them. Thin by design: this is the part that cannot be unit tested.
 */
export class OverlayManager {
  private overlays = new Map<number, Overlay>()

  /** (Re)creates the overlays to match the current displays. */
  rebuild(): void {
    for (const overlay of this.overlays.values()) overlay.window.destroy()
    this.overlays.clear()
    for (const display of screen.getAllDisplays()) {
      this.overlays.set(display.id, { window: this.createWindow(display), display })
    }
  }

  private createWindow(display: Display): BrowserWindow {
    const window = new BrowserWindow({
      ...display.bounds,
      show: false,
      // A non-activating panel: it can take the mouse and keyboard without making gil the
      // active app, so the app being captured stays frontmost. Also floats over full-screen apps.
      type: 'panel',
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      // The first click on a display whose overlay is not key must start the drag.
      acceptFirstMouse: true,
      // Lets the window cover the menu bar instead of being pushed below it.
      enableLargerThanScreen: true,
      webPreferences: rendererPreferences('overlay'),
    })
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      // gil is already an accessory app; skipping avoids a Dock flicker.
      skipTransformProcessType: true,
    })
    // Best effort only: macOS no longer guarantees this hides a window from capture, so the
    // overlay also never draws inside the recorded region. See docs/ARCHITECTURE.md.
    window.setContentProtection(true)
    window.setBounds(display.bounds)
    lockNavigation(window)
    void loadRenderer(window, 'overlay')
    return window
  }

  get(displayId: number): Overlay | undefined {
    return this.overlays.get(displayId)
  }

  find(sender: WebContents): Overlay | undefined {
    for (const overlay of this.overlays.values()) {
      if (!overlay.window.isDestroyed() && overlay.window.webContents === sender) return overlay
    }
    return undefined
  }

  send(overlay: Overlay, state: OverlayState): void {
    if (!overlay.window.isDestroyed()) overlay.window.webContents.send(OverlayChannel.state, state)
  }

  /** Shows the selection UI on every display and gives the keyboard to the one under the cursor. */
  showForSelection(): void {
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    for (const overlay of this.overlays.values()) {
      overlay.window.setIgnoreMouseEvents(false)
      this.send(overlay, { phase: 'select' })
      overlay.window.setBounds(overlay.display.bounds)
      if (overlay.display.id === cursorDisplay.id) overlay.window.show()
      else overlay.window.showInactive()
    }
  }

  hideAllExcept(keep: Overlay | null): void {
    for (const overlay of this.overlays.values()) {
      if (overlay === keep || overlay.window.isDestroyed()) continue
      overlay.window.hide()
      overlay.window.setIgnoreMouseEvents(false)
      // Reset while hidden so the next show paints the selection UI straight away.
      this.send(overlay, { phase: 'select' })
    }
  }
}
