// Scans files for secrets and the developer's personal details, so neither reaches a public
// commit or a published build. Used by the pre-commit hook (.githooks/pre-commit), by
// `pnpm release` before anything is uploaded, and by CI on every push.
//
//   node scripts/scan-private.mjs --staged        the files about to be committed
//   node scripts/scan-private.mjs --tracked       every tracked file
//   node scripts/scan-private.mjs <file or dir>…  anything else, such as an extracted app.asar
//
// Generic patterns (keys, tokens, private keys, home-folder paths) are built in. Personal ones
// (your email, your name, your Mac's user name) are read from a file that is never committed:
// `.private-patterns` at the repository root (gitignored) or ~/.config/gil/private-patterns,
// one regular expression per line, so the scan itself never publishes them.
// Exits 1 and lists every match when anything is found.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname

const generic = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token or webhook', /xox[abprs]-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\/[A-Za-z0-9/]+/],
  ['Discord webhook', /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['Cloudflare API token assignment', /CLOUDFLARE_API_TOKEN\s*[:=]\s*['"]?[A-Za-z0-9_-]{30,}/],
  ['A home folder path', /\/Users\/(?!Shared\b|<name>|you\b|me\b|example\b)[a-z][a-z0-9._-]*\//],
  ['A password in config', /\b(?:password|passwd|secret)\s*[:=]\s*['"][^'"\s]{8,}['"]/i],
]

function personal() {
  const files = [join(root, '.private-patterns'), join(homedir(), '.config', 'gil', 'private-patterns')]
  const patterns = []
  for (const file of files) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const text = line.trim()
      if (!text || text.startsWith('#')) continue
      patterns.push([`a personal detail (${file.startsWith(root) ? '.private-patterns' : '~/.config/gil/private-patterns'})`, new RegExp(text, 'i')])
    }
  }
  return patterns
}

/** Files a scan may skip: they are generated, binary, or this scanner's own patterns. */
const skip = (path) =>
  /(^|\/)(node_modules|\.git|out|dist)\//.test(path) ||
  /\.(png|jpe?g|gif|webp|icns|ico|mp4|mov|webm|woff2?|ttf|otf|zip|dmg|pdf|node|dylib|so|wasm|ttc)$/i.test(path) ||
  path.endsWith('scripts/scan-private.mjs') ||
  path.endsWith('.private-patterns') ||
  // The owner's working notes with Claude: kept in the private repository, never copied to the
  // public one (scripts/sync-public.mjs) and never built into the app.
  /^(HANDOFF|CLAUDE|KICKOFF_PROMPT|LAUNCH|AGENTS)\.md$/.test(path) ||
  path.endsWith('pnpm-lock.yaml')

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    // Git's own records and installed packages are not part of what is published.
    if (entry.isDirectory() && (entry.name === '.git' || entry.name === 'node_modules') && !path.includes('app.asar')) continue
    if (entry.isDirectory()) walk(path, out)
    else out.push(path)
  }
}

function filesToScan(args) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).map((p) => join(root, p))
  if (args[0] === '--staged') return git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
  if (args[0] === '--tracked') return git('ls-files')
  const out = []
  for (const arg of args) {
    if (statSync(arg).isDirectory()) walk(arg, out)
    else out.push(arg)
  }
  return out
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('Usage: node scripts/scan-private.mjs --staged | --tracked | <file or dir>…')
  process.exit(2)
}
// Inside a build (an extracted app.asar), third-party packages are scanned only for secrets:
// their authors' emails and the paths in their docs are theirs, not yours.
const inBuild = !args[0].startsWith('--')
const patterns = [...generic, ...personal()]
const findings = []
for (const file of filesToScan(args)) {
  const shown = file.startsWith(root) ? relative(root, file) : file
  if (!inBuild && skip(shown)) continue
  if (shown.endsWith('.private-patterns')) continue
  if (inBuild && /\.(png|jpe?g|gif|webp|icns|ico|mp4|woff2?|ttf|node|dylib|wasm)$/i.test(file)) continue
  let text
  try {
    if (statSync(file).size > 8 * 1024 * 1024) continue
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const thirdParty = inBuild && /\/node_modules\//.test(file)
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    for (const [what, pattern] of patterns) {
      if (thirdParty && (what === 'A home folder path' || what.startsWith('a personal detail'))) continue
      const match = pattern.exec(line)
      if (match) findings.push(`${shown}:${i + 1}: ${what}: ${match[0].slice(0, 12)}…`)
    }
  })
}
if (personal().length === 0 && !process.env.CI) {
  console.warn('scan-private: no personal patterns set up; only secrets and home-folder paths were checked. Add .private-patterns (gitignored) to check your own details too.')
}
if (findings.length > 0) {
  console.error(`scan-private: ${findings.length} thing${findings.length === 1 ? '' : 's'} that must not be published:`)
  for (const finding of findings.slice(0, 200)) console.error(`  ${finding}`)
  process.exit(1)
}
console.log('scan-private: nothing private found.')
