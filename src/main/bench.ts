import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { benchRunSchema, formatRun, gateText, type BenchResult, type BenchRun } from '../shared/bench'
import { assetLensSchema, formatTimestamp } from '../shared/asset'
import { analyzeAsset, loadFrames, measureClip, pickFrames, readMotion, saveFrames, traceFrames } from './analysis/analyze'
import { describeTraces } from '../shared/trace'
import { describeUseCheck } from '../shared/useCheck'
import { describeFittedTexts } from '../shared/fontEmbed'
import { fitTexts } from './analysis/textFonts'
import { makeColorSystem } from './colorLens'
import { grabPage, peekPage } from './grabPage'
import { boxesOfAsset, makeSpacingSystem } from './spacingLens'
import { checkUse } from './useCheck'
import { checkRecreation, patchNumbers } from './analysis/check'
import { renderFrames, renderRealTime } from './analysis/render'
import { frameScale } from '../shared/ffmpegArgs'
import { rankFonts } from './fontIdentify'
import { scoreAsset } from './analysis/score'
import { loadApiKey } from './apiKey'
import { libraryRoot } from './library'
import { ASSET_FILE, CAPTURE_DIR, CLIP_FILE, POSTER_FILE, readAsset, RECREATION_DIR, RECREATION_FILE, writeFileAtomic } from './storage'

/**
 * The benchmark runner, a separate entry point that runs without gil's windows or menu bar
 * icon (`pnpm bench …`, see docs/ARCHITECTURE.md):
 *
 * - `add <name>…` copies captures from the library into the benchmark, frozen from then on.
 * - `run` re-analyzes every benchmark capture in a throwaway library, scores each recreation
 *   against its capture, and reports score, cost and time next to the previous run.
 * - `score <name>…` scores assets already analyzed in the library and saves the frame pairs it
 *   compared, to see where a low score comes from. No API calls.
 * - `list` shows the benchmark captures.
 *
 * It keeps its own settings folder, `gil-benchmark`, beside gil's, so it can run while gil is
 * open; it reads gil's saved API key from there, or ANTHROPIC_API_KEY if that is set.
 */

app.setName('gil')
const gilSettings = app.getPath('userData')
const benchDir = join(app.getPath('appData'), 'gil-benchmark')
app.setPath('userData', benchDir)
const capturesDir = join(benchDir, 'captures')
const runsDir = join(benchDir, 'runs')

function args(): string[] {
  const script = process.argv.findIndex((arg) => /bench\.(js|mjs|cjs)$/.test(arg))
  return process.argv.slice(script + 1)
}

/** A library folder to work in instead of the benchmark's captures, for trying things on copies of real assets. */
const testLibrary = (): string | null => process.env.GIL_BENCH_LIBRARY || null

async function listCaptures(): Promise<string[]> {
  const entries = await readdir(capturesDir, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort()
}

/** Copies only what analysis starts from: asset.json and the capture itself. */
async function add(names: string[]): Promise<void> {
  if (names.length === 0) throw new Error('Name the library assets to add, for example: pnpm bench add hover-card')
  for (const name of names) {
    const asset = await readAsset(libraryRoot(), name)
    if (!asset.capture) throw new Error(`"${name}" is not a capture`)
    const target = join(capturesDir, name)
    await rm(target, { recursive: true, force: true })
    await mkdir(join(target, CAPTURE_DIR), { recursive: true })
    await copyFile(join(libraryRoot(), name, ASSET_FILE), join(target, ASSET_FILE))
    const files = asset.capture.mode === 'screenshot' ? [POSTER_FILE] : [CLIP_FILE, POSTER_FILE]
    for (const file of files) await copyFile(join(libraryRoot(), name, CAPTURE_DIR, file), join(target, CAPTURE_DIR, file))
    console.log(`Added ${name}`)
  }
}

async function latestRun(): Promise<BenchRun | null> {
  const runs = (await readdir(runsDir).catch(() => [] as string[])).sort().reverse()
  for (const run of runs) {
    try {
      const report = benchRunSchema.parse(JSON.parse(await readFile(join(runsDir, run, 'report.json'), 'utf8')))
      // A run where everything failed (no credit, no network) is nothing to compare with.
      if (report.results.some((result) => result.score !== null)) return report
    } catch {
      continue
    }
  }
  return null
}

async function runOne(library: string, name: string, apiKey: string): Promise<{ result: BenchResult; html: string | null; folder: string | null }> {
  const started = performance.now()
  const seconds = () => (performance.now() - started) / 1000
  try {
    const analyzed = await analyzeAsset(library, name, apiKey)
    const elapsed = seconds()
    console.log(`  ${analyzed.asset.analysis?.rounds ?? '?'} model round(s) after planning; the local check ${analyzed.differences.length ? `still finds:\n${analyzed.differences.map((line) => `    - ${line}`).join('\n')}` : 'passes'}`)
    const model = analyzed.asset.analysis?.model ?? null
    const scored = await scoreAsset(library, analyzed.asset.name)
    return {
      result: {
        name,
        score: scored.score,
        frames: scored.frames,
        gate: {
          pass: scored.gate.pass,
          offsetPx: scored.gate.offsetPx,
          timingWorstMs: scored.gate.timing?.worstMs ?? null,
          missing: scored.gate.timing?.missing ?? 0,
          extra: scored.gate.timing?.extra ?? 0,
        },
        inputTokens: analyzed.usage.inputTokens,
        outputTokens: analyzed.usage.outputTokens,
        costUsd: analyzed.usage.costUsd,
        seconds: elapsed,
        model,
        rounds: analyzed.asset.analysis?.rounds ?? null,
        error: null,
      },
      html: await readFile(join(library, analyzed.asset.name, RECREATION_DIR, RECREATION_FILE), 'utf8'),
      folder: join(library, analyzed.asset.name),
    }
  } catch (error) {
    return {
      result: {
        name,
        score: null,
        frames: [],
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        seconds: seconds(),
        model: null,
        rounds: null,
        error: error instanceof Error ? error.message : String(error),
      },
      html: null,
      folder: null,
    }
  }
}

async function run(only: string[] = []): Promise<void> {
  const all = await listCaptures()
  // With names, only those captures are analyzed (and paid for).
  const names = only.length ? all.filter((name) => only.includes(name)) : all
  if (only.length && names.length !== only.length) throw new Error(`Not in the benchmark: ${only.filter((name) => !all.includes(name)).join(', ')}`)
  if (names.length === 0) throw new Error('The benchmark is empty. Add captures first: pnpm bench add <name>')
  const apiKey = process.env.ANTHROPIC_API_KEY || (await loadApiKey(gilSettings))
  if (!apiKey) throw new Error('No API key: save one in gil\'s Settings, or set ANTHROPIC_API_KEY')

  const previous = await latestRun()
  const startedAt = formatTimestamp(new Date())
  const report: BenchRun = { startedAt, commit: __GIL_COMMIT__, results: [] }
  const runDir = join(runsDir, startedAt.replace(/[:.]/g, '-'))
  await mkdir(runDir, { recursive: true })
  const library = await mkdtemp(join(tmpdir(), 'gil-bench-'))
  try {
    for (const name of names) {
      console.log(`Analyzing ${name}…`)
      await cp(join(capturesDir, name), join(library, name), { recursive: true })
      const { result, html, folder } = await runOne(library, name, apiKey)
      // The recipe, spec and measurements of the run, to read afterwards.
      for (const file of ['recipe.md', 'spec.md', 'spec.json', join(CAPTURE_DIR, 'motion.json'), join(CAPTURE_DIR, 'focus.json')]) {
        if (folder) await copyFile(join(folder, file), join(runDir, `${name}.${file.split('/').pop()}`)).catch(() => undefined)
      }
      report.results.push(result)
      // Kept so a run's recreations can be compared by eye later.
      if (html !== null) await writeFileAtomic(join(runDir, `${name}.html`), html)
      await writeFileAtomic(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    }
  } finally {
    await rm(library, { recursive: true, force: true })
  }
  console.log(`\n${formatRun(report, previous)}\n\nSaved in ${runDir}`)
}

async function score(names: string[]): Promise<void> {
  if (names.length === 0) throw new Error('Name the library assets to score, for example: pnpm bench score hover-card')
  for (const name of names) {
    try {
      const pairs = join(benchDir, 'scored', name)
      await rm(pairs, { recursive: true, force: true })
      const result = await scoreAsset(libraryRoot(), name, pairs)
      console.log(`${name}: ${result.score}  (frames: ${result.frames.map((frame) => `${frame.timestampMs}ms ${frame.score}`).join(', ')})`)
      const { timing } = result.gate
      console.log(
        `  gate: ${gateText({ pass: result.gate.pass, offsetPx: result.gate.offsetPx, timingWorstMs: timing?.worstMs ?? null, missing: timing?.missing ?? 0, extra: timing?.extra ?? 0 })}`,
      )
      for (const step of timing?.steps ?? []) {
        console.log(
          `  movement ${step.startMs}–${step.endMs} ms: ${step.startOffMs === null ? 'missing in the recreation' : `start ${step.startOffMs} ms, end ${step.endOffMs} ms off`}`,
        )
      }
      console.log(`  frame pairs in ${pairs}`)
    } catch (error) {
      console.log(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = args()
  switch (command) {
    case 'add':
      return add(rest)
    case 'run':
      return run(rest)
    case 'score':
      return score(rest)
    case 'fonts': {
      // Font matching without a model call: pnpm bench fonts <asset> "<text>" <weight> <family>,<family>…
      const [name, text, weight, families, box] = rest
      if (!name || !text || !families) throw new Error('Usage: pnpm bench fonts <asset> "<text>" <weight> <family>,<family>… [x,y,width,height as fractions]')
      const asset = await readAsset(libraryRoot(), name)
      if (!asset.capture) throw new Error(`${name} has no capture`)
      const { ranked, unknown } = await rankFonts(
        join(libraryRoot(), name, CAPTURE_DIR, POSTER_FILE),
        asset.capture.height,
        text,
        Number(weight) || 400,
        false,
        families.split(','),
        box ? (([x, y, width, height]) => ({ x: x ?? 0, y: y ?? 0, width: width ?? 1, height: height ?? 1 }))(box.split(',').map(Number)) : null,
      )
      for (const font of ranked) console.log(`${font.score}%  ${font.entry.family} ${font.weight}`)
      if (unknown.length) console.log(`Not in the catalogue: ${unknown.join(', ')}`)
      return
    }
    case 'inspect': {
      // A saved run's recreation against its benchmark capture: frame pairs, score and the local
      // check. No API calls. pnpm bench inspect <capture> <html file> <folder for the pairs>
      const [name, htmlPath, out] = rest
      if (!name || !htmlPath || !out) throw new Error('Usage: pnpm bench inspect <capture> <html file> <folder>')
      const library = await mkdtemp(join(tmpdir(), 'gil-inspect-'))
      try {
        await cp(join(capturesDir, name), join(library, name), { recursive: true })
        const asset = await readAsset(library, name)
        if (!asset.capture) throw new Error(`${name} has no capture`)
        const captureDir = join(library, name, CAPTURE_DIR)
        const motion = await measureClip(join(captureDir, CLIP_FILE))
        const { frames } = await pickFrames(join(captureDir, CLIP_FILE), asset.capture, motion)
        await saveFrames(captureDir, frames)
        await mkdir(join(library, name, RECREATION_DIR), { recursive: true })
        const html = await readFile(htmlPath, 'utf8')
        await writeFileAtomic(join(library, name, RECREATION_DIR, RECREATION_FILE), html)
        const scored = await scoreAsset(library, name, out)
        console.log(`score ${scored.score}; frames: ${scored.frames.map((f) => `${f.timestampMs}ms ${f.score} (${f.offsetPx}px)`).join(', ')}`)
        const size = { width: asset.capture.width, height: asset.capture.height, scale: frameScale(asset.capture.width, asset.capture.height), durationMs: asset.capture.durationMs }
        const check = await checkRecreation(html, size, frames, motion)
        console.log(`local check: ${check.pass ? 'passes' : 'fails'}; resting frames ${check.frames.map((f) => `${f.timestampMs}ms off ${f.offsetPx}px regions ${f.regions.length} shape ${f.shape}`).join(', ')}`)
        console.log(`capture movements: ${motion?.segments.map((x) => `${x.startMs}-${x.endMs}`).join(' ')}; recreation movements: ${check.recreationMotion?.segments.map((x) => `${x.startMs}-${x.endMs}`).join(' ')}`)
        for (const problem of check.problems) console.log(`  - ${problem}`)
      } finally {
        await rm(library, { recursive: true, force: true })
      }
      return
    }
    case 'trace': {
      // Traces a benchmark capture's frames and writes them as SVGs to look at. No API calls.
      const [name, out] = rest
      if (!name || !out) throw new Error('Usage: pnpm bench trace <capture> <folder>')
      const asset = await readAsset(capturesDir, name)
      if (!asset.capture) throw new Error(`${name} has no capture`)
      const clip = join(capturesDir, name, CAPTURE_DIR, CLIP_FILE)
      const motion = asset.capture.mode === 'recording' ? await measureClip(clip) : null
      const { frames } = await pickFrames(clip, asset.capture, motion)
      const traced = traceFrames(frames, motion, asset.capture)
      await mkdir(out, { recursive: true })
      for (const frame of traced) {
        const paths = frame.layers.map((layer) => `<path fill="${layer.color}" fill-rule="evenodd" d="${layer.d}"/>`).join('')
        await writeFileAtomic(join(out, `${frame.timestampMs}-${frame.state}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${asset.capture.width} ${asset.capture.height}" width="${asset.capture.width * 4}" height="${asset.capture.height * 4}"><rect width="100%" height="100%" fill="#fff"/>${paths}</svg>`)
        console.log(`${frame.timestampMs} ms ${frame.state}: ${frame.layers.map((layer) => `${layer.color} ${layer.points} points`).join(', ')}`)
      }
      console.log(`${traced.length} frames traced; prompt text ${describeTraces(traced).length} characters`)
      return
    }
    case 'shots': {
      // Renders any recreation file at given moments into PNGs, to look at before showing it.
      // pnpm bench shots <html file> <width> <height> <folder> <ms> [<ms>…]. No API calls.
      const [htmlPath, width, height, out, ...times] = rest
      if (!htmlPath || !out || times.length === 0) throw new Error('Usage: pnpm bench shots <html file> <width> <height> <folder> <ms>…')
      // Times are ms; "r1200" calls replay() at 1200 ms; "real" as the first time plays in real time.
      const real = times[0] === 'real'
      const stamps = times.filter((time) => /^\d+$/.test(time)).map(Number)
      const replayAt = times.filter((time) => /^r\d+$/.test(time)).map((time) => Number(time.slice(1)))
      const source = await readFile(htmlPath, 'utf8')
      const images = real
        ? await renderRealTime(source, { width: Number(width), height: Number(height), scale: 3, timestamps: stamps, replayAt })
        : await renderFrames(source, { width: Number(width), height: Number(height), scale: 3, timestamps: stamps })
      times.splice(0, times.length, ...stamps.map(String))
      await mkdir(out, { recursive: true })
      for (const [i, image] of images.entries()) await writeFileAtomic(join(out, `${times[i]}.png`), image.toPNG())
      console.log(`wrote ${images.length} frames to ${out}`)
      return
    }
    case 'check': {
      // The local check and number patches on library assets as they are. No API calls.
      for (const name of rest) {
        const asset = await readAsset(libraryRoot(), name)
        if (!asset.capture) throw new Error(`${name} has no capture`)
        const dir = join(libraryRoot(), name)
        const html = await readFile(join(dir, RECREATION_DIR, RECREATION_FILE), 'utf8')
        const frames = await loadFrames(join(dir, CAPTURE_DIR, 'frames'))
        const size = { width: asset.capture.width, height: asset.capture.height, scale: frameScale(asset.capture.width, asset.capture.height), durationMs: asset.capture.durationMs }
        const motion = asset.capture.isStill ? null : ((await readMotion(join(dir, CAPTURE_DIR))) ?? (await measureClip(join(dir, CAPTURE_DIR, CLIP_FILE))))
        const started = performance.now()
        const check = await checkRecreation(html, size, frames, motion)
        const patched = await patchNumbers(html, check, size, frames, motion)
        console.log(`${name}: ${check.pass ? 'passes' : 'fails'} (${Math.round(performance.now() - started)} ms to check and patch)`)
        for (const problem of check.problems) console.log(`  - ${problem}`)
        console.log(patched.patched.length ? `  patched without AI: ${patched.patched.join('; ')} → ${patched.check.pass ? 'passes' : `${patched.check.problems.length} problems left`}` : '  nothing to patch by numbers')
      }
      return
    }
    case 'use': {
      // Checks a draft made for other content against a benchmark capture's motion. No API calls.
      // pnpm bench use <capture> <html file> [width height]. GIL_BENCH_LIBRARY=<folder> reads the asset from that library instead.
      const [name, htmlPath, width, height] = rest
      if (!name || !htmlPath) throw new Error('Usage: pnpm bench use <capture> <html file> [width height]')
      const from = testLibrary() ?? capturesDir
      const asset = await readAsset(from, name)
      const result = await checkUse(from, asset, await readFile(htmlPath, 'utf8'), Number(width) || undefined, Number(height) || undefined, process.env.GIL_BACKDROP === 'x' || process.env.GIL_BACKDROP === 'y' ? process.env.GIL_BACKDROP : undefined)
      console.log(describeUseCheck(result.check, result.original, result.draft, 2, result.images.length, result.styles))
      // GIL_PICTURES=<folder> saves the pictures an AI tool would be shown.
      if (process.env.GIL_PICTURES) {
        await mkdir(process.env.GIL_PICTURES, { recursive: true })
        for (const image of result.images) {
          if (image.original) {
            await writeFileAtomic(join(process.env.GIL_PICTURES, `${image.atMs}-original.png`), image.original)
            console.log(`picture of the original at ${image.atMs} ms: ${join(process.env.GIL_PICTURES, `${image.atMs}-original.png`)}`)
          }
          await writeFileAtomic(join(process.env.GIL_PICTURES, `${image.atMs}.png`), image.png)
          console.log(`picture of your draft at ${image.atMs} ms: ${join(process.env.GIL_PICTURES, `${image.atMs}.png`)}`)
        }
      }
      if (process.env.GIL_DEBUG) for (const [label, profile] of [['original', result.original], ['draft', result.draft]] as const) if (profile) console.log(label, profile.contrast.toFixed(2), profile.activity.map((v) => v.toFixed(1)).join(' '))
      return
    }
    case 'textfit': {
      // Matches and sizes real fonts for texts in a benchmark capture and renders them over a
      // resting frame (text in red over the capture), to look at. No API calls.
      // pnpm bench textfit <capture> <folder> "<text>|x|y|width|height|weight|Family,Family…" …
      const [name, out, ...specs] = rest
      if (!name || !out || specs.length === 0) throw new Error('Usage: pnpm bench textfit <capture> <folder> "<text>|x|y|width|height|weight|Family,Family" …')
      const asset = await readAsset(capturesDir, name)
      if (!asset.capture) throw new Error(`${name} has no capture`)
      const clip = join(capturesDir, name, CAPTURE_DIR, CLIP_FILE)
      const motion = asset.capture.mode === 'recording' ? await measureClip(clip) : null
      const { frames } = await pickFrames(clip, asset.capture, motion)
      const frame = frames[0]
      if (!frame) throw new Error('No frames')
      const texts = specs.map((spec) => {
        const [text = '', x, y, width, height, weight, families = ''] = spec.split('|')
        return { text, x: Number(x), y: Number(y), width: Number(width), height: Number(height), weight: Number(weight) || 400, italic: false, fontName: '', candidates: families.split(',') }
      })
      const fitted = await fitTexts(frame, asset.capture, texts)
      console.log(describeFittedTexts(fitted) || 'No text matched well enough.')
      const { width, height } = asset.capture
      const html = `<style>html,body{margin:0}body{width:${width}px;height:${height}px;position:relative;background:url(data:${frame.mediaType};base64,${Buffer.from(frame.data).toString('base64')}) 0 0/${width}px ${height}px no-repeat}
${fitted.map((t) => `@font-face{font-family:"${t.key}";src:url(gil-font:${t.key}) format("woff2")}`).join('')}
p{position:absolute;margin:0;white-space:nowrap;color:rgba(255,0,0,.75)}</style>${fitted.map((t) => `<p style="left:${t.left}px;top:${t.top}px;font:${t.weight} ${t.fontSize}px/1 '${t.key}';letter-spacing:${t.letterSpacing}px">${t.text}</p>`).join('')}`
      await mkdir(out, { recursive: true })
      const [image] = await renderFrames(html, { width, height, scale: 4, timestamps: [0] })
      if (image) await writeFileAtomic(join(out, 'overlay.png'), image.toPNG())
      return
    }
    case 'spacing': {
      // Makes a spacing system from an asset in the library at GIL_BENCH_LIBRARY, as the spacing lens does. No API calls.
      const [name] = rest
      const library = testLibrary()
      if (!name || !library) throw new Error('Usage: GIL_BENCH_LIBRARY=<folder> pnpm bench spacing <asset>')
      const made = await makeSpacingSystem(library, (await readAsset(library, name)).id)
      console.log(`${made.name}: ${made.summary ?? ''}`)
      if (process.env.GIL_DEBUG) console.log(JSON.stringify(await boxesOfAsset(library, name)))
      return
    }
    case 'grab': {
      // Captures part of a public web page into the benchmark, as gil's overlay would capture it
      // from the screen, for tests no one is at the screen for. A screenshot, or a short recording
      // with "seconds". No API calls.
      // pnpm bench grab <url> <name> <x> <y> <width> <height> [lens] [seconds] [note…]
      const [url, name, x, y, width, height, lens = 'auto', seconds = '0', ...note] = rest
      if (!url || !name || !width || !height) throw new Error('Usage: pnpm bench grab <url> <name> <x> <y> <width> <height> [lens] [seconds] [note…]')
      if (!/^https:\/\//.test(url)) throw new Error('Give an https address')
      const made = await grabPage({
        url,
        root: capturesDir,
        name,
        rect: { x: Number(x) || 0, y: Number(y) || 0, width: Number(width), height: Number(height) },
        lens: assetLensSchema.parse(lens),
        seconds: Number(seconds) || 0,
        note: note.join(' ') || null,
      })
      console.log(`${made.name}: ${made.capture?.mode} ${made.capture?.width} × ${made.capture?.height}`)
      return
    }
    case 'peek': {
      // A picture of a whole web page at a width, to find what to grab. pnpm bench peek <url> <width> <height> <file.png>
      const [url, width, height, file] = rest
      if (!url || !file) throw new Error('Usage: pnpm bench peek <url> <width> <height> <file.png>')
      await writeFileAtomic(file, await peekPage(url, Number(width) || 1280, Number(height) || 900))
      return
    }
    case 'colors': {
      // Makes a colour system from an asset in the library at GIL_BENCH_LIBRARY, as the colour lens does. No API calls.
      const [name] = rest
      const library = testLibrary()
      if (!name || !library) throw new Error('Usage: GIL_BENCH_LIBRARY=<folder> pnpm bench colors <asset>')
      const source = await readAsset(library, name)
      const made = await makeColorSystem(library, source.id)
      console.log(`${made.name}: ${made.summary ?? ''}`)
      return
    }
    case 'list': {
      const names = await listCaptures()
      console.log(names.length ? names.join('\n') : 'The benchmark is empty.')
      return
    }
    default:
      console.log('Usage: pnpm bench add <name>… | run | score <name>… | list')
  }
}

// No Dock icon or windows: the runner only renders recreations in hidden windows.
if (process.platform === 'darwin') app.dock?.hide()
app.on('window-all-closed', () => undefined)
void app
  .whenReady()
  .then(main)
  .then(
    () => app.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      app.exit(1)
    },
  )
