import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createCaptureAsset, type Asset, type AssetLens } from '../shared/asset'
import { cropClipArgs, posterArgs } from '../shared/ffmpegArgs'
import type { Rect } from '../shared/geometry'
import { PAGE_STYLES_FILE, type PageStyles } from '../shared/pageStyles'
import { provisionalName, provisionalTitle } from '../shared/slug'
import { runFfmpeg } from './ffmpeg'
import {
  CAPTURE_DIR,
  CLIP_FILE,
  commitStagedAsset,
  createStagingDir,
  discardStagingDir,
  FILES_DIR,
  POSTER_FILE,
} from './storage'

/**
 * Turns a finished recording or screenshot into an asset folder. Shared by every way of
 * capturing (the overlay, the Chrome extension) so they all write the same
 * format.
 */

export interface CaptureSource {
  app: string | null
  windowTitle: string | null
  url: string | null
}

interface SaveCommon {
  id: string
  root: string
  context: string | null
  source: CaptureSource
  /** Crop in physical pixels of the recorded frames or the full image. */
  crop: Rect
  /** Physical pixels per CSS pixel. */
  scale: number
  /** An image added from a file or the clipboard rather than captured. */
  imported?: boolean
  /** What the user asked to look for; auto when not given. */
  lens?: AssetLens
  /** Exact style values from a web page (Chrome extension). */
  pageStyles?: PageStyles
}

function cssSize(crop: Rect, scale: number) {
  return {
    width: Math.max(1, Math.round(crop.width / scale)),
    height: Math.max(1, Math.round(crop.height / scale)),
  }
}

async function commit(
  input: SaveCommon,
  stage: (captureDir: string) => Promise<void>,
  capture: { mode: 'recording' | 'screenshot'; durationMs: number; isStill: boolean },
): Promise<Asset> {
  const now = new Date()
  let stagingDir: string | null = await createStagingDir(input.root, input.id)
  try {
    await stage(join(stagingDir, CAPTURE_DIR))
    if (input.pageStyles) {
      await writeFile(join(stagingDir, CAPTURE_DIR, PAGE_STYLES_FILE), `${JSON.stringify(input.pageStyles, null, 2)}\n`)
    }
    const prefix = input.imported ? 'image' : 'capture'
    const asset = await commitStagedAsset(input.root, stagingDir, provisionalName(now, prefix), (name) =>
      createCaptureAsset({
        id: input.id,
        name,
        title: provisionalTitle(now, input.imported ? 'Image' : 'Capture'),
        origin: input.imported ? 'import' : 'capture',
        lens: input.lens ?? 'auto',
        userContext: input.context,
        source: input.source,
        capture: { ...capture, ...cssSize(input.crop, input.scale), scale: input.scale },
        now,
      }),
    )
    stagingDir = null
    return asset
  } finally {
    if (stagingDir) await discardStagingDir(stagingDir)
  }
}

/** Crops an uncropped recording (any container ffmpeg reads) into clip.mp4 and poster.png. */
export function saveRecording(
  input: SaveCommon & { recordingPath: string; durationMs: number },
): Promise<Asset> {
  return commit(
    input,
    async (captureDir) => {
      const clipPath = join(captureDir, CLIP_FILE)
      await runFfmpeg(cropClipArgs(input.recordingPath, clipPath, input.crop))
      await runFfmpeg(posterArgs(clipPath, join(captureDir, POSTER_FILE)))
    },
    // Motion detection arrives with analysis; until then every recording is a clip.
    { mode: 'recording', durationMs: input.durationMs, isStill: false },
  )
}

/**
 * Saves an already cropped PNG as poster.png. A screenshot has no clip. `original` (an imported
 * file) is kept as is in the asset's files/ folder.
 */
export function saveScreenshot(input: SaveCommon & { png: Uint8Array; original?: string }): Promise<Asset> {
  return commit(
    input,
    async (captureDir) => {
      await writeFile(join(captureDir, POSTER_FILE), input.png)
      if (input.original) {
        const files = join(captureDir, '..', FILES_DIR)
        await mkdir(files, { recursive: true })
        await copyFile(input.original, join(files, basename(input.original)))
      }
    },
    { mode: 'screenshot', durationMs: 0, isStill: true },
  )
}
