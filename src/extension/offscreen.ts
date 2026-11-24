import type { CaptureResult, OffscreenMessage, OffscreenStartReply } from './messages'
import { uploadCapture } from './upload'

/**
 * Offscreen document: the only extension page that can hold a media stream. It records the tab
 * stream the service worker obtained and uploads the recording to gil itself, because a
 * recording is too large to pass back through extension messaging.
 */

// Hardware H.264 first, as in gil's own recorder; ffmpeg reads any of these.
const MIME_TYPES = ['video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
const FRAME_RATE = 60

interface Active {
  stream: MediaStream
  recorder: MediaRecorder
  chunks: Blob[]
  frame: { width: number; height: number }
  startedAt: number
  stoppedAt: number | null
  stopped: Promise<void>
}

let active: Active | null = null

function release(): void {
  active?.stream.getTracks().forEach((track) => track.stop())
  active = null
}

async function frameSize(stream: MediaStream): Promise<{ width: number; height: number }> {
  const video = document.createElement('video')
  video.muted = true
  video.srcObject = stream
  try {
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve()
      setTimeout(resolve, 2000)
    })
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      return { width: video.videoWidth, height: video.videoHeight }
    }
    const settings = stream.getVideoTracks()[0]?.getSettings()
    return { width: settings?.width ?? 0, height: settings?.height ?? 0 }
  } finally {
    video.srcObject = null
  }
}

/**
 * Tab capture uses Chrome's legacy constraint form. Asking for exactly the viewport's pixel size
 * keeps the recording at full resolution and the same shape as the page; if Chrome cannot
 * deliver that size, any size up to it will do, since gil crops against the real frame size.
 */
async function tabStream(streamId: string, width: number, height: number): Promise<MediaStream> {
  const constraints = (exact: boolean) =>
    ({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: width,
          maxHeight: height,
          ...(exact ? { minWidth: width, minHeight: height } : {}),
          maxFrameRate: FRAME_RATE,
        },
      },
    }) as unknown as MediaStreamConstraints
  try {
    return await navigator.mediaDevices.getUserMedia(constraints(true))
  } catch (error) {
    if ((error as Error | null)?.name !== 'OverconstrainedError') throw error
    return navigator.mediaDevices.getUserMedia(constraints(false))
  }
}

async function start(streamId: string, width: number, height: number): Promise<void> {
  if (active) throw new Error('Already recording')
  const stream = await tabStream(streamId, width, height)
  try {
    const frame = await frameSize(stream)
    if (frame.width < 2 || frame.height < 2) throw new Error('The tab recording has no frames')
    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
    if (!mimeType) throw new Error('No supported recording format')
    const bitrate = Math.min(60_000_000, Math.max(16_000_000, frame.width * frame.height * 8))
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })
    const started = new Promise<void>((resolve, reject) => {
      recorder.onstart = () => resolve()
      recorder.onerror = () => reject(new Error('The recorder stopped with an error'))
    })
    active = { stream, recorder, chunks, frame, startedAt: 0, stoppedAt: null, stopped }
    const current = active
    // Navigating the tab or closing it ends the stream; keep what was recorded.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (recorder.state !== 'inactive') recorder.stop()
    })
    recorder.addEventListener('stop', () => {
      current.stoppedAt ??= performance.now()
    })
    recorder.start(200)
    await started
    current.startedAt = performance.now()
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    active = null
    throw error
  }
}

async function stop(message: Extract<OffscreenMessage, { type: 'stop' }>): Promise<CaptureResult> {
  const current = active
  if (!current) return { ok: false, error: 'The recording was lost' }
  if (current.recorder.state !== 'inactive') current.recorder.stop()
  await current.stopped
  release()
  const durationMs = Math.max(0, (current.stoppedAt ?? performance.now()) - current.startedAt)
  const type = current.recorder.mimeType.split(';')[0] ?? 'video/webm'
  const video = new Blob(current.chunks, { type })
  return uploadCapture(
    message.upload.pairingCode,
    { mode: 'recording', ...message.meta, frame: current.frame, durationMs },
    video,
  )
}

chrome.runtime.onMessage.addListener((message: OffscreenMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'offscreen') return false
  switch (message.type) {
    case 'start':
      start(message.streamId, message.width, message.height).then(
        () => sendResponse({ ok: true } satisfies OffscreenStartReply),
        (error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          } satisfies OffscreenStartReply),
      )
      return true
    case 'stop':
      void stop(message).then(sendResponse)
      return true
    case 'abort':
      if (active && active.recorder.state !== 'inactive') active.recorder.stop()
      release()
      sendResponse(undefined)
      return false
    default:
      return false
  }
})
