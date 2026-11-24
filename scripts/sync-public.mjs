// Copies the code into the public repository, without the private working notes, and commits
// it there locally. Nothing is pushed: pushing the public repository stays a deliberate step.
//
//   node scripts/sync-public.mjs <public repository folder> "<commit message>"
//
// What is left out is listed in PRIVATE below. The copy must pass scripts/scan-private.mjs
// (with the owner's personal patterns) before it is committed.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const [target, message] = process.argv.slice(2)
if (!target || !message) {
  console.error('Usage: node scripts/sync-public.mjs <public repository folder> "<commit message>"')
  process.exit(2)
}
if (!existsSync(join(target, '.git'))) {
  console.error(`${target} is not a git repository; create the public repository there first.`)
  process.exit(1)
}

/** Files that are the owner's working notes with Claude, never public. */
const PRIVATE = ['HANDOFF.md', 'CLAUDE.md', 'KICKOFF_PROMPT.md', 'LAUNCH.md', 'AGENTS.md']

const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
const keep = tracked.filter((path) => !PRIVATE.includes(path))

// The public copy mirrors the private one: files gone here go there too.
for (const entry of readdirSync(target)) {
  if (entry === '.git' || entry === '.private-patterns' || entry === 'node_modules') continue
  rmSync(join(target, entry), { recursive: true, force: true })
}
for (const path of keep) {
  mkdirSync(dirname(join(target, path)), { recursive: true })
  cpSync(join(root, path), join(target, path))
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: target, stdio: 'inherit' })
run('node', ['scripts/scan-private.mjs', '.'])
run('git', ['add', '-A'])
const changed = execFileSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' }).trim()
if (!changed) {
  console.log('The public copy is already up to date.')
} else {
  run('git', ['commit', '-q', '-m', message])
  console.log(`Committed in ${target}. Review it, then push it yourself.`)
}
