// Publishes a self-signed release to Cloudflare R2: checks, builds, signs with the
// "gil Self-Signed" certificate, uploads, and tags the commit. Installed copies of gil
// see the new latest-mac.yml and update themselves. See docs/ARCHITECTURE.md, Publishing.
//
// Needs: the certificate in the login keychain, `npx wrangler login` done once, and
// release.json with the bucket and the public address it is served from.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...options })
const read = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim()
const fail = (message) => {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
const { updateUrl, bucket } = JSON.parse(readFileSync(`${root}release.json`, 'utf8'))
const tag = `v${version}`

if (!/^https:\/\/[^\s]+$/.test(updateUrl)) fail('Set updateUrl in release.json to the R2 bucket’s public address.')
if (read('git', ['status', '--porcelain', '--untracked-files=no'])) {
  fail('Commit your changes first, so the release matches a commit exactly.')
}
if (read('git', ['tag', '--list', tag])) fail(`${tag} already exists. Bump the version in package.json.`)
if (!read('security', ['find-identity', '-v', '-p', 'codesigning']).includes('"gil Self-Signed"')) {
  fail('The "gil Self-Signed" code-signing certificate is not in your keychain.')
}

console.log(`\nReleasing gil ${version} to ${updateUrl}\n`)
// Nothing private in the code that is about to be built and published.
run('node', ['scripts/scan-private.mjs', '--tracked'])
for (const script of ['typecheck', 'lint', 'test', 'build']) run('pnpm', [script])
run('pnpm', ['exec', 'electron-builder', '--mac', '--config', 'electron-builder.self.yml', '--publish', 'never'], {
  env: { ...process.env, GIL_UPDATE_URL: updateUrl },
})

const app = `${root}dist/mac-arm64/gil.app`
run('codesign', ['--verify', '--deep', '--strict', app])
// Nor in what was actually built: the app's code is scanned as it will ship, before any upload.
const unpacked = mkdtempSync(join(tmpdir(), 'gil-release-scan-'))
try {
  run('node', [`${root}node_modules/@electron/asar/bin/asar.js`, 'extract', `${app}/Contents/Resources/app.asar`, join(unpacked, 'app')])
  run('node', ['scripts/scan-private.mjs', join(unpacked, 'app'), `${app}/Contents/Info.plist`, `${root}dist/latest-mac.yml`])
} finally {
  rmSync(unpacked, { recursive: true, force: true })
}
// Everything electron-builder made for this version: the zip and dmg, and their blockmaps.
const files = readdirSync(`${root}dist`).filter((file) => file.startsWith(`gil-${version}-`))
if (!files.some((file) => file.endsWith('.zip'))) fail('electron-builder did not produce the update zip.')

const put = (key, file, contentType) =>
  run('npx', [
    '--yes',
    'wrangler',
    'r2',
    'object',
    'put',
    `${bucket}/${key}`,
    '--file',
    `${root}dist/${file}`,
    '--remote',
    ...(contentType ? ['--content-type', contentType] : []),
  ])

for (const file of files) put(file, file)
// A stable link for first installs and the website.
const dmg = files.find((file) => file.endsWith('.dmg'))
if (dmg) put('gil.dmg', dmg, 'application/x-apple-diskimage')
// Last: this file is what tells installed copies a new version exists.
put('latest-mac.yml', 'latest-mac.yml', 'text/yaml')

// The unpacked build copy would otherwise show up as a second gil in Spotlight and Launchpad.
rmSync(`${root}dist/mac-arm64`, { recursive: true, force: true })

run('git', ['tag', '-a', tag, '-m', `gil ${version}`])
run('git', ['push', 'origin', tag])
console.log(`\n✓ gil ${version} is live. First install: ${updateUrl}/gil.dmg`)
