/**
 * IPC channel names and the types that cross each boundary. Main validates every incoming
 * payload with the zod schemas in `ipc.ts`. Preload scripts import their channel names from
 * the per-window files directly and only types from here.
 */
import type { Asset, AssetLens } from './asset'
import type { Rect } from './geometry'
import type { Edits } from './edits'
import type { GlossaryTerm } from './glossary'
import type { Spec } from './spec'

export { LibraryChannel } from './libraryChannel'
export { OverlayChannel } from './overlayChannel'
export { RecorderChannel } from './recorderChannel'

/** What an overlay window should be showing. Rectangles are in that window's CSS pixels. */
export type OverlayState =
  | { phase: 'select' }
  /** Dimming is gone and the outline is up; the recorder is starting. */
  | { phase: 'arming'; region: Rect }
  | { phase: 'recording'; region: Rect; startedAt: number; maxDurationMs: number }

/**
 * What a selection will record, for the overlay to show. Rectangles are in the overlay
 * window's CSS pixels. `region` is the selection clipped to what will actually be recorded.
 */
export type OverlayTarget =
  | { kind: 'window'; app: string; title: string | null; frame: Rect; region: Rect }
  | { kind: 'display'; region: Rect }

export interface RecordRequest {
  /** Selection in the overlay window's CSS pixels. */
  rect: Rect
  context: string
  /** What to look for; see AssetLens. */
  lens: AssetLens
}

export interface OverlayApi {
  onState(listener: (state: OverlayState) => void): () => void
  /** Null when the selection is too small to record. */
  resolveTarget(rect: Rect): Promise<OverlayTarget | null>
  record(request: RecordRequest): void
  /** Saves a still of the selection instead of recording it. */
  screenshot(request: RecordRequest): void
  cancel(): void
  /** The arming state has been painted, so the dimming is off screen. */
  painted(): void
  /** Ask to become the key window, so the context field can take typing. */
  focus(): void
  /** While recording the overlay ignores the mouse except over the timer. */
  setInteractive(interactive: boolean): void
  stop(): void
}

export interface RecorderStartOptions {
  width: number
  height: number
  frameRate: number
}

export interface RecorderStarted {
  /** Actual size of the recorded frames, in physical pixels. */
  width: number
  height: number
  mimeType: string
}

export interface RecorderStopped {
  durationMs: number
}

export interface RecorderApi {
  onStop(listener: () => void): () => void
  started(info: RecorderStarted): void
  chunk(data: Uint8Array): void
  stopped(info: RecorderStopped): void
  failed(message: string): void
}

export type ScreenPermission = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'

export interface LibraryItem {
  asset: Asset
  posterUrl: string | null
  clipUrl: string | null
  /** Served from the sandboxed recreation scheme; only ever loaded in a sandboxed iframe. */
  recreationUrl: string | null
}

export type ApiKeyResult = { ok: true } | { ok: false; error: string }
export interface AssetDetails {
  spec: Spec | null
  specMarkdown: string | null
  /** Claude's recreation and the user's edits; source text only, never rendered here. */
  base: string | null
  edits: Edits | null
  /** The recreation as saved (base plus edits). */
  html: string | null
  /** Ready-to-paste instruction for AI tools. */
  prompt: string
  /** The user's notes on the asset (a note's text); '' when there are none. */
  notes: string
  /** For a design system, the ids of the assets it bundles; [] otherwise. */
  members: string[]
}

/** Settings' "Use your assets in AI tools" section. */
export interface McpStatus {
  /** connected: gil is in Claude Desktop's config; available: Claude Desktop is set up but gil is not; missing: no Claude Desktop. */
  claudeDesktop: 'connected' | 'available' | 'missing'
  /** The command that registers gil with Claude Code. */
  claudeCodeCommand: string
  /** other: a skill file gil did not write is in the way. */
  skill: 'installed' | 'outdated' | 'missing' | 'other'
}

export interface AppInfo {
  version: string
  commit: string
  /** For display: `0.2.0 (af5f4f2)`. */
  label: string
}

export type ActionResult = { ok: true } | { ok: false; error: string }

export interface LibraryListing {
  root: string
  items: LibraryItem[]
  skipped: { folder: string; reason: string }[]
}

export interface LibraryApi {
  list(): Promise<LibraryListing>
  /** Which build of gil this is. */
  appInfo(): Promise<AppInfo>
  onChanged(listener: () => void): () => void
  getPermission(): Promise<ScreenPermission>
  /** Makes macOS show its Screen Recording prompt and list the app in System Settings. */
  requestPermission(): Promise<ScreenPermission>
  openPermissionSettings(): Promise<void>
  relaunch(): Promise<void>
  /** Starts a capture. `force` skips the permission check. */
  capture(force: boolean): Promise<void>
  /** Queues an asset for analysis (again). */
  analyze(id: string): Promise<void>
  /** Queues a refinement of the current recreation with the user's instruction. */
  refine(id: string, instruction: string): Promise<void>
  /** Everything the review screen shows beyond asset.json. */
  details(name: string): Promise<AssetDetails>
  /** Saves edits to the recreation; no edits reverts to what Claude wrote. */
  saveEdits(id: string, edits: Edits): Promise<ActionResult>
  copy(text: string): Promise<void>
  /** Renames (folder and asset.json together) and retitles. */
  rename(id: string, name: string, title: string): Promise<ActionResult>
  setTags(id: string, tags: string[]): Promise<ActionResult>
  /** Moves the asset to the Trash. */
  trash(id: string): Promise<ActionResult>
  hasApiKey(): Promise<boolean>
  /** Checks the key with Anthropic, then stores it encrypted. It is never sent back. */
  setApiKey(key: string): Promise<ApiKeyResult>
  clearApiKey(): Promise<void>
  mcpStatus(): Promise<McpStatus>
  /** The Chrome extension's bridge; null before it starts. */
  bridgeStatus(): Promise<BridgeStatus | null>
  /** Shows the built extension's folder in Finder, to load it unpacked in Chrome. */
  revealExtension(): Promise<void>
  /** The user's glossary of design terms (library/glossary.json). */
  getGlossary(): Promise<GlossaryTerm[]>
  saveGlossary(terms: GlossaryTerm[]): Promise<ActionResult>
  /** Adds dropped image files as assets. Files that are not images are reported. */
  importFiles(files: File[]): Promise<ActionResult>
  /** Adds the image on the clipboard as an asset. */
  importClipboard(): Promise<ActionResult>
  /** Asks for image files to add. */
  importDialog(): Promise<ActionResult>
  createNote(title: string, text: string): Promise<ActionResult>
  createDesignSystem(title: string, memberIds: string[]): Promise<ActionResult>
  setMembers(id: string, memberIds: string[]): Promise<ActionResult>
  /**
   * Another lens on a saved asset: a new asset from the same capture. Colour is measured on the
   * Mac at once; the others are analyzed (with an API key).
   */
  runLens(id: string, lens: Exclude<AssetLens, 'auto'>): Promise<ActionResult>
  saveNotes(id: string, text: string): Promise<ActionResult>
  /**
   * Sets what the user wants recreated from a capture ("only the loading animation"), the same
   * note the capture overlay offers. It takes effect the next time the asset is analyzed.
   */
  setFocus(id: string, text: string): Promise<ActionResult>
  /** Copies the asset's folder to a folder the user picks; `path` is where it went. */
  exportAsset(id: string): Promise<ActionResult & { path?: string }>
  /** Adds gil's MCP server to Claude Desktop's config. */
  connectClaudeDesktop(): Promise<ActionResult>
  /** Installs (or updates) the gil skill for Claude Code. */
  installSkill(): Promise<ActionResult>
}

/** The Chrome extension's capture bridge (not wired up yet; see docs/ROADMAP.md). */
export type BridgeStatus = {
  port: number
  pairingCode: string
  /** Where the built extension is, to load it unpacked in Chrome. */
  extensionFolder: string
} & (
  | { state: 'starting' | 'listening' }
  | { state: 'failed'; error: string }
)


