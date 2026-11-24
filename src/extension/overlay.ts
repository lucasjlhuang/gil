import { readPageStyles } from './pageStyles'
import {
  expandRect,
  isSelectable,
  placeOutside,
  rectFromPoints,
  type Point,
  type Rect,
} from '../shared/geometry'
import { MAX_CONTEXT_LENGTH } from '../shared/overlayChannel'
import type { CaptureResult, OverlayMessage, Selection, ToOverlayMessage } from './messages'

/**
 * Region overlay, injected into the tab when the user clicks the gil icon. It runs in the
 * extension's isolated world and draws inside a closed shadow root, so the page cannot read or
 * restyle it. Same rules as gil's own overlay: nothing is drawn inside the region while
 * recording, so the crop removes the outline and timer, and the whole overlay is gone before a
 * screenshot is taken.
 */

declare global {
  interface Window {
    __gilOverlay?: { restart: () => void }
  }
}

const PANEL_SIZE = { width: 440, height: 78 }
const TIMER_SIZE = { width: 92, height: 28 }
const OUTLINE_OUTSET = 3
const TOAST_MS = 3500

const STYLES = `
:host { all: initial; }
.root { position: fixed; inset: 0; z-index: 2147483647; font: 13px/1.3 -apple-system, BlinkMacSystemFont, sans-serif; color: #fff; }
.root.select { cursor: crosshair; }
.root.passive { pointer-events: none; }
.dim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); }
.selection { position: fixed; box-sizing: border-box; border: 1px solid rgba(255,255,255,0.9); box-shadow: 0 0 0 9999px rgba(0,0,0,0.35); }
.hint { position: fixed; left: 50%; top: 24px; transform: translateX(-50%); padding: 8px 14px; border-radius: 8px; background: rgba(30,30,32,0.92); }
.panel { position: fixed; box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 10px; background: rgba(30,30,32,0.96); box-shadow: 0 0 0 1px rgba(255,255,255,0.12), 0 8px 24px rgba(0,0,0,0.4); cursor: default; }
.panel .row { display: flex; flex: 1; gap: 8px; }
.panel .target { color: rgba(255,255,255,0.7); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
input { flex: 1; min-width: 0; padding: 0 10px; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; background: rgba(255,255,255,0.08); color: inherit; font: inherit; outline: none; }
input:focus { border-color: rgba(120,170,255,0.9); }
button { padding: 0 14px; border: 0; border-radius: 6px; background: #e5484d; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
button.secondary { background: rgba(255,255,255,0.14); }
.outline { position: fixed; box-sizing: border-box; border: 2px solid #e5484d; border-radius: 2px; }
.outline.arming { border-color: rgba(255,255,255,0.9); }
.timer { position: fixed; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 0; border-radius: 14px; background: rgba(30,30,32,0.92); font-variant-numeric: tabular-nums; pointer-events: auto; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #e5484d; }
.toast { position: fixed; right: 16px; bottom: 16px; max-width: 360px; padding: 10px 14px; border-radius: 8px; background: rgba(30,30,32,0.96); box-shadow: 0 8px 24px rgba(0,0,0,0.4); pointer-events: auto; }
.toast.error { background: #a4262c; }
`

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight }
}

function place(element: HTMLElement, rect: Rect): void {
  Object.assign(element.style, {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = className
  if (text) element.textContent = text
  return element
}

/** Two frames: the first commits the change, the second has it on screen. */
function painted(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

function send<T>(message: OverlayMessage): Promise<T> {
  return chrome.runtime.sendMessage(message)
}

class Overlay {
  private host: HTMLElement | null = null
  private root: HTMLDivElement | null = null
  private cleanup: (() => void)[] = []

  restart(): void {
    this.teardown()
    this.select()
  }

  /** Shows the overlay in a new state, dropping the listeners and timers of the previous one. */
  private mount(className: string): HTMLDivElement {
    this.cleanup.forEach((undo) => undo())
    this.cleanup = []
    if (!this.host) {
      const host = document.createElement('gil-capture')
      const shadow = host.attachShadow({ mode: 'closed' })
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(STYLES)
      shadow.adoptedStyleSheets = [sheet]
      const root = el('div', className)
      shadow.append(root)
      document.documentElement.append(host)
      this.host = host
      this.root = root
    }
    const root = this.root as HTMLDivElement
    root.className = `root ${className}`
    root.replaceChildren()
    return root
  }

  private teardown(): void {
    this.cleanup.forEach((undo) => undo())
    this.cleanup = []
    this.host?.remove()
    this.host = null
    this.root = null
  }

  private listen<K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void): void {
    window.addEventListener(type, handler, true)
    this.cleanup.push(() => window.removeEventListener(type, handler, true))
  }

  cancel(notify: boolean): void {
    this.teardown()
    if (notify) void send({ type: 'cancel' }).catch(() => undefined)
  }

  private select(): void {
    const root = this.mount('select')
    const dim = el('div', 'dim')
    const hint = el('div', 'hint', 'Drag over what you want to capture. Esc to cancel.')
    root.append(dim, hint)

    let start: Point | null = null
    let box: HTMLDivElement | null = null

    this.listen('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        this.cancel(true)
      }
    })
    root.addEventListener('mousedown', (event) => {
      // The panel stops its own clicks, so anything arriving here starts a new selection.
      if (event.button !== 0 || !event.isTrusted) return
      event.preventDefault()
      start = { x: event.clientX, y: event.clientY }
      root.replaceChildren()
      box = el('div', 'selection')
      root.append(box)
      place(box, { ...start, width: 0, height: 0 })
    })
    root.addEventListener('mousemove', (event) => {
      if (start && box) place(box, rectFromPoints(start, { x: event.clientX, y: event.clientY }))
    })
    root.addEventListener('mouseup', (event) => {
      if (!start || !event.isTrusted) return
      const rect = rectFromPoints(start, { x: event.clientX, y: event.clientY })
      start = null
      if (!isSelectable(rect)) {
        root.replaceChildren(dim, hint)
        return
      }
      this.showPanel(root, rect)
    })
  }

  private showPanel(root: HTMLDivElement, rect: Rect): void {
    const at =
      placeOutside(rect, PANEL_SIZE, viewport(), 10) ?? {
        x: Math.max(8, Math.min(rect.x + 8, viewport().width - PANEL_SIZE.width - 8)),
        y: Math.max(8, rect.y + rect.height - PANEL_SIZE.height - 8),
      }
    const panel = el('form', 'panel')
    place(panel, { ...at, ...PANEL_SIZE })
    const target = el('div', 'target', `${Math.round(rect.width)} × ${Math.round(rect.height)} on ${location.host}`)
    const row = el('div', 'row')
    const input = el('input', '')
    input.placeholder = 'What should I look for? (optional)'
    input.maxLength = MAX_CONTEXT_LENGTH
    const shot = el('button', 'secondary', 'Screenshot')
    shot.type = 'button'
    const record = el('button', '', 'Record')
    record.type = 'submit'
    row.append(input, shot, record)
    panel.append(target, row)
    root.append(panel)

    // Keep the page's own shortcuts from seeing what is typed here.
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      panel.addEventListener(type, (event) => event.stopPropagation())
    }
    panel.addEventListener('mousedown', (event) => event.stopPropagation())
    panel.addEventListener('mouseup', (event) => event.stopPropagation())
    input.focus()

    const selection = (): Selection => ({
      region: rect,
      viewport: viewport(),
      devicePixelRatio: window.devicePixelRatio,
      context: input.value,
      styles: readPageStyles(rect, this.host),
    })
    shot.addEventListener('click', (event) => {
      if (event.isTrusted) void this.screenshot(selection())
    })
    panel.addEventListener('submit', (event) => {
      event.preventDefault()
      if (event.isTrusted) void this.record(selection())
    })
  }

  private async screenshot(selection: Selection): Promise<void> {
    // Nothing of the overlay may be on screen when Chrome grabs the tab.
    this.teardown()
    await painted()
    const result = await send<CaptureResult>({ type: 'screenshot', selection }).catch(
      (error: unknown): CaptureResult => ({ ok: false, error: String(error) }),
    )
    this.toast(result)
  }

  private async record(selection: Selection): Promise<void> {
    const root = this.mount('passive')
    const outline = el('div', 'outline arming')
    place(outline, expandRect(selection.region, OUTLINE_OUTSET))
    root.append(outline)
    const timerAt = placeOutside(expandRect(selection.region, OUTLINE_OUTSET), TIMER_SIZE, viewport(), 6)
    const timer = el('button', 'timer')
    timer.type = 'button'
    timer.title = 'Stop recording'
    timer.append(el('span', 'dot'), el('span', '', 'Starting'))
    if (timerAt) {
      place(timer, { ...timerAt, ...TIMER_SIZE })
      root.append(timer)
    }
    await painted()

    const reply = await send<{ ok: true } | { ok: false; error: string }>({ type: 'record', selection }).catch(
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    )
    if (!reply.ok) {
      this.toast(reply)
      return
    }
    outline.classList.remove('arming')
    const startedAt = Date.now()
    const label = timer.lastElementChild as HTMLElement
    const tick = setInterval(() => {
      const tenths = Math.floor((Date.now() - startedAt) / 100)
      label.textContent = `${Math.floor(tenths / 10)}.${tenths % 10}s`
    }, 100)
    this.cleanup.push(() => clearInterval(tick))
    timer.addEventListener('click', (event) => {
      if (event.isTrusted) void send({ type: 'stop' }).catch(() => undefined)
    })
  }

  /** Shows how a capture went, then removes the overlay. */
  toast(result: CaptureResult): void {
    const root = this.mount('passive')
    const message = result.ok ? `Saved to gil as ${result.name}` : `gil: ${result.error}`
    root.append(el('div', result.ok ? 'toast' : 'toast error', message))
    const timeout = setTimeout(() => this.teardown(), TOAST_MS)
    this.cleanup.push(() => clearTimeout(timeout))
  }
}

if (window.__gilOverlay) {
  window.__gilOverlay.restart()
} else {
  const overlay = new Overlay()
  window.__gilOverlay = overlay
  chrome.runtime.onMessage.addListener((message: ToOverlayMessage, sender) => {
    if (sender.id !== chrome.runtime.id) return false
    if (message.type === 'cancel') overlay.cancel(false)
    if (message.type === 'finished') overlay.toast(message.result)
    return false
  })
  overlay.restart()
}
