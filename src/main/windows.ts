import { join } from 'node:path'
import { app, type BrowserWindow, type WebPreferences } from 'electron'

export type RendererName = 'overlay' | 'recorder' | 'library'

/** Every renderer is unprivileged: isolated, sandboxed, no Node, one narrow preload. */
export function rendererPreferences(name: RendererName): WebPreferences {
  return {
    preload: join(__dirname, `../preload/${name}.js`),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  }
}

export function loadRenderer(window: BrowserWindow, name: RendererName): Promise<void> {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServer) {
    return window.loadURL(`${devServer}/${name}/index.html`)
  }
  return window.loadFile(join(__dirname, `../renderer/${name}/index.html`))
}

/** Renderers never navigate or open windows. */
export function lockNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
}
