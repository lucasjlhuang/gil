import { z } from 'zod'

/**
 * How AI tools start gil's MCP server, and the config entries that register it. Pure; main
 * reads and writes the files (main/mcpConnect.ts).
 *
 * The server runs on gil's own binary in Node mode, so it needs no Node install and moves with
 * the app: `<gil binary> <app>/out/main/mcp.js` with ELECTRON_RUN_AS_NODE=1.
 */

export const MCP_SERVER_NAME = 'gil'

export interface McpLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

export function mcpLaunch(execPath: string, appPath: string): McpLaunch {
  return {
    command: execPath,
    args: [`${appPath.replace(/\/$/, '')}/out/main/mcp.js`],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

/** Quotes a word for a POSIX shell. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** The command that registers gil with Claude Code for every project (user scope). */
export function claudeCodeCommand(launch: McpLaunch): string {
  const env = Object.entries(launch.env).flatMap(([key, value]) => ['--env', `${key}=${value}`])
  return ['claude', 'mcp', 'add', '--scope', 'user', ...env, MCP_SERVER_NAME, '--', launch.command, ...launch.args]
    .map(shellQuote)
    .join(' ')
}

const configSchema = z.looseObject({ mcpServers: z.record(z.string(), z.unknown()).optional() })

/**
 * A config file (Claude Desktop's `claude_desktop_config.json` shape) with gil's server added
 * or updated, keeping everything else. `text` null means there is no file yet. Throws if the
 * file is not a JSON object, so a broken file is never overwritten.
 */
export function withGilServer(text: string | null, launch: McpLaunch): string {
  const parsed = configSchema.safeParse(text === null || !text.trim() ? {} : JSON.parse(text))
  if (!parsed.success) throw new Error('The config file is not in the expected format')
  const config = parsed.data
  const servers = { ...(config.mcpServers ?? {}), [MCP_SERVER_NAME]: { command: launch.command, args: launch.args, env: launch.env } }
  return `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`
}

/** Whether a config file already starts this exact gil server. */
export function hasGilServer(text: string | null, launch: McpLaunch): boolean {
  if (!text) return false
  try {
    const entry = configSchema.parse(JSON.parse(text)).mcpServers?.[MCP_SERVER_NAME] as Partial<McpLaunch> | undefined
    return (
      entry?.command === launch.command &&
      JSON.stringify(entry.args) === JSON.stringify(launch.args) &&
      Object.entries(launch.env).every(([key, value]) => entry.env?.[key] === value)
    )
  } catch {
    return false
  }
}
