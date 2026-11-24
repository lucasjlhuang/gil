import { contextBridge, ipcRenderer } from 'electron'
import type { OverlayApi, OverlayState } from '../shared/channels'
import { OverlayChannel } from '../shared/overlayChannel'

const api: OverlayApi = {
  onState(listener) {
    const handler = (_event: unknown, state: OverlayState) => listener(state)
    ipcRenderer.on(OverlayChannel.state, handler)
    return () => ipcRenderer.removeListener(OverlayChannel.state, handler)
  },
  resolveTarget: (rect) => ipcRenderer.invoke(OverlayChannel.resolveTarget, rect),
  record: (request) => ipcRenderer.send(OverlayChannel.record, request),
  screenshot: (request) => ipcRenderer.send(OverlayChannel.screenshot, request),
  cancel: () => ipcRenderer.send(OverlayChannel.cancel),
  painted: () => ipcRenderer.send(OverlayChannel.painted),
  focus: () => ipcRenderer.send(OverlayChannel.focus),
  setInteractive: (interactive) => ipcRenderer.send(OverlayChannel.setInteractive, interactive),
  stop: () => ipcRenderer.send(OverlayChannel.stop),
}

contextBridge.exposeInMainWorld('gilOverlay', api)
