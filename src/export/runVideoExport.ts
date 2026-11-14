import { Application, Assets, RenderTexture } from 'pixi.js'
import type { ModelRegistry } from '@/modelRegistry/schema'
import type { ProjectAssets } from '@/project/assets'
import { loadPlaybackFontFamily } from '@/settings/fonts'
import type { AppSettings } from '@/settings/types'
import {
  StoryAbortError,
  StoryDispatcher,
  createStoryRuntime,
  preloadStoryModels,
  destroyStoryRuntime,
  resolveBackgroundUrl,
  type StoryModelInstance,
  type StoryRuntime
} from '@/story'
import { isMobileRuntime } from '@/lib/platform'
import { installPixiWebGLStateCache, isSoftwareWebGLRenderer } from '@/lib/glStateCache'
import { ensureSekaiLive2DReady } from '@/lib/live2d'
import { suspendInteractivePixiTickers } from '@/lib/pixiTickerControl'
import type { SnippetData, StoryData } from '@/story/schema'
import {
  OfflineSpeechCoordinator,
  clearExportLipSync,
  decodeProjectVoices,
  mixAudioEventsToBuffer
} from './audioTimeline'
import { estimateStoryDurationMs } from './durationEstimator'
import { probeFfmpegCapabilities } from './exportApi'
import { createFfmpegPipeline, type FfmpegPipeline } from './ffmpegBackend'
import { computeStageFitLayout, splitSubStepDeltas, type StageFitLayout } from './presets'
import {
  createWebCodecsPipeline,
  isWebKitBrowser,
  probeWebCodecsSupport,
  type WebCodecsPipeline
} from './webCodecsBackend'
import type {
  ExportAudioEvent,
  FfmpegCapabilities,
  FinishExportResponse,
  VideoExportConfig,
  VideoExportProgress,
  VideoExportResult
} from './types'

export type RunVideoExportParams = {
  story: StoryData
  assets: ProjectAssets
  modelRegistry: ModelRegistry
  dataPath: string
  projectPath: string
  settings: AppSettings | null
  config: VideoExportConfig
  destinationPath: string
  signal?: AbortSignal
  onProgress?: (progress: VideoExportProgress) => void
}

type ExportPipeline = WebCodecsPipeline | FfmpegPipeline

type ModelUpdateTarget = {
  elapsedTime: number
  deltaTime: number
  parent: unknown
  visible: boolean
  internalModel?: {
    update?: (dt: number, now: number) => void
    motionManager?: {
      loadMotion?: (group: string, index: number) => Promise<unknown>
    }
  }
}

export class VideoExportEngineUnavailableError extends Error {
  readonly code: 'WEBCODECS_AND_FFMPEG_UNAVAILABLE' | 'FFMPEG_UNAVAILABLE' | 'WEBCODECS_UNAVAILABLE'

  constructor(
    code: 'WEBCODECS_AND_FFMPEG_UNAVAILABLE' | 'FFMPEG_UNAVAILABLE' | 'WEBCODECS_UNAVAILABLE',
    message: string
  ) {
    super(message)
    this.name = 'VideoExportEngineUnavailableError'
    this.code = code
  }
}

export async function runVideoExport(params: RunVideoExportParams): Promise<VideoExportResult> {
  const {
    story,
    assets,
    modelRegistry,
    dataPath,
    projectPath,
    settings,
    config,
    destinationPath,
    signal,
    onProgress
  } = params
  const exportStartPerf: number = performance.now()
  const mobileRuntime: boolean = isMobileRuntime()
  const referencedVoices: Set<string> = collectReferencedVoices(story)
  const hasAudioTrack: boolean = referencedVoices.size > 0

  throwIfAborted(signal)

  onProgress?.({
    phase: 'preparing',
    renderedFrames: 0,
    estimatedTotalFrames: Math.max(1, Math.round(config.fps)),
    virtualTimeMs: 0,
    elapsedMs: 0,
    renderElapsedMs: 0,
    fpsSpeed: 0,
    etaMs: null
  })

  // Select backend before allocating WebGL stage or preloading models
  const resolvedEngine: 'webcodecs' | 'ffmpeg' = await selectExportEngine(
    config,
    hasAudioTrack,
    mobileRuntime
  )

  const layout: StageFitLayout = computeStageFitLayout(config.width, config.height)
  const app: Application = new Application()
  const softwareWebGL: boolean = isSoftwareWebGLRenderer()
  const useAntialias: boolean = !softwareWebGL && config.width * config.height < 2560 * 1440
  const progressIntervalMs: number = softwareWebGL || mobileRuntime ? 400 : 100
  const uiYieldIntervalMs: number = softwareWebGL || mobileRuntime ? 250 : 64
  let runtime: StoryRuntime | null = null
  let pipeline: ExportPipeline | null = null
  let renderTarget: RenderTexture | null = null
  const restoreTickers: () => void = suspendInteractivePixiTickers()

  try {
    await ensureSekaiLive2DReady()
    await app.init({
      width: layout.logicalWidth,
      height: layout.logicalHeight,
      resolution: layout.rendererResolution,
      autoDensity: false,
      antialias: useAntialias,
      preference: 'webgl',
      background: '#000000',
      backgroundAlpha: config.transparentAlpha ? 0 : 1
    })
    installPixiWebGLStateCache(app.renderer)
    app.ticker.stop()
    app.ticker.autoStart = false

    // Keep canvas detached from document.body so the browser compositor does not create
    // a live TextureLayer or contend with WebGL rendering on Android DrawFn_DrawGL.
    app.canvas.style.width = `${layout.renderedWidth}px`
    app.canvas.style.height = `${layout.renderedHeight}px`

    throwIfAborted(signal)

    const [fontFamily, decodedVoices, models]: [
      string,
      Map<string, AudioBuffer>,
      StoryModelInstance[]
    ] = await Promise.all([
      loadPlaybackFontFamily(settings, dataPath),
      decodeProjectVoices(projectPath, assets),
      preloadStoryModels({
        app,
        dataPath,
        assets,
        modelRegistry,
        autoUpdate: false
      })
    ])

    throwIfAborted(signal)

    await Promise.all([
      preloadReferencedBackgrounds(story, projectPath, assets),
      preloadReferencedMotions(story, models)
    ])

    throwIfAborted(signal)

    const voiceDurationsMs: Map<string, number> = new Map<string, number>()
    for (const [voiceKey, buffer] of decodedVoices.entries()) {
      voiceDurationsMs.set(voiceKey, buffer.duration * 1000)
    }
    const estimatedDurationMs: number = estimateStoryDurationMs(story, voiceDurationsMs)
    const estimatedTotalFrames: number = Math.max(
      1,
      Math.ceil((estimatedDurationMs / 1000) * config.fps)
    )

    let speechCoordinator: OfflineSpeechCoordinator | null = null
    runtime = createStoryRuntime({
      app,
      dataPath,
      projectPath,
      assets,
      modelRegistry,
      models,
      fontFamily,
      offlineMode: true,
      random: createMulberry32(0x1f2e3d4c),
      speakModel: (speakCtx) =>
        speechCoordinator ? speechCoordinator.speak(speakCtx) : Promise.resolve()
    })

    const clock = runtime.clock
    const scene = runtime.scene
    speechCoordinator = new OfflineSpeechCoordinator(
      decodedVoices,
      (): number => clock.elapsedTimeMs
    )

    if (resolvedEngine === 'webcodecs') {
      const support = await probeWebCodecsSupport(config, hasAudioTrack)
      pipeline = await createWebCodecsPipeline({
        config,
        appCanvas: app.canvas,
        destinationPath,
        hasAudioTrack,
        support
      })
    } else {
      type PixiWebGlRendererLike = {
        gl?: WebGL2RenderingContext
        texture?: {
          getGlSource?: (source: unknown) => { texture?: WebGLTexture } | undefined
        }
        resetState?: () => void
      }
      const glRenderer: PixiWebGlRendererLike = app.renderer as unknown as PixiWebGlRendererLike
      const sharedGl: WebGL2RenderingContext | undefined =
        typeof WebGL2RenderingContext !== 'undefined' &&
        glRenderer.gl instanceof WebGL2RenderingContext
          ? glRenderer.gl
          : undefined
      const getGlSource = glRenderer.texture?.getGlSource

      if (sharedGl && getGlSource) {
        const activeTarget: RenderTexture = RenderTexture.create({
          width: layout.logicalWidth,
          height: layout.logicalHeight,
          resolution: layout.rendererResolution,
          antialias: false
        })
        renderTarget = activeTarget
        pipeline = await createFfmpegPipeline({
          config,
          appCanvas: app.canvas,
          destinationPath,
          sharedGl,
          getSourceTexture: (): WebGLTexture | null => {
            return getGlSource.call(glRenderer.texture, activeTarget.source)?.texture ?? null
          },
          resetRendererState: (): void => {
            glRenderer.resetState?.()
          },
          flipTextureY: false
        })
      } else {
        pipeline = await createFfmpegPipeline({
          config,
          appCanvas: app.canvas,
          destinationPath
        })
      }
    }
    const usedEncoder: string | null = pipeline.selectedEncoder

    throwIfAborted(signal)

    const dispatcher: StoryDispatcher = new StoryDispatcher(runtime, { signal })
    let storyFinished: boolean = false
    let storyError: unknown = null
    const runPromise: Promise<void> = dispatcher
      .run(story)
      .then((): void => {
        storyFinished = true
      })
      .catch((error: unknown): void => {
        storyError = error
        storyFinished = true
      })

    const frameDurationMs: number = 1000 / config.fps
    const frameDurationSec: number = 1 / config.fps
    let renderedFrames: number = 0
    const renderStartPerf: number = performance.now()
    let lastProgressReportPerf: number = renderStartPerf
    let lastUiYieldPerf: number = renderStartPerf

    await settleDispatcher(clock, () => storyFinished, signal)
    await scene.waitForVisualEffectsReady()
    stepAttachedModels(runtime.models.values(), 0)

    if (storyError) throw storyError

    // Render and push frames deterministically
    while (true) {
      throwIfAborted(signal)
      if (storyError) throw storyError

      if (renderTarget) {
        app.renderer.render({
          container: app.stage,
          target: renderTarget,
          clear: true,
          clearColor: config.transparentAlpha ? [0, 0, 0, 0] : [0, 0, 0, 1]
        })
      } else {
        app.renderer.render(app.stage)
      }
      if (pipeline.engineUsed === 'webcodecs') {
        await pipeline.pushFrame(renderedFrames / config.fps, frameDurationSec)
      } else {
        await pipeline.pushFrame()
      }
      renderedFrames += 1

      const nowPerf: number = performance.now()
      if (nowPerf - lastProgressReportPerf >= progressIntervalMs || storyFinished) {
        const renderElapsedMs: number = Math.max(1, nowPerf - renderStartPerf)
        const fpsSpeed: number = (renderedFrames * 1000) / renderElapsedMs
        const currentEstimatedTotal: number = Math.max(renderedFrames, estimatedTotalFrames)
        const remainingFrames: number = Math.max(0, currentEstimatedTotal - renderedFrames)
        const etaMs: number | null = fpsSpeed > 0.01 ? (remainingFrames / fpsSpeed) * 1000 : null

        onProgress?.({
          phase: 'rendering',
          renderedFrames,
          estimatedTotalFrames: currentEstimatedTotal,
          virtualTimeMs: clock.elapsedTimeMs,
          elapsedMs: nowPerf - exportStartPerf,
          renderElapsedMs,
          fpsSpeed,
          etaMs
        })
        lastProgressReportPerf = nowPerf
      }

      if (nowPerf - lastUiYieldPerf >= uiYieldIntervalMs) {
        await yieldToBrowser()
        lastUiYieldPerf = performance.now()
      }

      if (storyFinished) {
        break
      }

      const subSteps: number[] = splitSubStepDeltas(frameDurationMs)
      for (const subMs of subSteps) {
        throwIfAborted(signal)
        if (storyError) throw storyError

        speechCoordinator.updateAt(clock.elapsedTimeMs)
        clock.step(subMs)
        await settleDispatcher(clock, () => storyFinished, signal)
        if (storyError) throw storyError

        const vfxReady: Promise<void> | void = scene.waitForVisualEffectsReady()
        if (vfxReady) await vfxReady
        scene.stepVisualEffects(subMs)
        stepAttachedModels(runtime.models.values(), subMs)
      }
    }

    await runPromise
    if (storyError) throw storyError

    const totalVideoDurationMs: number = Math.max(
      renderedFrames * frameDurationMs,
      clock.elapsedTimeMs
    )
    const audioEvents: readonly ExportAudioEvent[] =
      speechCoordinator.finalizeAll(totalVideoDurationMs)
    for (const { model } of runtime.models.values()) {
      clearExportLipSync(model)
    }

    onProgress?.({
      phase: 'encodingAudio',
      renderedFrames,
      estimatedTotalFrames: renderedFrames,
      virtualTimeMs: totalVideoDurationMs,
      elapsedMs: performance.now() - exportStartPerf,
      renderElapsedMs: performance.now() - renderStartPerf,
      fpsSpeed: (renderedFrames * 1000) / Math.max(1, performance.now() - renderStartPerf),
      etaMs: null
    })

    const mixedAudio: AudioBuffer | null = hasAudioTrack
      ? await mixAudioEventsToBuffer(audioEvents, decodedVoices, totalVideoDurationMs)
      : null

    throwIfAborted(signal)

    onProgress?.({
      phase: 'muxing',
      renderedFrames,
      estimatedTotalFrames: renderedFrames,
      virtualTimeMs: totalVideoDurationMs,
      elapsedMs: performance.now() - exportStartPerf,
      renderElapsedMs: performance.now() - renderStartPerf,
      fpsSpeed: (renderedFrames * 1000) / Math.max(1, performance.now() - renderStartPerf),
      etaMs: null
    })

    const finishResponse: FinishExportResponse = await pipeline.finalize(mixedAudio)
    pipeline = null

    onProgress?.({
      phase: 'completed',
      renderedFrames,
      estimatedTotalFrames: renderedFrames,
      virtualTimeMs: totalVideoDurationMs,
      elapsedMs: performance.now() - exportStartPerf,
      renderElapsedMs: performance.now() - renderStartPerf,
      fpsSpeed: (renderedFrames * 1000) / Math.max(1, performance.now() - renderStartPerf),
      etaMs: 0
    })

    return {
      outputPath: finishResponse.outputPath,
      fileSizeBytes: finishResponse.fileSizeBytes,
      totalFrames: renderedFrames,
      durationMs: totalVideoDurationMs,
      engineUsed: resolvedEngine,
      selectedEncoder: usedEncoder
    }
  } catch (error: unknown) {
    if (pipeline) {
      await pipeline.abort().catch((): void => undefined)
      pipeline = null
    }
    throw error
  } finally {
    if (pipeline) {
      await pipeline.abort().catch((): void => undefined)
    }
    if (runtime) {
      destroyStoryRuntime(runtime)
    }
    if (renderTarget) {
      try {
        renderTarget.destroy(true)
      } catch {
        // Ignore cleanup errors if render target destroy fails
      }
    }
    try {
      app.destroy(true, { children: true, texture: true, textureSource: true })
    } catch {
      // Ignore cleanup errors if init failed partway
    }
    restoreTickers()
  }
}

async function selectExportEngine(
  config: VideoExportConfig,
  hasAudioTrack: boolean,
  mobileRuntime: boolean
): Promise<'webcodecs' | 'ffmpeg'> {
  const requiresFfmpegOnly: boolean =
    config.videoCodec === 'prores' || config.audioCodec === 'pcm_s16le'

  if (config.engineMode === 'ffmpeg') {
    if (mobileRuntime) {
      throw new VideoExportEngineUnavailableError('FFMPEG_UNAVAILABLE', 'FFmpeg 仅支持桌面端运行')
    }
    const caps: FfmpegCapabilities = await probeFfmpegCapabilities(config.ffmpegPath)
    if (!caps.available) {
      throw new VideoExportEngineUnavailableError(
        'FFMPEG_UNAVAILABLE',
        '未检测到可用的 FFmpeg 可执行文件'
      )
    }
    return 'ffmpeg'
  }

  const webCodecsStatus = requiresFfmpegOnly
    ? { supported: false, reason: 'Codec requires FFmpeg' }
    : await probeWebCodecsSupport(config, hasAudioTrack)

  if (config.engineMode === 'webcodecs') {
    if (!webCodecsStatus.supported) {
      throw new VideoExportEngineUnavailableError(
        'WEBCODECS_UNAVAILABLE',
        webCodecsStatus.reason ?? 'WebCodecs 不支持当前导出参数'
      )
    }
    return 'webcodecs'
  }

  // On desktop WebKit (macOS WKWebView), WebCodecs HEVC/H.264 suffers severe throughput limits at 4K;
  // prefer the native FFmpeg pipeline whenever available.
  if (!mobileRuntime && isWebKitBrowser()) {
    const caps: FfmpegCapabilities = await probeFfmpegCapabilities(config.ffmpegPath)
    if (caps.available) {
      return 'ffmpeg'
    }
  }

  // 'auto': prefer WebCodecs zero-readback GPU encoding first on non-WebKit platforms
  if (webCodecsStatus.supported) {
    return 'webcodecs'
  }

  if (!mobileRuntime) {
    const caps: FfmpegCapabilities = await probeFfmpegCapabilities(config.ffmpegPath)
    if (caps.available) {
      return 'ffmpeg'
    }
  }

  throw new VideoExportEngineUnavailableError(
    'WEBCODECS_AND_FFMPEG_UNAVAILABLE',
    webCodecsStatus.reason ?? 'WebCodecs 与 FFmpeg 均不支持当前导出配置'
  )
}

function collectReferencedVoices(story: StoryData): Set<string> {
  const voices: Set<string> = new Set<string>()
  const walk = (snippets: readonly SnippetData[]): void => {
    for (const snippet of snippets) {
      if (snippet.type === 'Parallel') {
        walk(snippet.snippets)
      } else if (snippet.type === 'Talk' && snippet.data.voice) {
        voices.add(snippet.data.voice)
      }
    }
  }
  walk(story.snippets)
  return voices
}

async function preloadReferencedBackgrounds(
  story: StoryData,
  projectPath: string,
  assets: ProjectAssets
): Promise<void> {
  const bgKeys: Set<string> = new Set<string>()
  const walk = (snippets: readonly SnippetData[]): void => {
    for (const snippet of snippets) {
      if (snippet.type === 'Parallel') {
        walk(snippet.snippets)
      } else if (snippet.type === 'ChangeBackgroundImage') {
        bgKeys.add(snippet.data.background)
      }
    }
  }
  walk(story.snippets)

  await Promise.all(
    [...bgKeys].map(async (key: string): Promise<void> => {
      if (!assets.backgrounds[key]) return
      const resolved = resolveBackgroundUrl(projectPath, assets, key)
      await Assets.load(resolved.url)
    })
  )
}

async function preloadReferencedMotions(
  story: StoryData,
  models: readonly StoryModelInstance[]
): Promise<void> {
  const byModel: Map<string, Set<string>> = new Map<string, Set<string>>()
  const record = (modelKey: string, motion?: string, facial?: string): void => {
    let groups: Set<string> | undefined = byModel.get(modelKey)
    if (!groups) {
      groups = new Set<string>()
      byModel.set(modelKey, groups)
    }
    if (motion) groups.add(motion)
    if (facial) groups.add(facial)
  }

  const walk = (snippets: readonly SnippetData[]): void => {
    for (const snippet of snippets) {
      if (snippet.type === 'Parallel') {
        walk(snippet.snippets)
      } else if (snippet.type === 'LayoutAppear' || snippet.type === 'Motion') {
        record(snippet.data.model, snippet.data.motion, snippet.data.facial)
      }
    }
  }
  walk(story.snippets)

  const tasks: Promise<unknown>[] = []
  for (const instance of models) {
    const groups: Set<string> | undefined = byModel.get(instance.key)
    if (!groups) continue
    const target = instance.model as unknown as ModelUpdateTarget
    const loader = target.internalModel?.motionManager?.loadMotion
    if (!loader) continue
    for (const group of groups) {
      tasks.push(
        loader.call(target.internalModel?.motionManager, group, 0).catch((): void => undefined)
      )
    }
  }
  await Promise.all(tasks)
}

async function settleDispatcher(
  clock: StoryRuntime['clock'],
  isFinished: () => boolean,
  signal?: AbortSignal
): Promise<void> {
  await flushMicrotasks(2)
  let zeroTaskYields: number = 0
  while (!isFinished() && clock.activeTaskCount === 0) {
    throwIfAborted(signal)
    if (zeroTaskYields < 4) {
      await yieldToBrowser()
    } else {
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 1)
      })
    }
    zeroTaskYields += 1
    await flushMicrotasks(4)
  }
}

async function flushMicrotasks(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve()
  }
}

const yieldChannel: MessageChannel | null =
  typeof MessageChannel !== 'undefined' ? new MessageChannel() : null

function yieldToBrowser(): Promise<void> {
  if (yieldChannel) {
    return new Promise<void>((resolve: () => void): void => {
      yieldChannel.port1.onmessage = (): void => {
        resolve()
      }
      yieldChannel.port2.postMessage(null)
    })
  }
  return new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 0)
  })
}

function stepAttachedModels(instances: Iterable<StoryModelInstance>, deltaMs: number): void {
  for (const instance of instances) {
    const model = instance.model as unknown as ModelUpdateTarget
    if (!model.parent || !model.visible || !model.internalModel?.update) continue
    model.elapsedTime += deltaMs
    model.deltaTime = 0
    model.internalModel.update(deltaMs, model.elapsedTime)
  }
}

function createMulberry32(seed: number): () => number {
  let state: number = seed >>> 0
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t: number = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new StoryAbortError('Video export aborted')
  }
}
