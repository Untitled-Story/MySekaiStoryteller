import type { CSSProperties, JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen, type Event as TauriEvent } from '@tauri-apps/api/event'
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
import { getProjectStory } from '@/story/api'
import type { ProjectMetadata } from '@/project/metadata'
import type { ProjectAssets } from '@/project/assets'
import { getProjectAssets, getProjectMetadata, getProjectPath } from '@/project/api'
import type { ModelRegistry } from '@/modelRegistry/schema'
import { getModelRegistry } from '@/modelRegistry/api'
import { getSettings } from '@/settings/api'
import { matchesShortcut, normalizeShortcutSettings } from '@/settings/shortcuts'
import type { AppSettings, RenderPrecision, ShortcutSettings } from '@/settings/types'
import { loadPlaybackFontFamily } from '@/settings/fonts'
import { getDataPath } from '@/workspace/api'
import { describeError, logger } from '@/lib/logger'
import { applyAppLanguage } from '@/i18n'
import { useTranslation } from 'react-i18next'

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

const PLAYER_STAGE_STYLE: CSSProperties = {
  width: 'min(100vw, 177.77777778vh)',
  height: 'min(100vh, 56.25vw)'
}

export default function App(): JSX.Element {
  const { t } = useTranslation()
  const projectName = useWindowProjectName()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [storyInput, setStoryInput] = useState<PlayerStoryInput | null>(null)
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' })
  const [modelLoadState, setModelLoadState] = useState<ModelLoadState>({ status: 'idle' })
  const [reloadRequest, setReloadRequest] = useState<number>(0)
  const [shortcutOverride, setShortcutOverride] = useState<ShortcutSettings | null>(null)
  const shortcuts: ShortcutSettings = useMemo(
    (): ShortcutSettings =>
      normalizeShortcutSettings(shortcutOverride ?? storyInput?.settings?.shortcuts),
    [shortcutOverride, storyInput?.settings?.shortcuts]
  )

  useEffect((): (() => void) => {
    let disposed = false
    let unlisten: (() => void) | null = null

    void listen<AppSettings>('settings-changed', (event: TauriEvent<AppSettings>): void => {
      if (!disposed) {
        setShortcutOverride(normalizeShortcutSettings(event.payload.shortcuts))
        applyAppLanguage(event.payload.language)
      }
    }).then((dispose: () => void): void => {
      if (disposed) dispose()
      else unlisten = dispose
    })

    return (): void => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect((): (() => void) => {
    const currentWindow = getCurrentWindow()

    async function enterFullscreen(): Promise<void> {
      try {
        if (await currentWindow.isFullscreen()) return
        await currentWindow.setFullscreen(true)
        logger.info('player.fullscreen_entered')
      } catch (error: unknown) {
        logger.error('player.fullscreen_enter_failed', { error: describeError(error) })
      }
    }

    async function exitFullscreen(): Promise<void> {
      try {
        if (!(await currentWindow.isFullscreen())) return
        await currentWindow.setFullscreen(false)
        logger.info('player.fullscreen_exited')
      } catch (error: unknown) {
        logger.error('player.fullscreen_exit_failed', { error: describeError(error) })
      }
    }

    function handlePlayerShortcut(event: KeyboardEvent): void {
      if (matchesShortcut(event, shortcuts.player.reload)) {
        event.preventDefault()
        if (event.repeat) return
        logger.info('player.reload_requested', { projectName })
        setReloadRequest((current: number): number => current + 1)
        return
      }

      if (matchesShortcut(event, shortcuts.player.enterFullscreen)) {
        event.preventDefault()
        if (!event.repeat) void enterFullscreen()
        return
      }

      if (matchesShortcut(event, shortcuts.player.exitFullscreen)) {
        event.preventDefault()
        if (!event.repeat) void exitFullscreen()
        return
      }

      if (!matchesShortcut(event, shortcuts.player.close)) return

      event.preventDefault()
      void currentWindow.close().catch((error: unknown) => {
        console.error('Failed to close player window', error)
      })
    }

    window.addEventListener('keydown', handlePlayerShortcut, true)
    return (): void => window.removeEventListener('keydown', handlePlayerShortcut, true)
  }, [projectName, shortcuts.player])

  useEffect(() => {
    if (!projectName) return

    let cancelled = false
    const startedAt: number = performance.now()
    setLoadState({ status: 'loading' })
    setStoryInput(null)
    logger.info('player.project_load_started', { projectName })

    loadPlayerStoryInput(projectName)
      .then((input: PlayerStoryInput): void => {
        if (cancelled) return
        applyAppLanguage(input.settings?.language ?? 'system')
        setStoryInput(input)
        setLoadState({ status: 'ready' })
        logger.info('player.project_load_completed', {
          projectName,
          durationMs: Math.round(performance.now() - startedAt),
          snippetCount: input.story.snippets.length,
          modelCount: Object.keys(input.assets.models).length
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        logger.error('player.project_load_failed', {
          projectName,
          durationMs: Math.round(performance.now() - startedAt),
          error: describeError(error)
        })
        setLoadState({
          status: 'error',
          error: error instanceof Error ? error.message : t('player.storyLoadFailed')
        })
      })

    return () => {
      cancelled = true
    }
  }, [projectName, reloadRequest, t])

  useEffect(() => {
    if (loadState.status !== 'ready' || !storyInput || !stageRef.current) return

    let cancelled = false
    let app: Application | null = null
    let appInitialized = false
    let appDestroyed = false
    let mountedCanvas: HTMLCanvasElement | null = null
    let dispatcher: StoryDispatcher | null = null
    let runtime: StoryRuntime | null = null
    let preloadedModels: StoryModelInstance[] = []
    let fontFamily: string | null = null
    const stageElement = stageRef.current
    const currentStoryInput = storyInput
    const startedAt: number = performance.now()

    setModelLoadState({ status: 'loading', message: t('player.initialize') })
    logger.info('player.runtime_started', {
      projectName: currentStoryInput.projectName,
      snippetCount: currentStoryInput.story.snippets.length
    })

    function detachMountedCanvas(): void {
      const canvas: HTMLCanvasElement | null = mountedCanvas
      mountedCanvas = null
      if (canvas && stageElement.contains(canvas)) {
        stageElement.replaceChildren()
      }
    }

    function destroyPreloadedModels(): void {
      const models: StoryModelInstance[] = preloadedModels
      preloadedModels = []
      for (const { model } of models) {
        model.destroy({ children: true })
      }
    }

    function destroyInitializedApp(): void {
      if (!app || !appInitialized || appDestroyed) return
      appDestroyed = true
      app.destroy(true, { children: true })
    }

    async function startStory(): Promise<void> {
      await ensureSekaiLive2DReady()
      if (cancelled) return
      logger.debug('player.live2d_ready', { projectName: currentStoryInput.projectName })

      const playerApp: Application = new Application()
      app = playerApp
      await playerApp.init({
        resizeTo: stageElement,
        preference: 'webgl',
        autoDensity: true,
        resolution: resolveRenderPrecision(currentStoryInput.settings),
        backgroundAlpha: 0
      })

      appInitialized = true
      mountedCanvas = playerApp.canvas
      if (cancelled) {
        detachMountedCanvas()
        destroyInitializedApp()
        return
      }
      stageElement.replaceChildren(mountedCanvas)
      logger.info('player.pixi_ready', {
        projectName: currentStoryInput.projectName,
        resolution: resolveRenderPrecision(currentStoryInput.settings)
      })

      setModelLoadState({ status: 'loading', message: t('player.loadFont') })
      fontFamily = await loadPlaybackFontFamily(
        currentStoryInput.settings,
        currentStoryInput.dataPath
      )
      if (cancelled) return

      setModelLoadState({ status: 'loading', message: t('player.loadModels') })
      preloadedModels = await preloadStoryModels({
        app: playerApp,
        dataPath: currentStoryInput.dataPath,
        assets: currentStoryInput.assets,
        modelRegistry: currentStoryInput.modelRegistry
      })
      if (cancelled) {
        destroyPreloadedModels()
        return
      }
      logger.info('player.models_loaded', {
        projectName: currentStoryInput.projectName,
        modelCount: preloadedModels.length
      })

      runtime = createStoryRuntime({
        app: playerApp,
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
        message: t('player.loadedModels', { count: preloadedModels.length })
      })
      await dispatcher.run(currentStoryInput.story)
      if (!cancelled) {
        logger.info('player.story_completed', {
          projectName: currentStoryInput.projectName,
          durationMs: Math.round(performance.now() - startedAt)
        })
      }
    }

    startStory().catch((error: unknown) => {
      if (cancelled) return
      console.error('Story playback failed', error)
      logger.error('player.runtime_failed', {
        projectName: currentStoryInput.projectName,
        durationMs: Math.round(performance.now() - startedAt),
        error: describeError(error)
      })
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
        preloadedModels = []
      } else {
        destroyPreloadedModels()
      }
      detachMountedCanvas()
      destroyInitializedApp()
    }
  }, [loadState.status, storyInput, t])

  return (
    <main
      className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-black text-white select-none"
      data-player-entry="story-json"
      data-status={loadState.status}
      data-project={storyInput?.projectName ?? projectName ?? ''}
      data-snippet-count={storyInput?.story.snippets.length ?? 0}
      data-model-status={modelLoadState.status}
    >
      <div className="absolute inset-x-0 top-0 z-20 h-8" onMouseDown={startWindowDrag} />
      <div
        className="relative shrink-0 overflow-hidden bg-black"
        style={PLAYER_STAGE_STYLE}
        data-player-stage="16:9"
      >
        <div ref={stageRef} className="absolute inset-0 overflow-hidden" />
        {(loadState.status === 'error' || modelLoadState.status === 'error') && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm whitespace-pre-wrap text-white/70">
            {errorMessage(loadState, modelLoadState)}
          </div>
        )}
      </div>
    </main>
  )
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
