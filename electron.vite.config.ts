import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * Injects the renderer Content-Security-Policy. Production builds get the strict policy;
 * the dev server additionally needs inline scripts (React refresh preamble) and a websocket.
 */
function rendererCsp(): Plugin {
  let dev = false
  return {
    name: 'gil-renderer-csp',
    configResolved(config) {
      dev = config.command === 'serve'
    },
    transformIndexHtml(html) {
      const script = dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'"
      const connect = dev ? "connect-src 'self' ws:" : "connect-src 'none'"
      const csp = [
        "default-src 'none'",
        script,
        "style-src 'self' 'unsafe-inline'",
        'img-src gil-asset: data:',
        'media-src gil-asset: mediastream:',
        // Recreations, only in sandboxed iframes (see src/shared/recreation.ts).
        'frame-src gil-recreation:',
        connect,
      ].join('; ')
      return html.replace(
        '<!--csp-->',
        `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      )
    },
  }
}

/** The commit a build comes from, `-dirty` if tracked files had uncommitted changes. */
function buildCommit(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain --untracked-files=no', { encoding: 'utf8' }).trim()
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  main: {
    define: {
      __GIL_COMMIT__: JSON.stringify(buildCommit()),
      __GIL_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version),
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // The benchmark runner (`pnpm bench`), a separate entry with no windows or tray.
          bench: resolve(__dirname, 'src/main/bench.ts'),
          // The MCP server (`src/mcp`), run by AI tools on gil's binary in Node mode; no Electron APIs.
          mcp: resolve(__dirname, 'src/mcp/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads can only require 'electron', so each must build to one file with
      // no shared chunk. They share no runtime modules (see src/shared/*Channel.ts);
      // scripts/check-build.mjs fails the build if that stops being true.
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          recorder: resolve(__dirname, 'src/preload/recorder.ts'),
          library: resolve(__dirname, 'src/preload/library.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react(), rendererCsp()],
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/overlay/index.html'),
          recorder: resolve(__dirname, 'src/recorder/index.html'),
          library: resolve(__dirname, 'src/library/index.html'),
        },
      },
    },
  },
})
