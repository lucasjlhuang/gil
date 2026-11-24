import type {
  CaptureResult,
  OffscreenMessage,
  OffscreenStartReply,
  OverlayMessage,
  RecordingMetaBase,
  Selection,
  ToOverlayMessage,
} from './messages'
import { uploadCapture } from './upload'

/**
 * The extension's service worker. Clicking the toolbar icon (or its shortcut) on a tab injects
 * the region overlay into that tab; the overlay sends back a selection. Screenshots come from
 * `captureVisibleTab`. Recordings come from tab capture in an offscreen document, which keeps
 * recording, and Chrome keeps the tab rendering, when the user switches to another tab or app.
 * Everything goes to gil on 127.0.0.1, which crops and saves it.
 */

const MAX_DURATION_MS = 10_000
const OFFSCREEN_URL = 'offscreen.html'
const BROWSER_NAME = 'Google Chrome'

type Session =
  | { phase: 'selecting'; tabId: number }
  | { phase: 'recording'; tabId: number; meta: RecordingMetaBase; timer: ReturnType<typeof setTimeout> }
  | { phase: 'saving'; tabId: number }

let session: Session | null = null

async function pairingCode(): Promise<string | null> {
  const { pairingCode } = await chrome.storage.local.get('pairingCode')
  return typeof pairingCode === 'string' && pairingCode ? pairingCode : null
}

function toOverlay(tabId: number, message: ToOverlayMessage): void {
  chrome.tabs.sendMessage(tabId, message).catch(() => undefined)
}

async function setBadge(text: '' | 'REC' | '…' | '!', title?: string): Promise<void> {
  await chrome.action.setBadgeText({ text })
  if (text) await chrome.action.setBadgeBackgroundColor({ color: text === 'REC' ? '#e5484d' : '#666' })
  await chrome.action.setTitle({ title: title ?? 'Capture with gil' })
}

chrome.action.onClicked.addListener((tab) => {
  void onInvoked(tab)
})

async function onInvoked(tab: chrome.tabs.Tab): Promise<void> {
  if (session?.phase === 'recording') return stopRecording()
  if (session?.phase === 'saving') return
  if (tab.id === undefined) return
  if (!(await pairingCode())) {
    await chrome.runtime.openOptionsPage()
    return
  }
  if (session?.phase === 'selecting') {
    const previous = session.tabId
    session = null
    toOverlay(previous, { type: 'cancel' })
    if (previous === tab.id) return
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] })
    session = { phase: 'selecting', tabId: tab.id }
    await setBadge('')
  } catch {
    // Chrome does not let extensions into its own pages, the Web Store, or other extensions.
    await setBadge('!', 'gil cannot capture this page')
  }
}

chrome.runtime.onMessage.addListener((message: OverlayMessage, sender, sendResponse) => {
  const tab = sender.tab
  // Only the overlay in the tab being captured may drive a capture.
  if (sender.id !== chrome.runtime.id || !tab?.id || session?.tabId !== tab.id) return false
  switch (message.type) {
    case 'cancel':
      if (session.phase === 'selecting') session = null
      return false
    case 'screenshot':
      void screenshot(tab, message.selection).then(sendResponse)
      return true
    case 'record':
      void startRecording(tab, message.selection).then(sendResponse)
      return true
    case 'stop':
      void stopRecording()
      return false
    default:
      return false
  }
})

function metaBase(tab: chrome.tabs.Tab, selection: Selection): RecordingMetaBase {
  return {
    region: selection.region,
    viewport: selection.viewport,
    context: selection.context,
    url: tab.url ?? null,
    title: tab.title ?? null,
    browser: BROWSER_NAME,
    pageStyles: selection.styles,
  }
}

async function screenshot(tab: chrome.tabs.Tab, selection: Selection): Promise<CaptureResult> {
  const code = await pairingCode()
  session = { phase: 'saving', tabId: tab.id ?? -1 }
  try {
    if (!code) return { ok: false, error: 'Pair the extension with gil first.' }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    const image = await (await fetch(dataUrl)).blob()
    const result = await uploadCapture(code, { mode: 'screenshot', ...metaBase(tab, selection) }, image)
    await setBadge(result.ok ? '' : '!', result.ok ? undefined : result.error)
    return result
  } catch (error) {
    return { ok: false, error: describe(error) }
  } finally {
    session = null
  }
}

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_URL)
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  })
  if (existing.length > 0) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Records the tab the user selected so it can be saved to gil.',
  })
}

function toOffscreen<T>(message: OffscreenMessage): Promise<T> {
  return chrome.runtime.sendMessage(message)
}

async function startRecording(tab: chrome.tabs.Tab, selection: Selection): Promise<CaptureResult | { ok: true }> {
  const tabId = tab.id ?? -1
  try {
    // The user invoked the extension on this tab (activeTab), which is what allows capturing it.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
    await ensureOffscreen()
    const reply = await toOffscreen<OffscreenStartReply>({
      target: 'offscreen',
      type: 'start',
      streamId,
      width: Math.round(selection.viewport.width * selection.devicePixelRatio),
      height: Math.round(selection.viewport.height * selection.devicePixelRatio),
    })
    if (!reply.ok) throw new Error(reply.error)
    session = {
      phase: 'recording',
      tabId,
      meta: metaBase(tab, selection),
      timer: setTimeout(() => void stopRecording(), MAX_DURATION_MS),
    }
    await setBadge('REC', 'Stop recording')
    return { ok: true }
  } catch (error) {
    session = null
    await closeOffscreen()
    return { ok: false, error: describe(error) }
  }
}

async function stopRecording(): Promise<void> {
  if (session?.phase !== 'recording') return
  const { tabId, meta, timer } = session
  clearTimeout(timer)
  session = { phase: 'saving', tabId }
  await setBadge('…', 'Saving to gil')
  let result: CaptureResult
  try {
    const code = await pairingCode()
    if (!code) throw new Error('Pair the extension with gil first.')
    result = await toOffscreen<CaptureResult>({
      target: 'offscreen',
      type: 'stop',
      upload: { pairingCode: code },
      meta,
    })
  } catch (error) {
    result = { ok: false, error: describe(error) }
  }
  await closeOffscreen()
  session = null
  await setBadge(result.ok ? '' : '!', result.ok ? undefined : result.error)
  toOverlay(tabId, { type: 'finished', result })
}

async function closeOffscreen(): Promise<void> {
  await chrome.offscreen.closeDocument().catch(() => undefined)
}

// The tab was closed mid-capture: drop the capture.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId !== tabId) return
  if (session.phase === 'recording') {
    clearTimeout(session.timer)
    void toOffscreen({ target: 'offscreen', type: 'abort' }).catch(() => undefined).then(closeOffscreen)
    void setBadge('')
  }
  if (session.phase !== 'saving') session = null
})

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
