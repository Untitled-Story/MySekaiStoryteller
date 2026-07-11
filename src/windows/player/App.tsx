import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useEffect, useRef, useState, useMemo } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { Application } from 'pixi.js'
import { useWindowProjectName } from '@/windows/useWindowProjectName'
import { ensureSekaiLive2DReady } from '@/lib/live2d'
import {
  createStoryRuntime,
  destroyStoryRuntime,
  preloadStoryModels,
  StoryDispatcher,
  StoryModelPreloadError,
  StorySnippetError,
  type StoryData,
  type StoryModelInstance,
  type StoryRuntime
} from '@/story'
import { timeManager } from '@/story/timeManager'
import { getProjectStory } from '@/story/api'
import type { ProjectMetadata } from '@/project/metadata'
import type { ProjectAssets } from '@/project/assets'
import { getProjectAssets, getProjectMetadata, getProjectPath } from '@/project/api'
import type { ModelRegistry } from '@/modelRegistry/schema'
import { getModelRegistry } from '@/modelRegistry/api'
import { getSettings } from '@/settings/api'
import type { AppSettings, RenderPrecision } from '@/settings/types'
import { loadPlaybackFontFamily } from '@/settings/fonts'
import { getDataPath } from '@/workspace/api'

export type PlayerStoryInput = {
  projectName: string
  dataPath: string
  projectPath: string
  metadata: ProjectMetadata
  settings: AppSettings | null
  modelRegistry: ModelRegistry
  assets: ProjectAssets
  story: StoryData
}

type LoadState =
  | { status: 'idle' | 'loading'; error?: never }
  | { status: 'ready'; error?: never }
  | { status: 'error'; error: string }

type ModelLoadState =
  | { status: 'idle' | 'loading' | 'ready'; message?: string; error?: never }
  | { status: 'empty'; message: string; error?: never }
  | { status: 'error'; message?: never; error: string }

export default function App(): JSX.Element {
  const projectName = useWindowProjectName()
  const searchParams = new URLSearchParams(window.location.search)
  const render = searchParams.get('render') === 'true'
  const renderConfigRaw = searchParams.get('renderConfig')
  
  const renderConfig = useMemo(() => {
    if (!renderConfigRaw) return null
    try {
      return JSON.parse(decodeURIComponent(renderConfigRaw))
    } catch (e) {
      console.error('Failed to parse renderConfig', e)
      return null
    }
  }, [renderConfigRaw])

  useEffect(() => {
    if (render && renderConfig) {
      console.log('Render Mode Active. Config:', renderConfig)
    }
  }, [render, renderConfig])

  const stageRef = useRef<HTMLDivElement | null>(null)
  const [storyInput, setStoryInput] = useState<PlayerStoryInput | null>(null)
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' })
  const [modelLoadState, setModelLoadState] = useState<ModelLoadState>({ status: 'idle' })
  const [renderStats, setRenderStats] = useState({
    progress: 0,
    frameCount: 0,
    totalFrames: 0,
    currentTime: 0,
    totalDuration: 0,
    fps: 0,
    speed: 1
  })

  useEffect(() => {
    const currentWindow = getCurrentWindow()

    function closeOnShortcut(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== 'w') return
      if (!event.metaKey && !event.ctrlKey) return

      event.preventDefault()
      void currentWindow.close().catch((error: unknown) => {
        console.error('Failed to close player window', error)
      })
    }

    window.addEventListener('keydown', closeOnShortcut, true)
    return () => window.removeEventListener('keydown', closeOnShortcut, true)
  }, [])

  useEffect(() => {
    if (!projectName) return

    let cancelled = false
    setLoadState({ status: 'loading' })
    setStoryInput(null)

    loadPlayerStoryInput(projectName)
      .then((input) => {
        if (cancelled) return
        setStoryInput(input)
        setLoadState({ status: 'ready' })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadState({
          status: 'error',
          error: error instanceof Error ? error.message : '加载 story.json 失败'
        })
      })

    return () => {
      cancelled = true
    }
  }, [projectName]) // TODO: 监听 render变量变化

  useEffect(() => {
    if (loadState.status !== 'ready' || !storyInput || !stageRef.current) return

    let cancelled = false
    let app: Application | null = null
    let dispatcher: StoryDispatcher | null = null
    let runtime: StoryRuntime | null = null
    let preloadedModels: StoryModelInstance[] = []
    let fontFamily: string | null = null
    const stageElement = stageRef.current
    const currentStoryInput = storyInput

    setModelLoadState({ status: 'loading', message: '初始化播放器' })

    async function startStory(): Promise<void> {
      await ensureSekaiLive2DReady()
      if (cancelled) return

      app = new Application()
      await app.init({
        resizeTo: stageElement,
        preference: 'webgl',
        autoDensity: true,
        resolution: resolveRenderPrecision(currentStoryInput.settings),
        backgroundAlpha: 0
      })

      if (cancelled) return
      stageElement.replaceChildren(app.canvas)

      setModelLoadState({ status: 'loading', message: '加载字体资源' })
      fontFamily = await loadPlaybackFontFamily(
        currentStoryInput.settings,
        currentStoryInput.dataPath
      )
      if (cancelled) return

      setModelLoadState({ status: 'loading', message: '加载模型资源' })
      preloadedModels = await preloadStoryModels({
        app,
        dataPath: currentStoryInput.dataPath,
        assets: currentStoryInput.assets,
        modelRegistry: currentStoryInput.modelRegistry
      })
      if (cancelled) return

      runtime = createStoryRuntime({
        app,
        dataPath: currentStoryInput.dataPath,
        projectPath: currentStoryInput.projectPath,
        assets: currentStoryInput.assets,
        modelRegistry: currentStoryInput.modelRegistry,
        models: preloadedModels,
        fontFamily
      })
      dispatcher = new StoryDispatcher(runtime, {
        onEvent: (event) => {
          if (event.type === 'snippet:error') {
            console.error('Story snippet failed', event)
          }
        }
      })

      setModelLoadState({
        status: 'ready',
        message: `已加载 ${preloadedModels.length} 个模型`
      })

      if (render && renderConfig) {
        // Render mode: async streaming pipeline
        try {
          await invoke('start_render_session', { 
            projectName: projectName, 
            config: {
              export_path: renderConfig.exportPath,
              width: renderConfig.width,
              height: renderConfig.height,
              fps: renderConfig.fps
            }
          })
          
          const frameInterval = 1 / 60
          let isRendering = true
          let framesProcessed = 0
          let lastTime = performance.now()
          let frameTimes: number[] = []
          
          const renderPromise = (async () => {
            while (isRendering && !cancelled) {
              // 1. Advance virtual time
              timeManager.tick(frameInterval)
              
              // 2. Wait for microtasks to flush (snippet logic)
              await new Promise(resolve => setTimeout(resolve, 0))
              
              // 3. Extract raw RGBA pixels
              const pixels = app!.renderer.extract.pixels(app!.stage)
              
              // 4. Stream to backend (async)
              await invoke('stream_frame', { 
                projectName: projectName, 
                data: Array.from(pixels.pixels) 
              })
              
              // 5. Update PixiJS ticker & render
              app!.ticker.update(frameInterval)
              app!.renderer.render(app!.stage)
              
              // Calculate Stats
              framesProcessed++
              const now = performance.now()
              const delta = now - lastTime
              lastTime = now
              frameTimes.push(delta)
              if (frameTimes.length > 60) frameTimes.shift()
              const avgDelta = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
              const actualFPS = 1000 / avgDelta
              
              setRenderStats({
                progress: 0, // Need total duration to calculate
                frameCount: framesProcessed,
                totalFrames: 0, // Need to calculate from story
                currentTime: timeManager.getCurrentTime(),
                totalDuration: 0,
                fps: actualFPS,
                speed: actualFPS / renderConfig.fps
              })
              
              await new Promise(resolve => requestAnimationFrame(resolve))
            }
          })()
          
          // Start dispatcher in background
          const runPromise = dispatcher!.run(currentStoryInput.story)
          
          await Promise.all([runPromise, renderPromise])
          
          await invoke('stop_render_session', { projectName: projectName })
          console.log('Render complete')
        } catch (e) {
          console.error('Render session failed', e)
          await dispatcher!.run(currentStoryInput.story)
        }
      } else {
        // Normal playback
        await dispatcher.run(currentStoryInput.story)
      }
    }

    startStory().catch((error: unknown) => {
      if (cancelled) return
      console.error('Story playback failed', error)
      setModelLoadState({
        status: 'error',
        error: describeStoryPlaybackError(error)
      })
    })

    return () => {
      cancelled = true
      dispatcher?.cancel()
      if (runtime) {
        destroyStoryRuntime(runtime)
      } else {
        for (const { model } of preloadedModels) {
          model.destroy({ children: true })
        }
      }
      app?.destroy(true, { children: true })
      stageElement.replaceChildren()
    }
  }, [loadState.status, storyInput])

  return (
    <main
      className="relative h-screen w-screen overflow-hidden bg-black text-white select-none"
      data-player-entry="story-json"
      data-status={loadState.status}
      data-project={storyInput?.projectName ?? projectName ?? ''}
      data-snippet-count={storyInput?.story.snippets.length ?? 0}
      data-model-status={modelLoadState.status}
    >
      <div className="absolute inset-x-0 top-0 z-20 h-8" onMouseDown={startWindowDrag} />
      <div ref={stageRef} className="h-full w-full overflow-hidden" />
      {(loadState.status === 'error' || modelLoadState.status === 'error') && (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm whitespace-pre-wrap text-white/70">
          {errorMessage(loadState, modelLoadState)}
        </div>
      )}
      {render && (
        <div className="z-50 absolute top-4 left-1/2 -translate-x-1/2 p-2 bg-black/50 backdrop-blur-md rounded-4xl text-xs font-mono whitespace-nowrap">
          <span>
            {((renderStats.progress * 100).toFixed(2))}% Frames: {renderStats.frameCount}/{renderStats.totalFrames} Time: {formatTime(renderStats.currentTime)}/{formatTime(renderStats.totalDuration)} FPS: {renderStats.fps.toFixed(1)} Speed: {renderStats.speed.toFixed(2)}x
          </span>
        </div>
      )}
    </main>
  )
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`
}

function startWindowDrag(event: ReactMouseEvent<HTMLDivElement>): void {
  if (event.button !== 0) return

  event.preventDefault()
  void getCurrentWindow()
    .startDragging()
    .catch((error: unknown) => {
      console.error('Failed to start dragging player window', error)
    })
}

async function loadPlayerStoryInput(projectName: string): Promise<PlayerStoryInput> {
  const [rawMetadata, rawSettings, dataPath, projectPath, rawModelRegistry, rawAssets] =
    await Promise.all([
      getProjectMetadata(projectName),
      getSettings(),
      getDataPath(),
      getProjectPath(projectName),
      getModelRegistry(),
      getProjectAssets(projectName)
    ])

  if (!rawMetadata) {
    throw new Error(`项目 metadata.json 不存在: ${projectName}`)
  }

  const story = await getProjectStory(projectName)

  return {
    projectName,
    dataPath,
    projectPath,
    metadata: rawMetadata,
    settings: rawSettings,
    modelRegistry: rawModelRegistry,
    assets: rawAssets,
    story
  }
}

function resolveRenderPrecision(settings: AppSettings | null): number {
  const renderPrecision = settings?.playback?.renderPrecision
  if (isCustomRenderPrecision(renderPrecision)) return renderPrecision
  return window.devicePixelRatio
}

function isCustomRenderPrecision(value: RenderPrecision | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function errorMessage(loadState: LoadState, modelLoadState: ModelLoadState): string {
  if (loadState.status === 'error') return loadState.error
  if (modelLoadState.status === 'error') return modelLoadState.error
  return ''
}

function describeStoryPlaybackError(error: unknown): string {
  if (error instanceof StoryModelPreloadError) {
    return describeModelLoadError(error)
  }

  if (error instanceof StorySnippetError) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ''

    return `Snippet 执行失败 ${error.path.join('.')}: ${error.snippet.type}${cause}`
  }

  return error instanceof Error ? error.message : 'Story 播放失败'
}

function describeModelLoadError(error: StoryModelPreloadError): string {
  const message = error.cause instanceof Error ? error.cause.message : error.message
  const failedUrl = getErrorString(error.cause, 'url')
  const status = getErrorValue(error.cause, 'status')

  return [
    `Live2D 模型加载失败: ${message}`,
    `模型: ${error.modelName}`,
    `入口: ${error.modelUrl}`,
    failedUrl ? `失败请求: ${failedUrl}` : null,
    typeof status === 'number' ? `HTTP 状态: ${status}` : null
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}

function getErrorString(error: unknown, key: string): string | null {
  const value = getErrorValue(error, key)
  return typeof value === 'string' && value.length > 0 ? value : null
}

function getErrorValue(error: unknown, key: string): unknown {
  if (!error || typeof error !== 'object') return null
  return (error as Record<string, unknown>)[key]
}
