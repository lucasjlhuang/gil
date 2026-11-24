import { describe, expect, it } from 'vitest'
import { claudeCodeCommand, hasGilServer, mcpLaunch, shellQuote, withGilServer } from './mcpConfig'

const launch = mcpLaunch('/Applications/gil.app/Contents/MacOS/gil', '/Applications/gil.app/Contents/Resources/app.asar')

describe('mcpLaunch', () => {
  it('runs the server script on gil in Node mode', () => {
    expect(launch).toEqual({
      command: '/Applications/gil.app/Contents/MacOS/gil',
      args: ['/Applications/gil.app/Contents/Resources/app.asar/out/main/mcp.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })
})

describe('claudeCodeCommand', () => {
  it('registers for every project and quotes paths with spaces', () => {
    const spaced = mcpLaunch('/Users/a b/gil', '/Users/a b/app')
    expect(claudeCodeCommand(spaced)).toBe(
      "claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 gil -- '/Users/a b/gil' '/Users/a b/app/out/main/mcp.js'",
    )
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })
})

describe('withGilServer', () => {
  it('adds gil and keeps other servers and settings', () => {
    const before = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } })
    const after = JSON.parse(withGilServer(before, launch))
    expect(after.theme).toBe('dark')
    expect(after.mcpServers.other).toEqual({ command: 'x' })
    expect(after.mcpServers.gil.args).toEqual(launch.args)
    expect(hasGilServer(JSON.stringify(after), launch)).toBe(true)
    // Without ELECTRON_RUN_AS_NODE the binary would open the app instead of the server.
    delete after.mcpServers.gil.env
    expect(hasGilServer(JSON.stringify(after), launch)).toBe(false)
  })

  it('starts a new file, and refuses to overwrite one it cannot read', () => {
    expect(JSON.parse(withGilServer(null, launch)).mcpServers.gil.command).toBe(launch.command)
    expect(() => withGilServer('{broken', launch)).toThrow()
    expect(() => withGilServer('[1,2]', launch)).toThrow()
    expect(hasGilServer('{broken', launch)).toBe(false)
  })
})
