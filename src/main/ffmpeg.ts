import { execFile } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'

function ffmpegPath(): string {
  if (!ffmpegStatic) throw new Error('The bundled ffmpeg binary is missing for this platform')
  // Binaries cannot run from inside an asar archive; packaged builds unpack them.
  return ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve()
      const detail = stderr.trim().split('\n').slice(-3).join(' ')
      reject(new Error(`ffmpeg failed: ${detail || error.message}`))
    })
  })
}

/** Runs ffmpeg and returns what it wrote to stdout. */
export function runFfmpegCapture(args: string[], maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath(),
      args,
      { encoding: 'buffer', maxBuffer: maxBytes },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        const detail = stderr.toString('utf8').trim().split('\n').slice(-3).join(' ')
        reject(new Error(`ffmpeg failed: ${detail || error.message}`))
      },
    )
  })
}
