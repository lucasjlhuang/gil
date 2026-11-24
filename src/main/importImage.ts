import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { clipboard, nativeImage } from 'electron'
import { newAssetId, type Asset } from '../shared/asset'
import { saveScreenshot } from './saveCapture'

/**
 * Adds images as assets: a file dragged onto the library or picked with Import, or an image on
 * the clipboard. Each becomes a screenshot-like asset (poster.png at full size, analyzable like a
 * screenshot), with an imported file kept as is in files/. An image's CSS size is taken to be
 * its pixel size, since nothing says what screen it came from.
 */

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.tif', '.tiff', '.bmp']

async function save(root: string, image: Electron.NativeImage, original?: string): Promise<Asset> {
  if (image.isEmpty()) throw new Error(original ? `gil could not read ${original} as an image` : 'There is no image on the clipboard')
  const { width, height } = image.getSize()
  return saveScreenshot({
    id: newAssetId(),
    root,
    context: null,
    source: { app: null, windowTitle: null, url: null },
    crop: { x: 0, y: 0, width, height },
    scale: 1,
    png: image.toPNG(),
    imported: true,
    ...(original ? { original } : {}),
  })
}

/** nativeImage reads these itself; the rest are converted to PNG with macOS's own `sips`. */
const NATIVE_EXTENSIONS = ['.png', '.jpg', '.jpeg']

/** Decodes a WebP, GIF (first frame), HEIC, TIFF or BMP file with `sips`, which every Mac has. */
async function convertWithSips(path: string): Promise<Electron.NativeImage> {
  const temp = await mkdtemp(join(tmpdir(), 'gil-import-'))
  try {
    const output = join(temp, 'image.png')
    await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'png', path, '--out', output])
    return nativeImage.createFromPath(output)
  } catch {
    return nativeImage.createEmpty()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

export async function importImageFile(root: string, path: string): Promise<Asset> {
  const extension = extname(path).toLowerCase()
  if (!isAbsolute(path) || !IMAGE_EXTENSIONS.includes(extension)) {
    throw new Error(`${path} is not an image gil can import`)
  }
  const image = NATIVE_EXTENSIONS.includes(extension) ? nativeImage.createFromPath(path) : await convertWithSips(path)
  return save(root, image, path)
}

/** The first image on the clipboard (Electron's clipboard API is asynchronous and MIME based). */
export async function importClipboardImage(root: string): Promise<Asset> {
  for (const item of await clipboard.read()) {
    const type = item.types.find((candidate) => candidate.startsWith('image/'))
    if (!type) continue
    const blob = (await item.getType(type)) as Blob
    return save(root, nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())))
  }
  throw new Error('There is no image on the clipboard')
}
