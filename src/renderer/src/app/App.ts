import '@pixi/unsafe-eval'
import getSubLogger from '../utils/Logger'
import { ILogObj, Logger } from 'tslog'
import { SelectStoryResponse } from '../../../common/types/IpcResponse'
import { SnippetData } from '../../../common/types/Story'
import StoryManager from '../managers/StoryManager'
import { Live2DModelMap, TextureMap } from '../types/AssetMap'
import BackgroundLayer from '../layers/BackgroundLayer'
import ModelLayer from '../layers/ModelLayer'
import AdvancedModel from '../model/AdvancedModel'
import SnippetStrategyManager from '../managers/SnippetStrategyManager'
import UILayer from '../layers/UILayer'
import FontFaceObserver from 'fontfaceobserver'
import { Application, Texture } from 'pixi.js'
import SpecialEffectLayer from '../layers/SpecialEffectLayer'
import { configureCubism4 } from 'pixi-live2d-display-advanced'
import AnimationManager from '../managers/AnimationManager'
import {
  FinishFrameExportResponse,
  FrameExportProgressPayload,
  ProbeStoryVoiceDurationsResponse,
  RenderAudioEvent
} from '../../../common/types/FrameExport'

export type RunMode = 'preview' | 'render'

type RenderProgressPhase = 'preparing' | 'rendering' | 'merging' | 'done' | 'error'

interface SelectExportDirectoryResponse {
  canceled: boolean
  path?: string
}

interface StartFrameExportResponse {
  success: boolean
  outputDir: string
}

interface RenderProgressState {
  phase: RenderProgressPhase
  fps?: number
  frameIndex?: number
  totalFrameCount?: number
  virtualTimeMs?: number
  totalDurationMs?: number
  snippetIndex?: number
  snippetTotal?: number
  audioClipCount?: number
  outputDir?: string | null
  ffmpegPercent?: number
  percent?: number
  elapsedRenderMs?: number
  etaMs?: number | null
  message?: string
}

export class App {
  public readonly logger: Logger<ILogObj> = getSubLogger('App')
  public pixiApplication!: Application
  public storyManager!: StoryManager
  public snippetStrategyManager!: SnippetStrategyManager
  public runMode: RunMode = 'preview'
  private applicationWrapper!: HTMLDivElement

  public layerBackground!: BackgroundLayer
  public layerModel!: ModelLayer
  public layerUI!: UILayer
  public layerSpecialEffect!: SpecialEffectLayer

  private models: Live2DModelMap[] = []
  private textures: TextureMap[] = []
  private exportRootDirectory: string | null = null
  private exportOutputDirectory: string | null = null
  private currentSnippetIndex = 0
  private totalSnippetCount = 0
  private renderAudioEvents: RenderAudioEvent[] = []
  private renderVoiceDurations: Map<string, number> = new Map()
  private frameExportProgressRegistered = false
  private renderFps = 60
  private estimatedRenderDurationMs = 0
  private estimatedRenderFrameCount = 0
  private renderStartedAtMs = 0

  private async selectStoryFile(): Promise<SelectStoryResponse> {
    const selectResult: SelectStoryResponse = await window.electron.ipcRenderer.invoke(
      'electron:select-story-file-until-selected'
    )

    if (!selectResult.success) {
      if (selectResult.zodIssueMessage) {
        throw new Error(selectResult.zodIssueMessage)
      } else {
        throw selectResult.error
      }
    }

    return selectResult
  }

  private async selectStoryFileUntilSuccess(): Promise<SelectStoryResponse> {
    let selectResult: SelectStoryResponse

    let selectFileValid = false
    while (!selectFileValid) {
      try {
        selectResult = await this.selectStoryFile()
        selectFileValid = true
      } catch (error) {
        this.logger.error(error)
        throw error
      }
    }

    return selectResult!
  }

  private async selectExportDirectory(): Promise<string | null> {
    const result = (await window.electron.ipcRenderer.invoke(
      'electron:select-export-directory'
    )) as SelectExportDirectoryResponse

    if (result.canceled || !result.path) return null

    return result.path
  }

  private async initializeManagers(story: SelectStoryResponse): Promise<void> {
    this.storyManager = new StoryManager(story)
    this.logger.info(`StoryManager initialized, root path: ${this.storyManager.storyFolder}`)

    this.snippetStrategyManager = new SnippetStrategyManager(this)
    this.logger.info('SnippetStrategyManager initialized')
  }

  private initializeRenderer(options: { scale: number; runMode: RunMode }): void {
    this.applicationWrapper = document.getElementById('app')! as HTMLDivElement

    const renderMode = options.runMode === 'render'

    this.pixiApplication = new Application({
      backgroundColor: 0xffffff,
      resizeTo: this.applicationWrapper,
      autoDensity: true,
      antialias: true,
      resolution: options.scale,
      autoStart: !renderMode,
      preserveDrawingBuffer: renderMode
    })

    if (renderMode) {
      this.pixiApplication.stop()
      this.pixiApplication.ticker.autoStart = false
      this.pixiApplication.ticker.maxFPS = 0
    } else {
      this.pixiApplication.ticker.maxFPS = 60
    }

    this.applicationWrapper.appendChild(this.pixiApplication.view as HTMLCanvasElement)

    this.pixiApplication.stage.sortableChildren = true

    configureCubism4({
      memorySizeMB: 128
    })

    this.logger.info('Render initialized')
  }

  get stage_size(): [number, number] {
    return [this.pixiApplication.screen.width, this.pixiApplication.screen.height]
  }

  private async preloadStoryAssets(): Promise<void> {
    this.models = await this.storyManager.preloadModels(this.pixiApplication.ticker)
    this.logger.info(`Loaded ${this.models.length} models`)

    this.textures = await this.storyManager.preloadImages()
    this.logger.info(`Loaded ${this.textures.length} textures`)

    await new FontFaceObserver('Source Han Sans SC', {}).load()
    this.logger.info(`Loaded fonts.`)

    this.logger.info('Preloaded story assets')
  }

  private initializeLayers(): void {
    this.layerBackground = new BackgroundLayer(this.pixiApplication)
    this.layerModel = new ModelLayer(this.pixiApplication)
    this.layerUI = new UILayer(this.pixiApplication)
    this.layerSpecialEffect = new SpecialEffectLayer(this.pixiApplication)
  }

  private async readUntilFinish(): Promise<void> {
    const snippets = this.storyManager.snippets
    this.totalSnippetCount = snippets.length

    for (let i = 0; i < snippets.length; i++) {
      const snippet = snippets[i]
      this.currentSnippetIndex = i + 1
      this.logger.info(`Snippet ${i + 1}/${snippets.length}: ${snippet.type}`)

      await this.snippetStrategyManager.handleSnippet(snippet)
    }
  }

  public getTextureById(id: number): Texture {
    const data = this.textures

    return data.find((image) => image.id === id)!.image
  }

  public getModelById(id: number): AdvancedModel {
    const data = this.models

    return data.find((model) => model.id === id)!.model
  }

  public getVoiceByName(name: string): string {
    return this.storyManager.geVoiceUrlByName(name)
  }

  public addRenderAudioEvent(event: RenderAudioEvent): void {
    this.renderAudioEvents.push(event)
  }

  public getRenderVoiceDurationMs(voice: string): number {
    const duration = this.renderVoiceDurations.get(voice)
    if (duration === undefined) {
      throw new Error(`Voice duration has not been probed: ${voice}`)
    }

    return duration
  }

  private collectRenderVoices(): string[] {
    const voices = new Set<string>()

    for (const snippet of this.storyManager.snippets) {
      if (snippet.type === 'Talk' && snippet.data.voice !== '') {
        voices.add(snippet.data.voice)
      }
    }

    return Array.from(voices)
  }

  private async prepareRenderVoiceDurations(): Promise<void> {
    const voices = this.collectRenderVoices()
    this.renderVoiceDurations.clear()

    if (voices.length === 0) return

    this.updateRenderProgress({
      phase: 'preparing',
      audioClipCount: 0,
      message: `Probing ${voices.length} voice file(s)...`
    })

    const result = (await window.electron.ipcRenderer.invoke(
      'electron:probe-story-voice-durations',
      {
        storyPath: this.storyManager.storyJsonPath,
        voices
      }
    )) as ProbeStoryVoiceDurationsResponse

    this.renderVoiceDurations = new Map(
      Object.entries(result.durations).map(([voice, durationMs]) => [voice, Number(durationMs)])
    )
  }

  private moveSpeedToDurationMs(speed: string): number {
    return (
      {
        Slow: 700,
        Normal: 500,
        Fast: 300,
        Immediate: 0
      }[speed] ?? 0
    )
  }

  private estimateSnippetDurationMs(snippet: SnippetData): number {
    switch (snippet.type) {
      case 'ChangeLayoutMode':
      case 'ChangeBackgroundImage':
      case 'HideTalk':
        return snippet.type === 'HideTalk' ? 100 : 0
      case 'LayoutAppear':
        return Math.max(200, this.moveSpeedToDurationMs(snippet.data.moveSpeed))
      case 'LayoutClear':
        return Math.max(50, this.moveSpeedToDurationMs(snippet.data.moveSpeed))
      case 'Talk': {
        const textDurationMs = snippet.data.content.length * 70
        const voiceDurationMs =
          snippet.data.voice === '' ? 0 : (this.renderVoiceDurations.get(snippet.data.voice) ?? 0)
        return Math.max(textDurationMs, voiceDurationMs)
      }
      case 'Move':
        return this.moveSpeedToDurationMs(snippet.data.moveSpeed)
      case 'Motion':
        return 1000
      case 'Telop':
        return 2400
      case 'BlackOut':
      case 'BlackIn':
        return snippet.data.duration * 1000
      case 'DoParam':
        return Math.max(...snippet.data.params.map((param) => param.duration * 1000), 0)
    }

    return 0
  }

  private estimateRenderDuration(): number {
    let mainTimeMs = 0
    const pendingEndTimes: number[] = []

    for (const snippet of this.storyManager.snippets) {
      const startTimeMs = mainTimeMs + snippet.delay * 1000
      const endTimeMs = startTimeMs + this.estimateSnippetDurationMs(snippet)

      if (snippet.wait) {
        mainTimeMs = endTimeMs
      } else {
        pendingEndTimes.push(endTimeMs)
      }
    }

    return Math.max(mainTimeMs, ...pendingEndTimes, 1)
  }

  private formatSeconds(ms: number): string {
    return `${Math.max(0, Math.ceil(ms / 1000))}s`
  }

  private showRenderProgress(): void {
    const element = document.getElementById('renderProgress')! as HTMLDivElement
    element.hidden = false
  }

  private updateRenderProgress(state: RenderProgressState): void {
    const phaseElement = document.getElementById('renderProgressPhase')! as HTMLParagraphElement
    const fpsElement = document.getElementById('renderProgressFps')! as HTMLParagraphElement
    const frameElement = document.getElementById('renderProgressFrame')! as HTMLParagraphElement
    const timeElement = document.getElementById('renderProgressTime')! as HTMLParagraphElement
    const percentElement = document.getElementById('renderProgressPercent')! as HTMLParagraphElement
    const elapsedElement = document.getElementById('renderProgressElapsed')! as HTMLParagraphElement
    const etaElement = document.getElementById('renderProgressEta')! as HTMLParagraphElement
    const snippetElement = document.getElementById('renderProgressSnippet')! as HTMLParagraphElement
    const audioElement = document.getElementById('renderProgressAudio')! as HTMLParagraphElement
    const outputElement = document.getElementById('renderProgressOutput')! as HTMLParagraphElement
    const ffmpegElement = document.getElementById('renderProgressFfmpeg')! as HTMLParagraphElement

    const fps = state.fps ?? this.renderFps
    const frameIndex = state.frameIndex ?? 0
    const totalFrameCount = state.totalFrameCount ?? this.estimatedRenderFrameCount
    const virtualTimeMs = state.virtualTimeMs ?? 0
    const totalDurationMs = state.totalDurationMs ?? this.estimatedRenderDurationMs
    const displayTotalFrameCount = Math.max(totalFrameCount, frameIndex)
    const displayTotalDurationMs = Math.max(totalDurationMs, virtualTimeMs)
    const snippetIndex = state.snippetIndex ?? this.currentSnippetIndex
    const snippetTotal = state.snippetTotal ?? this.totalSnippetCount
    const audioClipCount = state.audioClipCount ?? this.renderAudioEvents.length
    const outputDir = state.outputDir ?? this.exportOutputDirectory ?? '-'
    const ffmpegPercent = state.ffmpegPercent
    const percent =
      state.percent ??
      (displayTotalFrameCount > 0
        ? Math.min(frameIndex / Math.max(displayTotalFrameCount, 1), 1)
        : 0)
    const elapsedRenderMs =
      state.elapsedRenderMs ??
      (this.renderStartedAtMs === 0 ? 0 : performance.now() - this.renderStartedAtMs)
    const etaMs =
      state.etaMs ??
      (frameIndex > 0 && displayTotalFrameCount > 0
        ? (elapsedRenderMs / frameIndex) * Math.max(displayTotalFrameCount - frameIndex, 0)
        : null)

    phaseElement.textContent = `Phase: ${state.phase}${state.message ? ` - ${state.message}` : ''}`
    fpsElement.textContent = `FPS: ${fps}`
    frameElement.textContent = `Frames: ${frameIndex} / ${displayTotalFrameCount}`
    timeElement.textContent = `Time: ${this.formatSeconds(virtualTimeMs)} / ${this.formatSeconds(
      displayTotalDurationMs
    )}`
    percentElement.textContent = `Progress: ${(percent * 100).toFixed(1)}%`
    elapsedElement.textContent = `Rendered elapsed: ${this.formatSeconds(elapsedRenderMs)}`
    etaElement.textContent = `ETA: ${etaMs === null ? '-' : this.formatSeconds(etaMs)}`
    snippetElement.textContent = `Snippet: ${snippetIndex} / ${snippetTotal}`
    audioElement.textContent = `Audio clips: ${audioClipCount}`
    outputElement.textContent = `Output: ${outputDir}`
    ffmpegElement.textContent = `FFmpeg: ${
      ffmpegPercent === undefined ? '-' : `${(ffmpegPercent * 100).toFixed(1)}%`
    }`
  }

  private registerFrameExportProgressListener(): void {
    if (this.frameExportProgressRegistered) return

    this.frameExportProgressRegistered = true
    window.electron.ipcRenderer.on(
      'electron:frame-export-progress',
      (_event, payload: FrameExportProgressPayload) => {
        this.updateRenderProgress({
          phase: 'merging',
          ffmpegPercent: payload.percent,
          message: payload.message,
          outputDir: this.exportOutputDirectory
        })
      }
    )
  }

  private async runPreviewMode(): Promise<void> {
    AnimationManager.setMode('realtime')
    await this.readUntilFinish()
  }

  private async runRenderMode(): Promise<void> {
    if (!this.exportRootDirectory) {
      throw new Error('Export directory is not selected.')
    }

    const fps = 60
    this.renderFps = fps
    const frameMs = 1000 / fps
    let frameIndex = 0
    let virtualTime = 0
    let storyFinished = false

    this.showRenderProgress()
    this.registerFrameExportProgressListener()
    this.renderAudioEvents = []
    this.currentSnippetIndex = 0
    this.totalSnippetCount = this.storyManager.snippets.length
    this.updateRenderProgress({ phase: 'preparing', message: 'Preparing render...' })

    await this.prepareRenderVoiceDurations()
    this.estimatedRenderDurationMs = this.estimateRenderDuration()
    this.estimatedRenderFrameCount = Math.max(
      1,
      Math.ceil(this.estimatedRenderDurationMs / frameMs)
    )
    this.renderStartedAtMs = performance.now()
    this.updateRenderProgress({
      phase: 'preparing',
      fps,
      totalFrameCount: this.estimatedRenderFrameCount,
      totalDurationMs: this.estimatedRenderDurationMs,
      message: 'Preparing ticker...'
    })

    AnimationManager.setMode('manual')
    AnimationManager.bindTicker(this.pixiApplication.ticker)
    AnimationManager.setManualTime(virtualTime)

    this.pixiApplication.ticker.update(virtualTime)

    const startResult = (await window.electron.ipcRenderer.invoke('electron:start-frame-export', {
      storyPath: this.storyManager.storyJsonPath,
      outputRoot: this.exportRootDirectory,
      fps,
      width: this.pixiApplication.screen.width,
      height: this.pixiApplication.screen.height
    })) as StartFrameExportResponse

    if (!startResult.success) {
      throw new Error('Failed to start frame export.')
    }

    this.exportOutputDirectory = startResult.outputDir
    this.logger.info(`Frame export started: ${this.exportOutputDirectory}`)
    this.updateRenderProgress({
      phase: 'rendering',
      fps,
      totalFrameCount: this.estimatedRenderFrameCount,
      totalDurationMs: this.estimatedRenderDurationMs,
      outputDir: this.exportOutputDirectory,
      message: 'Rendering frames...'
    })

    const storyTask = this.readUntilFinish().finally(() => {
      storyFinished = true
    })

    do {
      virtualTime += frameMs
      AnimationManager.setManualTime(virtualTime)

      this.pixiApplication.ticker.update(virtualTime)
      await Promise.resolve()
      this.pixiApplication.render()

      await this.saveCurrentFrame(frameIndex)

      if (frameIndex % 10 === 0) {
        this.updateRenderProgress({
          phase: 'rendering',
          fps,
          frameIndex: frameIndex + 1,
          totalFrameCount: this.estimatedRenderFrameCount,
          virtualTimeMs: virtualTime,
          totalDurationMs: this.estimatedRenderDurationMs,
          snippetIndex: this.currentSnippetIndex,
          snippetTotal: this.totalSnippetCount,
          audioClipCount: this.renderAudioEvents.length,
          outputDir: this.exportOutputDirectory
        })
      }

      frameIndex++
    } while (
      !storyFinished ||
      this.snippetStrategyManager.hasPendingTasks() ||
      AnimationManager.hasTrackedTasks()
    )

    await storyTask

    this.updateRenderProgress({
      phase: 'merging',
      fps,
      frameIndex,
      totalFrameCount: frameIndex,
      virtualTimeMs: frameIndex * frameMs,
      totalDurationMs: frameIndex * frameMs,
      percent: 1,
      etaMs: 0,
      audioClipCount: this.renderAudioEvents.length,
      outputDir: this.exportOutputDirectory,
      message: 'Merging frames with FFmpeg...'
    })

    const finishResult = (await window.electron.ipcRenderer.invoke('electron:finish-frame-export', {
      frameCount: frameIndex,
      fps,
      totalDurationMs: frameIndex * frameMs,
      audioEvents: this.renderAudioEvents
    })) as FinishFrameExportResponse

    this.logger.info('Frame export finished', finishResult)
    this.updateRenderProgress({
      phase: 'done',
      fps,
      frameIndex,
      totalFrameCount: frameIndex,
      virtualTimeMs: frameIndex * frameMs,
      totalDurationMs: frameIndex * frameMs,
      percent: 1,
      etaMs: 0,
      audioClipCount: this.renderAudioEvents.length,
      outputDir: finishResult.outputDir,
      ffmpegPercent: finishResult.videoPath ? 1 : undefined,
      message: finishResult.videoPath ? `Video saved: ${finishResult.videoPath}` : 'Frames saved.'
    })
    AnimationManager.setMode('realtime')
  }

  private async saveCurrentFrame(index: number): Promise<void> {
    const canvas = this.pixiApplication.view as HTMLCanvasElement

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (!value) {
          reject(new Error('Failed to encode frame.'))
          return
        }

        resolve(value)
      }, 'image/png')
    })

    const buffer = await blob.arrayBuffer()

    await window.electron.ipcRenderer.invoke('electron:save-frame', {
      index,
      buffer
    })
  }

  private async runSnippets(
    story: SelectStoryResponse,
    options: {
      scale: number
      runMode: RunMode
    }
  ): Promise<void> {
    this.runMode = options.runMode
    await this.initializeManagers(story)
    this.initializeRenderer({ scale: options.scale, runMode: options.runMode })
    await this.preloadStoryAssets()
    this.initializeLayers()

    if (options.runMode === 'preview') {
      await this.runPreviewMode()
    } else {
      await this.runRenderMode()
    }
  }

  public async run(): Promise<void> {
    const selectFileTipsElement = document.getElementById('select-file-tips')! as HTMLHeadingElement
    const story: SelectStoryResponse = await this.selectStoryFileUntilSuccess()
    selectFileTipsElement.remove()

    const app_element = document.getElementById('app')! as HTMLDivElement
    const config_element = document.getElementById('config')! as HTMLDivElement
    const apply_btn = document.getElementById('apply')! as HTMLButtonElement
    const resolutionSelect = document.getElementById('resolution')! as HTMLSelectElement
    const renderScaleSelect = document.getElementById('renderScale')! as HTMLSelectElement
    const runModeSelect = document.getElementById('runMode')! as HTMLSelectElement
    const exportDirectoryControls = document.getElementById(
      'exportDirectoryControls'
    )! as HTMLDivElement
    const selectExportDirectoryButton = document.getElementById(
      'selectExportDirectory'
    )! as HTMLButtonElement
    const exportDirectoryPath = document.getElementById(
      'exportDirectoryPath'
    )! as HTMLParagraphElement

    const updateExportDirectoryControls = (): void => {
      exportDirectoryControls.hidden = runModeSelect.value !== 'render'
    }

    runModeSelect.addEventListener('change', updateExportDirectoryControls)
    updateExportDirectoryControls()

    selectExportDirectoryButton.addEventListener('click', async () => {
      const directory = await this.selectExportDirectory()
      if (!directory) return

      this.exportRootDirectory = directory
      exportDirectoryPath.textContent = directory
    })

    apply_btn.addEventListener('click', async () => {
      try {
        const resolutionValue = resolutionSelect.value
        const renderScaleValue = parseFloat(renderScaleSelect.value)
        const runMode = runModeSelect.value as RunMode

        if (runMode === 'render' && !this.exportRootDirectory) {
          const directory = await this.selectExportDirectory()
          if (!directory) return

          this.exportRootDirectory = directory
          exportDirectoryPath.textContent = directory
        }

        const width = resolutionValue.split('x')[0]
        const height = resolutionValue.split('x')[1]
        window.electron.ipcRenderer.send('electron:resize', parseInt(width), parseInt(height))
        app_element.hidden = false

        config_element.remove()
        await this.runSnippets(story, {
          scale: renderScaleValue,
          runMode
        })
      } catch (error) {
        if (this.runMode === 'render') {
          this.updateRenderProgress({
            phase: 'error',
            message: error instanceof Error ? error.message : String(error),
            outputDir: this.exportOutputDirectory
          })
        }
        throw error
      }
    })
    config_element.hidden = false
  }
}

async function main(): Promise<void> {
  const app = new App()
  await app.run()
}

export default main
