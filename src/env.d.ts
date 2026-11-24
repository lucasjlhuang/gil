import type {
  LibraryApi,
  OverlayApi,
  RecorderApi,
  RecorderStartOptions,
} from './shared/channels'

declare global {
  /** Set at build time (electron.vite.config.ts); main process only. */
  const __GIL_COMMIT__: string
  /** package.json's version, set at build time; main process and MCP server. */
  const __GIL_VERSION__: string

  interface Window {
    gilOverlay: OverlayApi
    gilRecorder: RecorderApi
    gilLibrary: LibraryApi
    /** Called by main through executeJavaScript with a user gesture; see src/recorder/main.ts. */
    __gilStartRecording?: (options: RecorderStartOptions) => void
  }
}
