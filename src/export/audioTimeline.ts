import type { SekaiLive2DModel } from '@/lib/live2d'
import type { ProjectAssets } from '@/project/assets'
import { resolveVoiceUrl } from '@/story/runtime'
import type { StorySpeakContext } from '@/story/types'
import type { ExportAudioEvent } from './types'

const ANALYZER_MIN_DECIBELS: number = -90
const ANALYZER_MAX_DECIBELS: number = -10
const ANALYZER_MIN_RMS_DB: number = -100
const ANALYZER_FFT_SIZE: number = 512
const VOICE_VOLUME: number = 0.5
export const EXPORT_AUDIO_SAMPLE_RATE: number = 48000

type MotionManagerLike = {
  currentAudio?: unknown
  mouthSync?: () => number
}

type InternalModelWithLipSync = {
  lipSync?: boolean
  motionManager?: MotionManagerLike
}

type ActiveSpeech = {
  modelKey: string
  internalModel: InternalModelWithLipSync
  originalMouthSync?: () => number
  eventIndex: number
  buffer: AudioBuffer
  startMs: number
  durationMs: number
  currentLipValue: number
  settled: boolean
  resolve: () => void
}

export function computeMouthOpenFromSamples(
  samples: Float32Array,
  sampleRate: number,
  elapsedSeconds: number,
  windowSize: number = ANALYZER_FFT_SIZE
): number {
  if (samples.length === 0 || sampleRate <= 0 || elapsedSeconds < 0) return 0

  const endSample: number = Math.min(
    samples.length,
    Math.max(1, Math.round(elapsedSeconds * sampleRate))
  )
  const startSample: number = Math.max(0, endSample - windowSize)
  const count: number = endSample - startSample
  if (count <= 0) return 0

  let sumSquares: number = 0
  for (let i = startSample; i < endSample; i += 1) {
    const sample: number = samples[i]
    sumSquares += sample * sample
  }

  const rms: number = Math.sqrt(sumSquares / count)
  const minAmplitude: number = Math.pow(10, ANALYZER_MIN_RMS_DB / 20)
  const db: number = 20 * Math.log10(rms || minAmplitude)
  const scaledDb: number = Math.min(
    Math.max((db - ANALYZER_MIN_DECIBELS) / (ANALYZER_MAX_DECIBELS - ANALYZER_MIN_DECIBELS), 0),
    1
  )
  return Number.parseFloat(scaledDb.toFixed(1))
}

export async function decodeProjectVoices(
  projectPath: string,
  assets: ProjectAssets
): Promise<Map<string, AudioBuffer>> {
  const voiceEntries: readonly [string, { path: string }][] = Object.entries(assets.voices)
  const result: Map<string, AudioBuffer> = new Map<string, AudioBuffer>()
  if (voiceEntries.length === 0) return result

  const audioCtx: AudioContext = new AudioContext({ sampleRate: EXPORT_AUDIO_SAMPLE_RATE })
  try {
    await Promise.all(
      voiceEntries.map(async ([voiceKey]: readonly [string, { path: string }]): Promise<void> => {
        const resolved = resolveVoiceUrl(projectPath, assets, voiceKey)
        const response: Response = await fetch(resolved.url)
        if (!response.ok) {
          throw new Error(`加载语音资源失败 (${voiceKey}): HTTP ${response.status}`)
        }
        const arrayBuffer: ArrayBuffer = await response.arrayBuffer()
        const decoded: AudioBuffer = await audioCtx.decodeAudioData(arrayBuffer)
        result.set(voiceKey, decoded)
      })
    )
    return result
  } finally {
    await audioCtx.close().catch((): void => undefined)
  }
}

export class OfflineSpeechCoordinator {
  private readonly decodedVoices: ReadonlyMap<string, AudioBuffer>
  private readonly activeByModel: Map<string, ActiveSpeech> = new Map<string, ActiveSpeech>()
  private readonly events: ExportAudioEvent[] = []
  private readonly getElapsedTimeMs: () => number
  private readonly dummyAudioToken: object = {}

  constructor(decodedVoices: ReadonlyMap<string, AudioBuffer>, getElapsedTimeMs: () => number) {
    this.decodedVoices = decodedVoices
    this.getElapsedTimeMs = getElapsedTimeMs
  }

  speak(context: StorySpeakContext): Promise<void> {
    const buffer: AudioBuffer | undefined = this.decodedVoices.get(context.voiceKey)
    if (!buffer) {
      return Promise.resolve()
    }

    const nowMs: number = this.getElapsedTimeMs()
    const existing: ActiveSpeech | undefined = this.activeByModel.get(context.modelKey)
    if (existing) {
      this.finishSpeech(existing, nowMs)
    }

    const durationMs: number = Math.max(0, buffer.duration * 1000)
    const eventIndex: number = this.events.length
    this.events.push({
      voiceKey: context.voiceKey,
      voiceUrl: context.voiceUrl,
      startMs: nowMs,
      maxDurationMs: durationMs,
      volume: VOICE_VOLUME
    })

    if (durationMs <= 0) {
      return Promise.resolve()
    }

    const internalModel: InternalModelWithLipSync = (
      context.model as unknown as { internalModel: InternalModelWithLipSync }
    ).internalModel
    const motionManager: MotionManagerLike | undefined = internalModel.motionManager
    const originalMouthSync: (() => number) | undefined =
      motionManager?.mouthSync?.bind(motionManager)

    return new Promise<void>((resolve: () => void): void => {
      const speech: ActiveSpeech = {
        modelKey: context.modelKey,
        internalModel,
        originalMouthSync,
        eventIndex,
        buffer,
        startMs: nowMs,
        durationMs,
        currentLipValue: 0,
        settled: false,
        resolve
      }

      internalModel.lipSync = true
      if (motionManager) {
        motionManager.currentAudio = this.dummyAudioToken
        motionManager.mouthSync = (): number => speech.currentLipValue
      }

      this.activeByModel.set(context.modelKey, speech)
    })
  }

  updateAt(elapsedMs: number): void {
    for (const speech of [...this.activeByModel.values()]) {
      const localMs: number = elapsedMs - speech.startMs
      if (localMs >= speech.durationMs) {
        this.finishSpeech(speech, elapsedMs)
        continue
      }

      const channelData: Float32Array = speech.buffer.getChannelData(0)
      speech.currentLipValue = computeMouthOpenFromSamples(
        channelData,
        speech.buffer.sampleRate,
        localMs / 1000
      )
    }
  }

  finalizeAll(totalElapsedMs: number): readonly ExportAudioEvent[] {
    for (const speech of [...this.activeByModel.values()]) {
      this.finishSpeech(speech, totalElapsedMs)
    }
    return [...this.events]
  }

  getRecordedEvents(): readonly ExportAudioEvent[] {
    return [...this.events]
  }

  private finishSpeech(speech: ActiveSpeech, elapsedMs: number): void {
    if (speech.settled) return
    speech.settled = true
    this.activeByModel.delete(speech.modelKey)

    const actualDurationMs: number = Math.min(
      speech.durationMs,
      Math.max(0, elapsedMs - speech.startMs)
    )
    const eventRecord: ExportAudioEvent | undefined = this.events[speech.eventIndex]
    if (eventRecord) {
      eventRecord.maxDurationMs = actualDurationMs
    }

    const motionManager: MotionManagerLike | undefined = speech.internalModel.motionManager
    if (motionManager) {
      if (motionManager.currentAudio === this.dummyAudioToken) {
        motionManager.currentAudio = undefined
      }
      if (speech.originalMouthSync) {
        motionManager.mouthSync = speech.originalMouthSync
      }
    }
    speech.currentLipValue = 0
    speech.resolve()
  }
}

export function clearExportLipSync(model: SekaiLive2DModel): void {
  const internalModel: InternalModelWithLipSync = (
    model as unknown as { internalModel: InternalModelWithLipSync }
  ).internalModel
  if (internalModel.motionManager) {
    internalModel.motionManager.currentAudio = undefined
  }
}

export async function mixAudioEventsToBuffer(
  events: readonly ExportAudioEvent[],
  decodedVoices: ReadonlyMap<string, AudioBuffer>,
  totalDurationMs: number,
  sampleRate: number = EXPORT_AUDIO_SAMPLE_RATE
): Promise<AudioBuffer | null> {
  if (events.length === 0 || totalDurationMs <= 0) return null

  const frameCount: number = Math.max(1, Math.ceil((totalDurationMs / 1000) * sampleRate))
  const offlineCtx: OfflineAudioContext = new OfflineAudioContext(2, frameCount, sampleRate)
  let scheduledCount: number = 0

  for (const event of events) {
    const buffer: AudioBuffer | undefined = decodedVoices.get(event.voiceKey)
    if (!buffer || event.maxDurationMs <= 0) continue

    const source: AudioBufferSourceNode = offlineCtx.createBufferSource()
    source.buffer = buffer
    const gain: GainNode = offlineCtx.createGain()
    gain.gain.value = event.volume
    source.connect(gain)
    gain.connect(offlineCtx.destination)

    const startSec: number = Math.max(0, event.startMs / 1000)
    const durationSec: number = Math.max(0.001, event.maxDurationMs / 1000)
    source.start(startSec, 0, durationSec)
    scheduledCount += 1
  }

  if (scheduledCount === 0) return null
  return offlineCtx.startRendering()
}

export function encodeAudioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const channels: number = Math.min(2, Math.max(1, buffer.numberOfChannels))
  const length: number = buffer.length
  const sampleRate: number = buffer.sampleRate
  const bytesPerSample: number = 2
  const blockAlign: number = channels * bytesPerSample
  const dataSize: number = length * blockAlign
  const out: Uint8Array = new Uint8Array(44 + dataSize)
  const view: DataView = new DataView(out.buffer)

  writeAscii(out, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(out, 8, 'WAVE')
  writeAscii(out, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(out, 36, 'data')
  view.setUint32(40, dataSize, true)

  const channelArrays: Float32Array[] = []
  for (let ch = 0; ch < channels; ch += 1) {
    channelArrays.push(buffer.getChannelData(ch))
  }

  let offset: number = 44
  for (let i = 0; i < length; i += 1) {
    for (let ch = 0; ch < channels; ch += 1) {
      const clamped: number = Math.max(-1, Math.min(1, channelArrays[ch][i]))
      const intSample: number =
        clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
      view.setInt16(offset, intSample, true)
      offset += 2
    }
  }

  return out
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    target[offset + i] = text.charCodeAt(i) & 0xff
  }
}
