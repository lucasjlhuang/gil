import { contextBridge, ipcRenderer } from 'electron'
import type { RecorderApi } from '../shared/channels'
import { RecorderChannel } from '../shared/recorderChannel'

const api: RecorderApi = {
  onStop(listener) {
    const handler = () => listener()
    ipcRenderer.on(RecorderChannel.stop, handler)
    return () => ipcRenderer.removeListener(RecorderChannel.stop, handler)
  },
  started: (info) => ipcRenderer.send(RecorderChannel.started, info),
  chunk: (data) => ipcRenderer.send(RecorderChannel.chunk, data),
  stopped: (info) => ipcRenderer.send(RecorderChannel.stopped, info),
  failed: (message) => ipcRenderer.send(RecorderChannel.failed, message),
}

contextBridge.exposeInMainWorld('gilRecorder', api)
