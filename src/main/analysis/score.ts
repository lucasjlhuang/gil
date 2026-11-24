import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { frameScale } from '../../shared/ffmpegArgs'
import { bestShift, checkTiming, gateResult, type GateResult } from '../../shared/gate'
import { assetScore, frameScore } from '../../shared/score'
import { CAPTURE_DIR, CLIP_FILE, FRAMES_DIR, readAsset, RECREATION_DIR, RECREATION_FILE } from '../storage'
import { measureClip, readMotion } from './analyze'
import { cssGray, recreationMotion } from './check'
import { renderFrames } from './render'

export interface AssetScore {
  /** 0–100, the mean of the frame scores. */
  score: number
  frames: { timestampMs: number; score: number; offsetPx: number }[]
  /** The measurable parts of the accuracy gate (see shared/gate.ts). */
  gate: GateResult
}

/**
 * Measures how closely an analyzed asset's recreation matches its capture: renders the
 * recreation at the moment of each frame the model saw (`capture/frames/`) and compares the two
 * pixel by pixel (see shared/score.ts). Uses no API calls. With `pairsDir`, also writes each
 * original and recreation frame there as PNGs, to see where a low score comes from.
 */
export async function scoreAsset(root: string, name: string, pairsDir?: string): Promise<AssetScore> {
  const asset = await readAsset(root, name)
  const capture = asset.capture
  if (!capture) throw new Error('Only captures can be scored')
  const framesDir = join(root, name, CAPTURE_DIR, FRAMES_DIR)
  const files = (await readdir(framesDir).catch(() => [] as string[]))
    .map((file) => /^(\d+)\.(jpg|png)$/.exec(file))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
  if (files.length === 0) throw new Error('This asset has no saved frames; analyze it first')
  const html = await readFile(join(root, name, RECREATION_DIR, RECREATION_FILE), 'utf8')

  const timestamps = files.map((match) => Number(match[1]))
  const rendered = await renderFrames(html, {
    width: capture.width,
    height: capture.height,
    scale: frameScale(capture.width, capture.height),
    timestamps,
  })
  const frames = await Promise.all(
    files.map(async (match, i) => {
      const original = nativeImage.createFromBuffer(await readFile(join(framesDir, match[0])))
      const size = original.getSize()
      const recreation = (rendered[i] as Electron.NativeImage).resize({ ...size, quality: 'best' })
      const score = frameScore(
        { ...size, data: original.toBitmap() },
        { ...recreation.getSize(), data: recreation.toBitmap() },
      )
      const a = cssGray(original, capture.width, capture.height)
      const b = cssGray(recreation, capture.width, capture.height)
      const shift = bestShift(a.gray, b.gray, Math.max(1, Math.round(8 * a.pxPerCss)))
      const offsetPx = Math.round((shift.distance / a.pxPerCss) * 10) / 10
      if (pairsDir) {
        await mkdir(pairsDir, { recursive: true })
        await writeFile(join(pairsDir, `${timestamps[i]}-original.png`), original.toPNG())
        await writeFile(join(pairsDir, `${timestamps[i]}-recreation.png`), recreation.toPNG())
      }
      return { timestampMs: timestamps[i] as number, score, offsetPx }
    }),
  )

  // Timing: the capture's measured movements against the recreation's, played through.
  let timing = null
  if (capture.mode === 'recording') {
    const captureDir = join(root, name, CAPTURE_DIR)
    const captured = (await readMotion(captureDir)) ?? (await measureClip(join(captureDir, CLIP_FILE)))
    if (captured && captured.segments.length > 0) {
      timing = checkTiming(captured, await recreationMotion(html, { width: capture.width, height: capture.height, scale: 1, durationMs: capture.durationMs }))
    }
  }
  const offsetPx = Math.max(0, ...frames.map((frame) => frame.offsetPx))
  return { score: assetScore(frames.map((frame) => frame.score)) ?? 0, frames, gate: gateResult(timing, offsetPx) }
}
