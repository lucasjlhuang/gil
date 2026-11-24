import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { claudeCodeCommand, hasGilServer, mcpLaunch, withGilServer } from '../shared/mcpConfig'
import type { McpStatus } from '../shared/channels'
import skill from '../mcp/skill.md?raw'
import { writeFileAtomic } from './storage'

/**
 * Settings' "Use your assets in AI tools": registers gil's MCP server with Claude Desktop (by
 * adding it to that app's config file, keeping everything else), shows the command for Claude
 * Code, and installs a Claude Code skill that tells it to look assets up by name.
 */

const claudeDesktopConfig = () => join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
const skillFile = () => join(homedir(), '.claude', 'skills', 'gil', 'SKILL.md')
const launch = () => mcpLaunch(process.execPath, app.getAppPath())

const exists = (path: string) => stat(path).then(() => true, () => false)

export async function mcpStatus(): Promise<McpStatus> {
  const config = claudeDesktopConfig()
  const text = await readFile(config, 'utf8').catch(() => null)
  const installedSkill = await readFile(skillFile(), 'utf8').catch(() => null)
  return {
    claudeDesktop: hasGilServer(text, launch()) ? 'connected' : (await exists(dirname(config))) ? 'available' : 'missing',
    claudeCodeCommand: claudeCodeCommand(launch()),
    skill:
      installedSkill === null
        ? 'missing'
        : installedSkill === skill
          ? 'installed'
          : isGilSkill(installedSkill)
            ? 'outdated'
            : 'other',
  }
}

export async function connectClaudeDesktop(): Promise<void> {
  const config = claudeDesktopConfig()
  const text = await readFile(config, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  const next = withGilServer(text, launch())
  await mkdir(dirname(config), { recursive: true })
  // Write through a symlink (a config kept in a dotfiles folder) instead of replacing it.
  const target = text === null ? config : await realpath(config)
  await writeFileAtomic(target, next)
}

/** A skill file gil wrote (an older version), as opposed to one the user wrote there. */
const isGilSkill = (text: string) => text.includes(SKILL_MARKER)
const SKILL_MARKER = 'The `gil` MCP server serves them.'

export async function installSkill(): Promise<void> {
  const existing = await readFile(skillFile(), 'utf8').catch(() => null)
  if (existing !== null && existing !== skill && !isGilSkill(existing)) {
    throw new Error(`${skillFile()} was written by someone else, so gil left it alone`)
  }
  await mkdir(dirname(skillFile()), { recursive: true })
  await writeFileAtomic(skillFile(), skill)
}
