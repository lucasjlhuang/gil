import type { Rect } from './geometry'

/**
 * Argument lists for the bundled ffmpeg. Kept pure so the exact commands are unit tested;
 * spawning happens in main.
 */

/** Crops the full-display recording to the selected region and writes an H.264 MP4. */
export function cropClipArgs(input: string, output: string, crop: Rect): string[] {
  for (const value of [crop.x, crop.y, crop.width, crop.height]) {
    if (!Number.isInteger(value) || value < 0) throw new Error('Crop must be whole pixels')
  }
  if (crop.width % 2 !== 0 || crop.height % 2 !== 0 || crop.width === 0 || crop.height === 0) {
    throw new Error('Crop size must be even and non-zero')
  }
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vf',
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '17',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  ]
}

type FocusBox = { x: number; y: number; width: number; height: number }

/** A crop filter for a box given as fractions of the picture, on whole even pixels. */
const boxFilter = (box: FocusBox) =>
  `crop=trunc(iw*${box.width}/2)*2:trunc(ih*${box.height}/2)*2:trunc(iw*${box.x}/2)*2:trunc(ih*${box.y}/2)*2`

/**
 * Cuts a clip to the part the user asked for: a span of time and, optionally, a box of the
 * picture (fractions). Re-encoded at high quality, since everything after is measured from it.
 */
export function focusClipArgs(input: string, output: string, focus: { fromMs: number; toMs: number; box?: FocusBox | undefined }): string[] {
  if (!(focus.toMs > focus.fromMs) || focus.fromMs < 0) throw new Error('The focus span must have a length')
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    (focus.fromMs / 1000).toFixed(3),
    '-to',
    (focus.toMs / 1000).toFixed(3),
    '-i',
    input,
    ...(focus.box ? ['-vf', boxFilter(focus.box)] : []),
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '12',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  ]
}

/** Cuts a still image to a box of the picture (fractions), as a PNG. */
export function focusStillArgs(input: string, output: string, box: FocusBox): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', boxFilter(box), '-frames:v', '1', output]
}

/** Writes the first frame of a clip as a PNG. */
export function posterArgs(input: string, output: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', output]
}

/** Rate frames are sampled at for analysis, per second. */
export const ANALYSIS_FPS = 20
/** Grayscale thumbnail side for motion detection; small enough to ignore noise and be fast. */
export const THUMB_SIZE = 64
/**
 * The longest a frame sent to the model may be: the API scales anything larger down anyway.
 */
export const MAX_FRAME_EDGE = 1568
/**
 * Frames are sent at up to this many pixels per CSS pixel of the capture, and never smaller
 * than MIN_FRAME_EDGE on their long side. A capture is recorded at one or two pixels per CSS
 * pixel, so more than three adds no detail, only cost: an image is billed by its area. A small
 * capture, such as a logo in a header, is still enlarged enough to read.
 */
export const FRAME_PX_PER_CSS = 3
export const MIN_FRAME_EDGE = 640

/** The long side, in pixels, of the frames the model sees for a capture of this CSS size. */
export function frameEdge(cssWidth: number, cssHeight: number): number {
  const long = Math.max(cssWidth, cssHeight, 1)
  return Math.round(Math.min(MAX_FRAME_EDGE, Math.max(MIN_FRAME_EDGE, long * FRAME_PX_PER_CSS)))
}

/** The frames' long edge as a filter: scaled to exactly `edge`, up or down. */
const frameFilter = (edge: number) => `scale='if(gte(iw,ih),${edge},-2)':'if(gte(iw,ih),-2,${edge})':flags=lanczos`

/** How many frame pixels the model sees per CSS pixel of a capture of this size. */
export function frameScale(cssWidth: number, cssHeight: number): number {
  return frameEdge(cssWidth, cssHeight) / Math.max(cssWidth, cssHeight, 1)
}

/** A screenshot as the model sees it: a PNG scaled like every other frame. */
export function stillFrameArgs(input: string, output: string, edge = MAX_FRAME_EDGE): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', frameFilter(edge), output]
}

/** One frame of a clip at `atMs`, as a PNG written to stdout. */
export function frameAtArgs(input: string, atMs: number): string[] {
  if (!Number.isFinite(atMs) || atMs < 0) throw new Error('The moment must be zero or more')
  return ['-hide_banner', '-loglevel', 'error', '-ss', (atMs / 1000).toFixed(3), '-i', input, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']
}

/** Decodes a clip into raw 8-bit grayscale thumbnails at ANALYSIS_FPS, written to stdout. */
export function motionThumbnailArgs(input: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vf',
    `fps=${ANALYSIS_FPS},scale=${THUMB_SIZE}:${THUMB_SIZE}:flags=area,format=gray`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ]
}

/** Decodes a clip into raw grayscale frames for measuring motion (see shared/motion.ts). */
export function motionMeasureArgs(input: string, fps: number, size: number): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vf',
    `fps=${fps},scale=${size}:${size}:flags=area,format=gray`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ]
}

/**
 * Writes the chosen frames (indices of the ANALYSIS_FPS sampling) as high-quality JPEGs named
 * `<pattern>` (an image2 pattern such as `.../frame-%03d.jpg`), in index order, with the longest
 * side scaled to `edge`. JPEG keeps two dozen full-size frames well inside the API's
 * request size limit, where PNGs of busy UI would not.
 */
export function selectedFramesArgs(input: string, indices: readonly number[], pattern: string, edge = MAX_FRAME_EDGE): string[] {
  if (indices.length === 0) throw new Error('No frames selected')
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0) throw new Error('Frame indices must be whole numbers')
  }
  const select = indices.map((index) => `eq(n\\,${index})`).join('+')
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vf',
    `fps=${ANALYSIS_FPS},select=${select},${frameFilter(edge)}`,
    '-fps_mode',
    'vfr',
    '-q:v',
    '2',
    pattern,
  ]
}
