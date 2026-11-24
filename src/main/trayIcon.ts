import { BrowserWindow, nativeImage, type NativeImage, type Tray } from 'electron'
import { DOT_CLOUD_SCRIPT, LOOP_SECONDS, STATUS_DIALS, TRAY_FPS, type TrayStatus } from '../shared/dotCloud'

/** The menu bar icon's size in points (macOS menu bar icons are 16–22 pt tall). */
const SIZE = 18
const FRAMES = LOOP_SECONDS * TRAY_FPS

/**
 * The turning Dot cloud in the menu bar. Main has no canvas, so a hidden, unprivileged window
 * draws each frame (at 1x and 2x) and hands it back as a picture. Frames are kept once drawn, so
 * after one loop of a status nothing is drawn again. Pictures are template images: black ink
 * that macOS turns white on a dark menu bar.
 */
export class TrayAnimation {
  private readonly painter: BrowserWindow
  private ready: Promise<unknown>
  private readonly frames = new Map<string, NativeImage>()
  private timer: NodeJS.Timeout | null = null
  private drawing = false
  private readonly start = Date.now()

  constructor(
    private readonly tray: Tray,
    private readonly status: () => TrayStatus,
  ) {
    this.painter = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    })
    const page = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'"><script>${DOT_CLOUD_SCRIPT}
function frame(dials, t) {
  const out = [];
  for (const scale of [1, 2]) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ${SIZE} * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#000';
    drawDotCloud(ctx, ${SIZE}, dials, t);
    out.push(canvas.toDataURL('image/png'));
  }
  return out;
}</script>`
    this.ready = this.painter.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
  }

  run(): void {
    this.timer = setInterval(() => void this.tick(), 1000 / TRAY_FPS)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (!this.painter.isDestroyed()) this.painter.destroy()
  }

  private async tick(): Promise<void> {
    if (this.drawing || this.painter.isDestroyed()) return
    this.drawing = true
    try {
      const status = this.status()
      const index = Math.floor(((Date.now() - this.start) / 1000) * TRAY_FPS) % FRAMES
      const key = `${status}:${index}`
      let image = this.frames.get(key)
      if (!image) {
        await this.ready
        const t = index / TRAY_FPS
        const [one, two] = (await this.painter.webContents.executeJavaScript(
          `frame(${JSON.stringify(STATUS_DIALS[status])}, ${t})`,
        )) as [string, string]
        image = nativeImage.createEmpty()
        image.addRepresentation({ scaleFactor: 1, dataURL: one })
        image.addRepresentation({ scaleFactor: 2, dataURL: two })
        image.setTemplateImage(true)
        this.frames.set(key, image)
      }
      if (!this.tray.isDestroyed()) this.tray.setImage(image)
    } catch (error) {
      console.error('Could not draw the menu bar icon', error)
      this.stop()
    } finally {
      this.drawing = false
    }
  }
}
