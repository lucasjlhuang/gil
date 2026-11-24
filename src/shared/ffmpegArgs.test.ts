import { describe, expect, it } from 'vitest'
import {
  cropClipArgs,
  focusClipArgs,
  focusStillArgs,
  frameEdge,
  frameScale,
  motionMeasureArgs,
  motionThumbnailArgs,
  posterArgs,
  selectedFramesArgs,
  stillFrameArgs,
} from './ffmpegArgs'

describe('cropClipArgs', () => {
  it('builds a crop filter in ffmpeg order (w:h:x:y)', () => {
    const args = cropClipArgs('/tmp/in.webm', '/lib/a/capture/clip.mp4', {
      x: 200,
      y: 100,
      width: 640,
      height: 96,
    })
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=640:96:200:100')
    expect(args[args.indexOf('-i') + 1]).toBe('/tmp/in.webm')
    expect(args.at(-1)).toBe('/lib/a/capture/clip.mp4')
    expect(args).toContain('-an')
  })

  it('passes paths with spaces as single arguments', () => {
    const args = cropClipArgs('/tmp/my clip.webm', '/out dir/clip.mp4', {
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    })
    expect(args).toContain('/tmp/my clip.webm')
    expect(args).toContain('/out dir/clip.mp4')
  })

  it.each([
    { x: 0, y: 0, width: 641, height: 96 },
    { x: 0, y: 0, width: 640, height: 0 },
    { x: 0.5, y: 0, width: 640, height: 96 },
    { x: -2, y: 0, width: 640, height: 96 },
  ])('rejects %j', (crop) => {
    expect(() => cropClipArgs('in', 'out', crop)).toThrow()
  })
})

describe('posterArgs', () => {
  it('extracts one frame', () => {
    const args = posterArgs('clip.mp4', 'poster.png')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1')
    expect(args.at(-1)).toBe('poster.png')
  })
})

describe('analysis frame args', () => {
  it('samples gray thumbnails to stdout', () => {
    const args = motionThumbnailArgs('in.mp4')
    expect(args).toContain('pipe:1')
    expect(args[args.indexOf('-vf') + 1]).toBe('fps=20,scale=64:64:flags=area,format=gray')
  })

  it('selects the given frames and caps their size', () => {
    const args = selectedFramesArgs('in.mp4', [0, 7, 12], '/tmp/f-%03d.jpg')
    expect(args[args.indexOf('-vf') + 1]).toMatch(/^fps=20,select=eq\(n\\,0\)\+eq\(n\\,7\)\+eq\(n\\,12\),scale=/)
    expect(args.at(-1)).toBe('/tmp/f-%03d.jpg')
  })

  it('scales every frame to the same long edge, up or down', () => {
    const vf = selectedFramesArgs('in.mp4', [0], 'x')[selectedFramesArgs('in.mp4', [0], 'x').indexOf('-vf') + 1]
    expect(vf).toContain("scale='if(gte(iw,ih),1568,-2)':'if(gte(iw,ih),-2,1568)':flags=lanczos")
    expect(stillFrameArgs('a.png', 'b.png')).toContain("scale='if(gte(iw,ih),1568,-2)':'if(gte(iw,ih),-2,1568)':flags=lanczos")
    // Frames are no larger than is useful for the capture: three pixels per CSS pixel, within limits.
    expect(frameEdge(233, 265)).toBe(795)
    expect(frameEdge(147, 52)).toBe(640)
    expect(frameEdge(1200, 800)).toBe(1568)
    expect(frameScale(233, 265)).toBeCloseTo(3)
    expect(stillFrameArgs('a.png', 'b.png', 795).join(' ')).toContain('795')
    expect(frameScale(266, 53)).toBeCloseTo(3)
  })

  it('rejects an empty or invalid selection', () => {
    expect(() => selectedFramesArgs('in.mp4', [], 'x')).toThrow()
    expect(() => selectedFramesArgs('in.mp4', [1.5], 'x')).toThrow()
  })
})

describe('motionMeasureArgs', () => {
  it('decodes small grayscale frames at the given rate to stdout', () => {
    const args = motionMeasureArgs('/in.mp4', 30, 96)
    expect(args).toContain('fps=30,scale=96:96:flags=area,format=gray')
    expect(args.at(-1)).toBe('pipe:1')
  })
})

describe('focus cuts', () => {
  it('cuts a clip in time, and in area on whole even pixels', () => {
    const time = focusClipArgs('clip.mp4', 'focus.mp4', { fromMs: 2400, toMs: 4800 })
    expect(time.slice(4, 10)).toEqual(['-ss', '2.400', '-to', '4.800', '-i', 'clip.mp4'])
    expect(time).not.toContain('-vf')
    const both = focusClipArgs('clip.mp4', 'focus.mp4', { fromMs: 0, toMs: 1000, box: { x: 0.25, y: 0.1, width: 0.5, height: 0.4 } })
    expect(both[both.indexOf('-vf') + 1]).toBe('crop=trunc(iw*0.5/2)*2:trunc(ih*0.4/2)*2:trunc(iw*0.25/2)*2:trunc(ih*0.1/2)*2')
    expect(() => focusClipArgs('a', 'b', { fromMs: 500, toMs: 500 })).toThrow()
    expect(focusStillArgs('poster.png', 'focus.png', { x: 0, y: 0, width: 0.5, height: 0.5 })).toContain('focus.png')
  })
})
