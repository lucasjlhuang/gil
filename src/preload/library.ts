import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { LibraryApi } from '../shared/channels'
import { LibraryChannel } from '../shared/libraryChannel'

const api: LibraryApi = {
  list: () => ipcRenderer.invoke(LibraryChannel.list),
  appInfo: () => ipcRenderer.invoke(LibraryChannel.appInfo),
  onChanged(listener) {
    const handler = () => listener()
    ipcRenderer.on(LibraryChannel.changed, handler)
    return () => ipcRenderer.removeListener(LibraryChannel.changed, handler)
  },
  getPermission: () => ipcRenderer.invoke(LibraryChannel.permission),
  requestPermission: () => ipcRenderer.invoke(LibraryChannel.requestPermission),
  openPermissionSettings: () => ipcRenderer.invoke(LibraryChannel.openPermissionSettings),
  relaunch: () => ipcRenderer.invoke(LibraryChannel.relaunch),
  capture: (force) => ipcRenderer.invoke(LibraryChannel.capture, force),
  analyze: (id) => ipcRenderer.invoke(LibraryChannel.analyze, id),
  refine: (id, instruction) => ipcRenderer.invoke(LibraryChannel.refine, { id, instruction }),
  details: (name) => ipcRenderer.invoke(LibraryChannel.details, name),
  saveEdits: (id, edits) => ipcRenderer.invoke(LibraryChannel.saveEdits, { id, edits }),
  copy: (text) => ipcRenderer.invoke(LibraryChannel.copy, text),
  rename: (id, name, title) => ipcRenderer.invoke(LibraryChannel.rename, { id, name, title }),
  setTags: (id, tags) => ipcRenderer.invoke(LibraryChannel.setTags, { id, tags }),
  trash: (id) => ipcRenderer.invoke(LibraryChannel.trash, id),
  hasApiKey: () => ipcRenderer.invoke(LibraryChannel.hasApiKey),
  setApiKey: (key) => ipcRenderer.invoke(LibraryChannel.setApiKey, key),
  clearApiKey: () => ipcRenderer.invoke(LibraryChannel.clearApiKey),
  mcpStatus: () => ipcRenderer.invoke(LibraryChannel.mcpStatus),
  bridgeStatus: () => ipcRenderer.invoke(LibraryChannel.bridgeStatus),
  revealExtension: () => ipcRenderer.invoke(LibraryChannel.revealExtension),
  connectClaudeDesktop: () => ipcRenderer.invoke(LibraryChannel.connectClaudeDesktop),
  installSkill: () => ipcRenderer.invoke(LibraryChannel.installSkill),
  getGlossary: () => ipcRenderer.invoke(LibraryChannel.getGlossary),
  saveGlossary: (terms) => ipcRenderer.invoke(LibraryChannel.saveGlossary, terms),
  exportAsset: (id) => ipcRenderer.invoke(LibraryChannel.exportAsset, id),
  // A dropped file's path is only readable here, in the preload.
  // Items with no file on disk (an image dragged from a web page) have no path and are skipped.
  importFiles: (files) => {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter((path) => path !== '')
    if (paths.length === 0) return Promise.resolve({ ok: false, error: 'Drag image files from Finder, or copy the image and paste it here.' })
    return ipcRenderer.invoke(LibraryChannel.importFiles, paths)
  },
  importClipboard: () => ipcRenderer.invoke(LibraryChannel.importClipboard),
  importDialog: () => ipcRenderer.invoke(LibraryChannel.importDialog),
  runLens: (id, lens) => ipcRenderer.invoke(LibraryChannel.runLens, { id, lens }),
  createDesignSystem: (title, memberIds) => ipcRenderer.invoke(LibraryChannel.createDesignSystem, { title, memberIds }),
  setMembers: (id, memberIds) => ipcRenderer.invoke(LibraryChannel.setMembers, { id, memberIds }),
  createNote: (title, text) => ipcRenderer.invoke(LibraryChannel.createNote, { title, text }),
  saveNotes: (id, text) => ipcRenderer.invoke(LibraryChannel.saveNotes, { id, text }),
  setFocus: (id, text) => ipcRenderer.invoke(LibraryChannel.setFocus, { id, text }),
}

contextBridge.exposeInMainWorld('gilLibrary', api)
