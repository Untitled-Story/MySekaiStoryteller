import assert from 'node:assert/strict'
import test from 'node:test'
import { computeMouthOpenFromSamples, encodeAudioBufferToWav } from '../audioTimeline'
import { estimateStoryDurationMs } from '../durationEstimator'
import {
  computeOptimalPboGroupFrames,
  computeOptimalPboSlotCount,
  rgbToBt709LimitedUv,
  rgbToBt709LimitedY
} from '../glNv12Packer'
import {
  coerceCodecsForContainer,
  computeStageFitLayout,
  computeWebCodecsString,
  normalizeEvenDimension,
  splitSubStepDeltas
} from '../presets'
import type { StoryData } from '@/story/schema'

test('normalizeEvenDimension clamps and rounds to even pixel bounds', () => {
  assert.equal(normalizeEvenDimension(1365, 320, 7680), 1364)
  assert.equal(normalizeEvenDimension(100, 320, 7680), 320)
  assert.equal(normalizeEvenDimension(9999, 320, 7680), 7680)
  assert.equal(normalizeEvenDimension(3840, 320, 7680), 3840)
})

test('computeStageFitLayout matches 16:9 directly and letterboxes non-16:9', () => {
  const uhd = computeStageFitLayout(3840, 2160)
  assert.equal(uhd.directMatch, true)
  assert.equal(uhd.rendererResolution, 2)
  assert.equal(uhd.offsetX, 0)
  assert.equal(uhd.offsetY, 0)

  const ultrawide = computeStageFitLayout(2560, 1080)
  assert.equal(ultrawide.directMatch, false)
  assert.equal(ultrawide.rendererResolution, 1)
  assert.equal(ultrawide.renderedWidth, 1920)
  assert.equal(ultrawide.renderedHeight, 1080)
  assert.equal(ultrawide.offsetX, 320)
  assert.equal(ultrawide.offsetY, 0)

  const portrait = computeStageFitLayout(1080, 1920)
  assert.equal(portrait.directMatch, false)
  assert.equal(portrait.renderedWidth, 1080)
  assert.equal(portrait.offsetX, 0)
  assert.ok(portrait.offsetY > 0)
})

test('computeWebCodecsString picks 4K 120fps levels without under-specifying', () => {
  assert.equal(computeWebCodecsString('hevc', 3840, 2160, 120, false), 'hvc1.1.6.L156.B0')
  assert.equal(computeWebCodecsString('h264', 3840, 2160, 120, false), 'avc1.64003c')
  assert.equal(computeWebCodecsString('h264', 1920, 1080, 60, false), 'avc1.64002a')
  assert.equal(computeWebCodecsString('h264', 1920, 1080, 60, true), 'avc1.42402a')
  assert.equal(computeWebCodecsString('vp9', 3840, 2160, 120, false), 'vp09.00.52.08')
  assert.equal(computeWebCodecsString('av1', 3840, 2160, 120, false), 'av01.0.14M.08')
})

test('splitSubStepDeltas subdivides low FPS frames under 16.67ms without drift', () => {
  const delta24: number = 1000 / 24
  const steps24: number[] = splitSubStepDeltas(delta24)
  assert.equal(steps24.length, 3)
  for (const step of steps24) {
    assert.ok(step <= 1000 / 60 + 1e-6)
  }
  const sum24: number = steps24.reduce((a: number, b: number): number => a + b, 0)
  assert.ok(Math.abs(sum24 - delta24) < 1e-9)

  const delta120: number = 1000 / 120
  const steps120: number[] = splitSubStepDeltas(delta120)
  assert.deepEqual(steps120, [delta120])
})

test('coerceCodecsForContainer enforces container compatibility and alpha support', () => {
  assert.deepEqual(coerceCodecsForContainer('webm', 'h264', 'aac', true), {
    videoCodec: 'vp9',
    audioCodec: 'opus',
    transparentAlpha: true
  })
  assert.deepEqual(coerceCodecsForContainer('mp4', 'hevc', 'aac', true), {
    videoCodec: 'hevc',
    audioCodec: 'aac',
    transparentAlpha: false
  })
})

test('BT.709 color math maps black and white to exact studio swing range', () => {
  assert.ok(Math.abs(rgbToBt709LimitedY(0, 0, 0) * 255 - 16) < 1e-6)
  assert.ok(Math.abs(rgbToBt709LimitedY(1, 1, 1) * 255 - 235) < 1e-6)
  const [uBlack, vBlack] = rgbToBt709LimitedUv(0, 0, 0)
  assert.ok(Math.abs(uBlack * 255 - 128) < 1e-6)
  assert.ok(Math.abs(vBlack * 255 - 128) < 1e-6)

  const [uWhite, vWhite] = rgbToBt709LimitedUv(1, 1, 1)
  assert.ok(Math.abs(uWhite * 255 - 128) < 1e-6)
  assert.ok(Math.abs(vWhite * 255 - 128) < 1e-6)
})

test('computeOptimalPboSlotCount scales PBO ring depth within memory budget', () => {
  const fhdNv12Bytes: number = (1920 * 1080 * 3) / 2
  const uhdNv12Bytes: number = (3840 * 2160 * 3) / 2
  const uhdRgbaBytes: number = 3840 * 2160 * 4
  const eightKNv12Bytes: number = (7680 * 4320 * 3) / 2

  assert.equal(computeOptimalPboSlotCount(fhdNv12Bytes), 32)
  assert.equal(computeOptimalPboSlotCount(uhdNv12Bytes), 32)
  assert.equal(computeOptimalPboSlotCount(uhdRgbaBytes), 12)
  assert.equal(computeOptimalPboSlotCount(eightKNv12Bytes), 7)
  assert.equal(computeOptimalPboSlotCount(100 * 1024 * 1024), 6)
  assert.equal(computeOptimalPboSlotCount(0), 6)
  assert.equal(computeOptimalPboSlotCount(-1024), 6)
  assert.equal(computeOptimalPboSlotCount(Number.NaN), 6)
})

test('computeOptimalPboGroupFrames batches frames per PBO up to IPC budget', () => {
  const fhdNv12Bytes: number = (1920 * 1080 * 3) / 2
  const uhdNv12Bytes: number = (3840 * 2160 * 3) / 2
  const uhdRgbaBytes: number = 3840 * 2160 * 4
  const eightKNv12Bytes: number = (7680 * 4320 * 3) / 2

  assert.equal(computeOptimalPboGroupFrames(fhdNv12Bytes), 8)
  assert.equal(computeOptimalPboGroupFrames(uhdNv12Bytes), 4)
  assert.equal(computeOptimalPboGroupFrames(uhdRgbaBytes), 1)
  assert.equal(computeOptimalPboGroupFrames(eightKNv12Bytes), 1)
  assert.equal(computeOptimalPboGroupFrames(uhdNv12Bytes, 25 * 1024 * 1024), 2)
  assert.equal(computeOptimalPboGroupFrames(0), 1)
  assert.equal(computeOptimalPboGroupFrames(-1), 1)
  assert.equal(computeOptimalPboGroupFrames(uhdNv12Bytes, 0), 1)
})

test('computeMouthOpenFromSamples replicates SoundManager dB normalization', () => {
  const silence = new Float32Array(1024)
  assert.equal(computeMouthOpenFromSamples(silence, 48000, 0.02), 0)

  const loud = new Float32Array(1024).fill(0.5)
  // RMS = 0.5 -> dB = -6.02 dB -> above maxDecibels (-10) -> clamped to 1.0
  assert.equal(computeMouthOpenFromSamples(loud, 48000, 0.02), 1)

  const midAmplitude = Math.pow(10, -50 / 20)
  const mid = new Float32Array(1024).fill(midAmplitude)
  // dB = -50 -> (-50 - -90) / (-10 - -90) = 0.5
  assert.equal(computeMouthOpenFromSamples(mid, 48000, 0.02), 0.5)
})

test('encodeAudioBufferToWav writes valid 44-byte RIFF PCM16 header and samples', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1])
  const right = new Float32Array([0, -0.5, 0.5, -1])
  const mockAudioBuffer = {
    numberOfChannels: 2,
    length: 4,
    sampleRate: 48000,
    duration: 4 / 48000,
    getChannelData: (channel: number): Float32Array => (channel === 0 ? left : right)
  } as unknown as AudioBuffer

  const wav = encodeAudioBufferToWav(mockAudioBuffer)
  assert.equal(wav.byteLength, 44 + 4 * 2 * 2)
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE')
  assert.equal(String.fromCharCode(...wav.slice(36, 40)), 'data')
})

test('estimateStoryDurationMs accounts for talk UI open, voice duration, parallel max, and hide', () => {
  const story: StoryData = {
    version: 1,
    snippets: [
      {
        type: 'Talk',
        delay: 0.5,
        data: {
          speaker: 'Ichika',
          content: 'Hi',
          voice: 'v1'
        }
      },
      {
        type: 'Parallel',
        delay: 0,
        snippets: [
          { type: 'HideTalk', delay: 0 },
          {
            type: 'ScreenFadeOut',
            delay: 0.2,
            data: { color: '#000000', duration: 0.8 }
          }
        ]
      }
    ]
  }
  const voices = new Map<string, number>([['v1', 1500]])
  // Talk: 500 delay + 200 showBg + max(2*70, 1500) = 2200
  // Parallel: max(HideTalk 200, FadeOut 200 + 800) = 1000
  // Total: 3200ms
  assert.equal(estimateStoryDurationMs(story, voices), 3200)
})
