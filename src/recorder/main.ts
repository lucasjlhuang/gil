import type { RecorderStartOptions } from '../shared/channels'

/**
 * Hidden recorder. Main picks the display (through the display-media request handler) and
 * calls `__gilStartRecording` with a user gesture; this page only records what it is given
 * and streams the bytes back.
 */

const api = window.gilRecorder

// Hardware H.264 first: software VP9 struggles to keep 60 fps on a full Retina display.
const MIME_TYPES = [
  'video/webm;codecs=h264',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

let recorder: MediaRecorder | null = null
let stream: MediaStream | null = null

function release(): void {
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  recorder = null
}

/** The real frame size, which is what the crop must be computed against. */
async function frameSize(source: MediaStream): Promise<{ width: number; height: number }> {
  const video = document.createElement('video')
  video.muted = true
  video.srcObject = source
  try {
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve()
      setTimeout(resolve, 2000)
    })
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      return { width: video.videoWidth, height: video.videoHeight }
    }
    const settings = source.getVideoTracks()[0]?.getSettings()
    return { width: settings?.width ?? 0, height: settings?.height ?? 0 }
  } finally {
    video.srcObject = null
  }
}

async function start(options: RecorderStartOptions): Promise<void> {
  if (recorder) throw new Error('Already recording')
  stream = await navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: {
      width: { ideal: options.width },
      height: { ideal: options.height },
      frameRate: { ideal: options.frameRate },
      // Leave the mouse pointer out: it is not part of the design, and in the clip it would be
      // copied into recreations and counted as motion. (Not in TypeScript's DOM types; Chromium
      // ignores it if it cannot honour it.)
      cursor: 'never',
    } as MediaTrackConstraints,
  })
  const { width, height } = await frameSize(stream)
  const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
  if (!mimeType) throw new Error('No supported recording format')

  const bitrate = Math.min(60_000_000, Math.max(16_000_000, width * height * 8))
  const active = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate })
  recorder = active

  // Chunks are converted asynchronously; the chain keeps them in order.
  let queue = Promise.resolve()
  let startedAt = 0
  active.ondataavailable = (event) => {
    if (event.data.size === 0) return
    queue = queue.then(async () => api.chunk(new Uint8Array(await event.data.arrayBuffer())))
  }
  active.onstart = () => {
    startedAt = performance.now()
    api.started({ width, height, mimeType })
  }
  active.onerror = () => {
    release()
    api.failed('The recorder stopped with an error')
  }
  active.onstop = () => {
    const durationMs = startedAt ? performance.now() - startedAt : 0
    void queue.then(() => {
      release()
      api.stopped({ durationMs })
    })
  }
  // If macOS ends the capture (permission revoked, display unplugged), finish cleanly.
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (active.state !== 'inactive') active.stop()
  })
  active.start(200)
}

window.__gilStartRecording = (options) => {
  start(options).catch((error: unknown) => {
    release()
    api.failed(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  })
}

api.onStop(() => {
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  else release()
})
