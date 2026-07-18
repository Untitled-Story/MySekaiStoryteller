import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
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
import { isStoryAsyncPending } from '@/story/storyAsyncGate'
import type { StoryPlaybackClock } from '@/story/playbackClock'
import { calculateStoryDuration, planExportDuration } from '@/story/duration'
import { getProjectStory } from '@/story/api'
import type { ProjectMetadata } from '@/project/metadata'
import type { ProjectAssets } from '@/project/assets'
import { getProjectAssets, getProjectMetadata, getProjectPath } from '@/project/api'
import type { ModelRegistry } from '@/modelRegistry/schema'
import { getModelRegistry } from '@/modelRegistry/api'
import { getSettings } from '@/settings/api'
import type { AppSettings, RenderConfig, RenderPrecision } from '@/settings/types'
import { loadPlaybackFontFamily } from '@/settings/fonts'
import { useSettings } from '@/settings/useSettings'
import { getDataPath } from '@/workspace/api'
import { describeError, logger } from '@/lib/logger'
import {
  cleanupExportTemp,
  closeExportWorker,
  concatRenderSegments,
  openPlayerWindow,
  prepareParallelExport,
  startRenderSession,
  stopRenderSession,
  validateRenderSegment,
  type FfmpegProgressEvent
} from '@/windows/api'
import {
  buildJobPaths,
  clampConcurrency,
  createLaneJobPlanner,
  type ExportJob
} from '@/story/chunkPlanner'
import { emit, listen } from '@tauri-apps/api/event'
import {
  EXPORT_DEBUG_REQUEST_EVENT,
  EXPORT_DEBUG_STATS_EVENT,
  EXPORT_UI_PROGRESS_EVENT,
  mapRenderStatusToUi,
  type ExportDebugRequestEvent,
  type ExportDebugStats,
  type ExportDebugStatsEvent,
  type ExportUiProgress
} from '@/export/exportUi'
import { ExportDebugDashboard } from '@/windows/player/ExportDebugDashboard'
import { ExportProgressDashboard } from '@/windows/player/ExportProgressDashboard'

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

type WorkerCardStats = {
  index: number
  status: RenderStats['status']
  progress: number
  frameCount: number
  totalFrames: number
  warmProgress: number
  warmFrameCount: number
  warmTotalFrames: number
  fps: number
  speed: number
  message?: string
}

/** One segment in the timeline progress bar (frame range weight). */
type ChunkBarSegment = {
  id: string
  jobId?: number
  startFrame: number
  endFrame: number
  /** 0–1 capture fill within this chunk only. */
  progress: number
  state: 'done' | 'running' | 'warming' | 'queued' | 'pending' | 'error'
  label?: string
  slotIndex?: number
}

/** Wall-clock span for Dashboard time waterfall (seconds from export start). */
type TimingSpan = {
  id: string
  label: string
  lane: string
  phase: 'warm' | 'capture' | 'finalize' | 'merge' | 'other'
  startSec: number
  endSec: number
  state: 'running' | 'done' | 'error'
}

/**
 * Overall bar layout:
 * - capture/render: 0% – 89%
 * - merge/encode:   90% – 99%
 * - done:           100%
 */
const EXPORT_CAPTURE_PROGRESS_END = 0.89
const EXPORT_MERGE_PROGRESS_START = 0.9
const EXPORT_MERGE_PROGRESS_END = 0.99

function scaleCaptureProgress(capture01: number): number {
  const t = Math.min(1, Math.max(0, capture01))
  return t * EXPORT_CAPTURE_PROGRESS_END
}

/** Map ffmpeg out_time ratio (0–1) into the merge band 90%–99%. */
function scaleMergeProgressFromFfmpeg(ratio: number): number {
  const t = Math.min(1, Math.max(0, ratio))
  return (
    EXPORT_MERGE_PROGRESS_START +
    (EXPORT_MERGE_PROGRESS_END - EXPORT_MERGE_PROGRESS_START) * t
  )
}

type RenderStats = {
  progress: number
  frameCount: number
  totalFrames: number
  currentTime: number
  totalDuration: number
  fps: number
  speed: number
  status:
    | 'idle'
    | 'warming'
    | 'rendering'
    | 'finalizing'
    | 'concatenating'
    | 'done'
    | 'error'
    | 'paused'
  message?: string
  workerLabel?: string
  workerCards?: WorkerCardStats[]
  chunkSegments?: ChunkBarSegment[]
  timingSpans?: TimingSpan[]
  wallElapsedSec?: number
  detailLines?: string[]
  canPause?: boolean
  canStop?: boolean
  isPaused?: boolean
  efficiency?: number
  doneWorkers?: number
  totalWorkers?: number
}

export default function App({
  preferredProjectName = null
}: {
  preferredProjectName?: string | null
} = {}): JSX.Element {
  const projectName = useWindowProjectName(preferredProjectName)
  const { appearance, loaded: settingsLoaded } = useSettings()
  const searchParams = useMemo(() => new URLSearchParams(window.location.search), [])
  const isRenderMode = searchParams.get('render') === 'true'
  const renderConfig = useMemo(
    () => parseRenderConfig(searchParams.get('renderConfig')),
    [searchParams]
  )
  const exportRole = renderConfig?.role ?? (isRenderMode ? 'single' : undefined)
  const isExportDebug = isRenderMode && exportRole === 'debug'
  const concurrency = clampConcurrency(renderConfig?.concurrency)

  // Align export chrome (and player shell) with app light/dark tokens.
  useEffect(() => {
    if (!settingsLoaded || typeof document === 'undefined') return
    const root = document.documentElement
    root.classList.toggle('dark', appearance.activeTheme === 'dark')
    root.style.colorScheme = appearance.activeTheme
  }, [appearance.activeTheme, settingsLoaded])

  const stageRef = useRef<HTMLDivElement | null>(null)
  const [storyInput, setStoryInput] = useState<PlayerStoryInput | null>(null)
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' })
  const [modelLoadState, setModelLoadState] = useState<ModelLoadState>({ status: 'idle' })
  const [renderStats, setRenderStats] = useState<RenderStats>({
    progress: 0,
    frameCount: 0,
    totalFrames: 0,
    currentTime: 0,
    totalDuration: 0,
    fps: 0,
    speed: 1,
    status: 'idle'
  })
  const [debugStats, setDebugStats] = useState<ExportDebugStats | null>(null)
  const [debugMeta, setDebugMeta] = useState<{
    sessionId?: string
    projectTitle?: string
    exportPath?: string
  }>({})
  const renderStatsRef = useRef<RenderStats>(renderStats)
  const exportControlRef = useRef<{
    paused: boolean
    stopped: boolean
    groupId?: string
  }>({ paused: false, stopped: false })
  const lastDebugEmitAtRef = useRef(0)
  const lastDebugStatusRef = useRef<string>('')

  useEffect(() => {
    renderStatsRef.current = renderStats
  }, [renderStats])

  const publishExportUi = useMemo(() => {
    return (stats: RenderStats): void => {
      if (!isRenderMode || exportRole === 'worker' || exportRole === 'debug') return
      const groupId =
        exportControlRef.current.groupId ??
        renderConfig?.exportGroupId ??
        renderConfig?.sessionId ??
        projectName ??
        'export'
      const mapped = mapRenderStatusToUi({
        status: stats.status,
        isPaused: stats.isPaused,
        message: stats.message,
        progress: stats.progress,
        wallElapsedSec: stats.wallElapsedSec,
        exportPath: renderConfig?.exportPath
      })
      const payload: ExportUiProgress = {
        sessionId: groupId,
        projectTitle: projectName ?? '渲染',
        ...mapped,
        exportPath: renderConfig?.exportPath,
        error: stats.status === 'error' ? stats.message : undefined
      }
      void emit(EXPORT_UI_PROGRESS_EVENT, payload)
    }
  }, [isRenderMode, exportRole, renderConfig, projectName])

  const publishDebugStats = useMemo(() => {
    return (stats: RenderStats, force = false): void => {
      if (!isRenderMode || exportRole === 'worker' || exportRole === 'debug') return
      const now = performance.now()
      const statusChanged = stats.status !== lastDebugStatusRef.current
      // Always push terminal states immediately.
      const terminal = stats.status === 'done' || stats.status === 'error'
      if (!force && !statusChanged && !terminal && now - lastDebugEmitAtRef.current < 250) {
        return
      }
      lastDebugEmitAtRef.current = now
      lastDebugStatusRef.current = stats.status
      const preparedOrLive =
        exportControlRef.current.groupId ??
        renderConfig?.exportGroupId ??
        renderConfig?.sessionId ??
        projectName ??
        'export'
      const uiGroupId = renderConfig?.exportGroupId ?? renderConfig?.sessionId
      const doneStats: RenderStats =
        stats.status === 'done'
          ? { ...stats, progress: 1, canPause: false, canStop: false, isPaused: false }
          : stats
      const debugPayload: ExportDebugStatsEvent = {
        sessionId: preparedOrLive,
        exportGroupId: uiGroupId,
        projectTitle: projectName ?? '渲染',
        exportPath: renderConfig?.exportPath,
        stats: {
          progress: doneStats.progress,
          frameCount: doneStats.frameCount,
          totalFrames: doneStats.totalFrames,
          currentTime: doneStats.currentTime,
          totalDuration: doneStats.totalDuration,
          fps: doneStats.fps,
          speed: doneStats.speed,
          status: doneStats.status,
          message: doneStats.message,
          workerLabel: doneStats.workerLabel,
          wallElapsedSec: doneStats.wallElapsedSec,
          canPause: doneStats.canPause,
          canStop: doneStats.canStop,
          isPaused: doneStats.isPaused,
          efficiency: doneStats.efficiency,
          doneWorkers: doneStats.doneWorkers,
          totalWorkers: doneStats.totalWorkers,
          exportPath: renderConfig?.exportPath,
          workerCards: doneStats.workerCards,
          timingSpans: doneStats.timingSpans,
          chunkSegments: doneStats.chunkSegments,
          detailLines: doneStats.detailLines
        }
      }
      void emit(EXPORT_DEBUG_STATS_EVENT, debugPayload)
    }
  }, [isRenderMode, exportRole, renderConfig, projectName])

  useEffect(() => {
    if (!isRenderMode || exportRole === 'worker' || exportRole === 'debug') return
    publishExportUi(renderStats)
    publishDebugStats(renderStats)
  }, [isRenderMode, exportRole, renderStats, publishExportUi, publishDebugStats])

  // Progress host re-emits latest snapshot when debug window asks.
  useEffect(() => {
    if (!isRenderMode || exportRole === 'worker' || exportRole === 'debug') return
    let unlisten: (() => void) | undefined
    void listen<ExportDebugRequestEvent>(EXPORT_DEBUG_REQUEST_EVENT, () => {
      publishDebugStats(renderStatsRef.current, true)
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }, [isRenderMode, exportRole, publishDebugStats])

  // Debug window: receive technical stats only (no pipeline).
  useEffect(() => {
    if (!isExportDebug) return
    let unlisten: (() => void) | undefined
    const preferredSession =
      renderConfig?.exportGroupId ?? renderConfig?.sessionId ?? undefined
    void listen<ExportDebugStatsEvent>(EXPORT_DEBUG_STATS_EVENT, (event) => {
      const payload = event.payload
      // Accept prepared sessionId or original UI exportGroupId (coordinator rebinds id).
      if (preferredSession) {
        const matches =
          payload.sessionId === preferredSession ||
          payload.exportGroupId === preferredSession ||
          // Terminal updates should never be dropped if only one export is running.
          payload.stats.status === 'done' ||
          payload.stats.status === 'error'
        if (!matches) return
      }
      const nextStats =
        payload.stats.status === 'done' ? { ...payload.stats, progress: 1 } : payload.stats
      setDebugStats(nextStats)
      setDebugMeta({
        sessionId: payload.sessionId,
        projectTitle: payload.projectTitle,
        exportPath: payload.exportPath
      })
    }).then((fn) => {
      unlisten = fn
      void emit(EXPORT_DEBUG_REQUEST_EVENT, {
        sessionId: preferredSession
      } satisfies ExportDebugRequestEvent)
    })
    return () => {
      unlisten?.()
    }
  }, [isExportDebug, renderConfig?.exportGroupId, renderConfig?.sessionId])

  useEffect(() => {
    const currentWindow = getCurrentWindow()

    function closeOnShortcut(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== 'w') return
      if (!event.metaKey && !event.ctrlKey) return

      event.preventDefault()
      void currentWindow.close().catch((error: unknown) => {
        logger.error('player.window_close_failed', { error: describeError(error) })
      })
    }

    window.addEventListener('keydown', closeOnShortcut, true)
    return () => window.removeEventListener('keydown', closeOnShortcut, true)
  }, [])

  useEffect(() => {
    if (!projectName) return
    // Debug dashboard does not need story/assets; skip heavy load.
    if (isExportDebug) {
      setLoadState({ status: 'ready' })
      setStoryInput(null)
      setModelLoadState({ status: 'ready', message: '调试模式' })
      logger.info('export.debug_dashboard_ready', { projectName })
      return
    }

    let cancelled = false
    const startedAt: number = performance.now()
    setLoadState({ status: 'loading' })
    setStoryInput(null)
    logger.info('player.project_load_started', {
      projectName,
      isRenderMode,
      exportRole
    })

    loadPlayerStoryInput(projectName, renderConfig?.dataPath)
      .then((input: PlayerStoryInput): void => {
        if (cancelled) return
        setStoryInput(input)
        setLoadState({ status: 'ready' })
        logger.info('player.project_load_completed', {
          projectName,
          durationMs: Math.round(performance.now() - startedAt),
          snippetCount: input.story.snippets.length,
          modelCount: Object.keys(input.assets.models).length,
          isRenderMode,
          exportRole,
          dataPath: input.dataPath
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        logger.error('player.project_load_failed', {
          projectName,
          durationMs: Math.round(performance.now() - startedAt),
          error: describeError(error),
          isRenderMode,
          exportRole
        })
        setLoadState({
          status: 'error',
          error: error instanceof Error ? error.message : '加载 story.json 失败'
        })
      })

    return () => {
      cancelled = true
    }
  }, [projectName, isExportDebug, isRenderMode, exportRole, renderConfig?.dataPath])

  useEffect(() => {
    if (isExportDebug) return
    if (loadState.status !== 'ready' || !storyInput || !stageRef.current) return

    let cancelled = false
    let app: Application | null = null
    let dispatcher: StoryDispatcher | null = null
    let runtime: StoryRuntime | null = null
    let preloadedModels: StoryModelInstance[] = []
    let fontFamily: string | null = null
    const stageElement = stageRef.current
    const currentStoryInput = storyInput
    const activeProjectName = currentStoryInput.projectName
    const startedAt: number = performance.now()

    setModelLoadState({ status: 'loading', message: '初始化播放器' })
    logger.info('player.runtime_started', {
      projectName: currentStoryInput.projectName,
      snippetCount: currentStoryInput.story.snippets.length,
      isRenderMode,
      exportRole,
      concurrency
    })

    async function startStory(): Promise<void> {
      // Coordinator only schedules workers + Dashboard — skip GL/Live2D preload.
      if (
        isRenderMode &&
        exportRole === 'coordinator' &&
        concurrency > 1
      ) {
        if (!renderConfig) {
          throw new Error('渲染配置无效，请重新从主界面启动渲染')
        }
        setModelLoadState({ status: 'ready', message: '协调渲染中' })
        exportControlRef.current = {
          paused: false,
          stopped: false,
          groupId: renderConfig.exportGroupId ?? renderConfig.sessionId
        }
        logger.info('export.coordinator_started', {
          projectName: activeProjectName,
          groupId: renderConfig.exportGroupId ?? renderConfig.sessionId,
          concurrency,
          width: renderConfig.width,
          height: renderConfig.height,
          fps: renderConfig.fps
        })
        await runCoordinatorExport({
          projectName: activeProjectName,
          story: currentStoryInput.story,
          renderConfig,
          dataPath: currentStoryInput.dataPath,
          isCancelled: () => cancelled || exportControlRef.current.stopped,
          onStats: setRenderStats,
          controlRef: exportControlRef.current
        })
        return
      }

      await ensureSekaiLive2DReady()
      if (cancelled) return
      logger.debug('player.live2d_ready', {
        projectName: currentStoryInput.projectName,
        isRenderMode,
        exportRole
      })

      app = new Application()
      await app.init({
        resizeTo: isRenderMode ? undefined : stageElement,
        width: isRenderMode ? Math.max(1, Math.floor(renderConfig?.width ?? 1280)) : undefined,
        height: isRenderMode ? Math.max(1, Math.floor(renderConfig?.height ?? 720)) : undefined,
        preference: 'webgl',
        autoDensity: !isRenderMode,
        resolution: isRenderMode ? 1 : resolveRenderPrecision(currentStoryInput.settings),
        backgroundAlpha: isRenderMode ? 1 : 0,
        backgroundColor: isRenderMode ? '#000000' : undefined,
        antialias: !isRenderMode,
        preferWebGLVersion: 2,
        // Keep the backbuffer so we can readPixels immediately after each export frame.
        ...(isRenderMode ? { useBackBuffer: true } : {})
      })

      if (cancelled) return
      stageElement.replaceChildren(app.canvas)
      logger.info('player.pixi_ready', {
        projectName: currentStoryInput.projectName,
        resolution: isRenderMode ? 1 : resolveRenderPrecision(currentStoryInput.settings),
        isRenderMode,
        exportRole
      })

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
      logger.info('player.models_loaded', {
        projectName: currentStoryInput.projectName,
        modelCount: preloadedModels.length,
        isRenderMode,
        exportRole
      })

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
            logger.error('player.snippet_error', {
              projectName: currentStoryInput.projectName,
              event
            })
          }
        }
      })

      setModelLoadState({
        status: 'ready',
        message: `已加载 ${preloadedModels.length} 个模型`
      })

      if (isRenderMode) {
        if (!renderConfig) {
          throw new Error('渲染配置无效，请重新从主界面启动渲染')
        }
        {
          exportControlRef.current = {
            paused: false,
            stopped: false,
            groupId: renderConfig.exportGroupId ?? renderConfig.sessionId
          }
          ;(window as unknown as { __MSS_EXPORT_PAUSED__?: boolean }).__MSS_EXPORT_PAUSED__ = false
          logger.info('export.pipeline_started', {
            projectName: activeProjectName,
            role: exportRole,
            width: renderConfig.width,
            height: renderConfig.height,
            fps: renderConfig.fps,
            concurrency: renderConfig.concurrency ?? 1,
            exportPath: renderConfig.exportPath,
            groupId: renderConfig.exportGroupId ?? renderConfig.sessionId,
            workerIndex: renderConfig.workerIndex,
            startFrame: renderConfig.startFrame,
            endFrame: renderConfig.endFrame
          })
          await runExportPipeline({
            app,
            clock: runtime.clock,
            dispatcher,
            story: currentStoryInput.story,
            projectName: activeProjectName,
            renderConfig,
            stageElement,
            isCancelled: () => cancelled || exportControlRef.current.stopped,
            onStats: setRenderStats
          })
        }
      } else {
        await dispatcher.run(currentStoryInput.story)
        if (!cancelled) {
          logger.info('player.story_completed', {
            projectName: currentStoryInput.projectName,
            durationMs: Math.round(performance.now() - startedAt)
          })
        }
      }
    }

    startStory().catch((error: unknown) => {
      if (cancelled) return
      logger.error('player.runtime_failed', {
        projectName: currentStoryInput.projectName,
        durationMs: Math.round(performance.now() - startedAt),
        isRenderMode,
        exportRole,
        error: describeError(error)
      })
      if (isRenderMode) {
        logger.error('export.pipeline_failed', {
          projectName: currentStoryInput.projectName,
          role: exportRole,
          error: describeError(error)
        })
      }
      setModelLoadState({
        status: 'error',
        error: describeStoryPlaybackError(error)
      })
      if (isRenderMode) {
        setRenderStats((prev) => ({
          ...prev,
          status: 'error',
          message: describeStoryPlaybackError(error)
        }))
      }
    })

    return () => {
      cancelled = true
      dispatcher?.cancel()
      // Cancel clock tasks before destroying Live2D.
      try {
        runtime?.clock.cancel()
      } catch {
        // ignore
      }
      if (isRenderMode) {
        const sessionKey = renderConfig?.sessionId ?? activeProjectName
        if (sessionKey) {
          void stopRenderSession(sessionKey).catch(() => {
            // session may already be stopped
          })
        }
      }
      try {
        app?.ticker.stop()
      } catch {
        // ignore
      }
      if (runtime) {
        destroyStoryRuntime(runtime)
      } else {
        for (const { model } of preloadedModels) {
          try {
            model.removeFromParent()
            model.destroy({ children: true })
          } catch {
            // ignore Live2D double-release during HMR
          }
        }
      }
      try {
        app?.destroy(true, { children: true })
      } catch {
        // ignore
      }
      stageElement.replaceChildren()
    }
  }, [
    loadState.status,
    storyInput,
    isRenderMode,
    isExportDebug,
    renderConfig,
    concurrency,
    exportRole
  ])

  const showExportChrome =
    isRenderMode && exportRole !== 'worker' && exportRole !== 'debug'
  const handleOpenExportDetails = (): void => {
    if (!projectName || !renderConfig) return
    const groupId =
      exportControlRef.current.groupId ??
      renderConfig.exportGroupId ??
      renderConfig.sessionId
    void openPlayerWindow(projectName, true, {
      exportPath: renderConfig.exportPath,
      width: renderConfig.width,
      height: renderConfig.height,
      fps: renderConfig.fps,
      concurrency: renderConfig.concurrency,
      role: 'debug',
      exportGroupId: groupId,
      sessionId: groupId,
      dataPath: renderConfig.dataPath ?? storyInput?.dataPath
    }).catch((error: unknown) => {
      logger.warn('export.debug_open_failed', { error: describeError(error) })
    })
    // Push latest snapshot immediately for the new window.
    publishDebugStats(renderStatsRef.current, true)
  }
  const handleExportPause = (): void => {
    const next = !exportControlRef.current.paused
    exportControlRef.current.paused = next
    ;(window as unknown as { __MSS_EXPORT_PAUSED__?: boolean }).__MSS_EXPORT_PAUSED__ = next
    const groupId = exportControlRef.current.groupId
    if (groupId) {
      void emit('export-control', {
        groupId,
        action: next ? 'pause' : 'resume'
      })
    }
    setRenderStats((prev) => ({
      ...prev,
      isPaused: next,
      status: next ? 'paused' : prev.status === 'paused' ? 'rendering' : prev.status
    }))
  }
  const handleExportStop = (): void => {
    exportControlRef.current.stopped = true
    exportControlRef.current.paused = false
    ;(window as unknown as { __MSS_EXPORT_PAUSED__?: boolean }).__MSS_EXPORT_PAUSED__ = false
    const groupId = exportControlRef.current.groupId
    if (groupId) {
      void emit('export-control', { groupId, action: 'stop' })
    }
    setRenderStats((prev) => ({
      ...prev,
      status: 'error',
      message: '已停止',
      isPaused: false
    }))
  }

  // Always mount stageRef: coordinator export effect requires it even without GL.
  return (
    <main
      className="relative h-screen w-screen overflow-hidden bg-black text-white select-none"
      data-player-entry="story-json"
      data-status={loadState.status}
      data-project={storyInput?.projectName ?? projectName ?? ''}
      data-snippet-count={storyInput?.story.snippets.length ?? 0}
      data-model-status={modelLoadState.status}
      data-render={isRenderMode ? 'true' : 'false'}
    >
      {!isRenderMode ? (
        <div className="absolute inset-x-0 top-0 z-20 h-8" onMouseDown={startWindowDrag} />
      ) : null}
      <div
        ref={stageRef}
        className={
          isRenderMode
            ? 'pointer-events-none fixed opacity-0'
            : 'h-full w-full overflow-hidden'
        }
        style={
          isRenderMode
            ? {
                // Single export needs real-sized offscreen WebGL surface.
                // Coordinator only needs a mounted node for the start effect.
                width:
                  exportRole === 'coordinator'
                    ? 1
                    : Math.max(160, renderConfig?.width ?? 1920),
                height:
                  exportRole === 'coordinator'
                    ? 1
                    : Math.max(90, renderConfig?.height ?? 1080),
                left: -10000,
                top: 0
              }
            : undefined
        }
      />
      {(loadState.status === 'error' || modelLoadState.status === 'error') && (
        <div
          className={
            isRenderMode
              ? 'absolute inset-0 z-[60] flex items-center justify-center bg-background px-6 text-center text-sm whitespace-pre-wrap text-muted-foreground'
              : 'absolute inset-0 z-[60] flex items-center justify-center bg-zinc-950 px-6 text-center text-sm whitespace-pre-wrap text-white/70'
          }
        >
          {errorMessage(loadState, modelLoadState)}
        </div>
      )}
      {isExportDebug ? (
        <div className="absolute inset-0 z-50">
          <ExportDebugDashboard
            projectTitle={debugMeta.projectTitle ?? projectName ?? undefined}
            sessionId={debugMeta.sessionId}
            exportPath={debugMeta.exportPath ?? renderConfig?.exportPath}
            stats={debugStats}
          />
        </div>
      ) : null}
      {showExportChrome ? (
        <div className="absolute inset-0 z-50">
          <ExportProgressDashboard
            role={exportRole}
            stats={renderStats}
            projectTitle={projectName ?? undefined}
            exportPath={renderConfig?.exportPath}
            onTogglePause={handleExportPause}
            onStop={handleExportStop}
            onOpenDetails={handleOpenExportDetails}
          />
        </div>
      ) : null}
    </main>
  )
}

type ExportPipelineOptions = {
  app: Application
  clock: StoryPlaybackClock
  dispatcher: StoryDispatcher
  story: StoryData
  projectName: string
  renderConfig: RenderConfig
  stageElement: HTMLDivElement
  isCancelled: () => boolean
  onStats: (stats: RenderStats) => void
}

type WorkerProgressEvent = {
  sessionId: string
  workerIndex: number
  jobId?: number
  status: RenderStats['status']
  /** Capture-only progress in [0, 1]. Warm-up must never inflate this. */
  progress: number
  /** Captured/written frames only. */
  frameCount: number
  /** Capture target frames for this worker. */
  totalFrames: number
  warmProgress?: number
  warmFrameCount?: number
  warmTotalFrames?: number
  message?: string
  fps?: number
  speed?: number
  wallElapsedSec?: number
  currentTime?: number
  totalDuration?: number
  /** Absolute frame when story finished (for coordinator end trim). */
  storyEndedAtFrame?: number
}

type ExportControlEvent = {
  groupId: string
  action: 'pause' | 'resume' | 'stop' | 'truncate'
  /** Exclusive end frame when action is truncate (story-end trim). */
  endFrame?: number
}

type JobAssignEvent = {
  sessionId: string
  workerIndex: number
  jobId: number
  startFrame: number
  endFrame: number
  segmentPath: string
  sessionKey: string
  continueFrom: number | null
}

async function runExportPipeline({
  app,
  clock,
  dispatcher,
  story,
  projectName,
  renderConfig,
  stageElement,
  isCancelled,
  onStats
}: ExportPipelineOptions): Promise<void> {
  const exportWidth = Math.max(1, Math.floor(Number(renderConfig.width) || 1280))
  const exportHeight = Math.max(1, Math.floor(Number(renderConfig.height) || 720))
  const exportFps = Math.max(1, Math.floor(Number(renderConfig.fps) || 60))
  const frameIntervalMs = 1000 / exportFps
  const totalDuration = Math.max(0.001, calculateStoryDuration(story))
  const totalFrames = Math.max(1, Math.ceil(totalDuration * exportFps))
  const frameByteLength = exportWidth * exportHeight * 4
  // Larger batches cut HTTP overhead; pool size bounds peak RAM.
  const batchFrames = frameByteLength >= 8_000_000 ? 4 : frameByteLength >= 3_000_000 ? 6 : 8

  stageElement.style.width = `${exportWidth}px`
  stageElement.style.height = `${exportHeight}px`
  app.canvas.style.width = `${exportWidth}px`
  app.canvas.style.height = `${exportHeight}px`
  app.renderer.resolution = 1
  app.renderer.resize(exportWidth, exportHeight)
  app.renderer.background.color = '#000000'
  app.renderer.background.alpha = 1

  let sessionKey = renderConfig.sessionId ?? projectName
  let startFrame = Math.max(0, Math.floor(renderConfig.startFrame ?? 0))
  let endFrame =
    typeof renderConfig.endFrame === 'number' && Number.isFinite(renderConfig.endFrame)
      ? Math.max(startFrame, Math.floor(renderConfig.endFrame))
      : Number.POSITIVE_INFINITY
  let outputPath = renderConfig.segmentPath ?? renderConfig.exportPath
  let currentJobId = renderConfig.jobId
  const isWorker = renderConfig.role === 'worker'
  const workerIndex = renderConfig.workerIndex ?? 0
  const multiJob = Boolean(renderConfig.multiJob && isWorker)
  const groupIdForJobs = renderConfig.exportGroupId ?? renderConfig.sessionId

  let uploadUrl = (
    await startRenderSession(sessionKey, {
      exportPath: outputPath,
      width: exportWidth,
      height: exportHeight,
      fps: exportFps,
      sessionId: sessionKey
    })
  ).uploadUrl

  clock.setTickerDriven(false)
  app.ticker.stop()
  app.ticker.autoStart = false
  // minFPS=1 => max elapsed ~1000ms so multi-frame warm (or low export fps) is not clamped.
  app.ticker.minFPS = 1

  // Continuous-clock warm (f2a9c8d): every worker ticks the same timeline to startFrame.
  // No skipTime / estimate seek (those caused multi-worker seam skip/duplicate).
  let storyDone = false
  let storyFinishedNaturally = false
  let storyError: unknown = null
  const runPromise = dispatcher
    .run(story)
    .then((): void => {
      storyFinishedNaturally = true
      logger.info('export.story_run_completed', {
        workerIndex: isWorker ? workerIndex : 0,
        startFrame,
        endFrame: Number.isFinite(endFrame) ? endFrame : null
      })
    })
    .catch((error: unknown) => {
      storyError = error
      logger.error('export.story_run_failed', {
        workerIndex: isWorker ? workerIndex : 0,
        startFrame,
        error: describeError(error)
      })
      throw error
    })
    .finally(() => {
      storyDone = true
    })

  async function emitWorkerProgress(
    status: RenderStats['status'],
    progress: number,
    frameCount: number,
    total: number,
    extras?: {
      message?: string
      fps?: number
      speed?: number
      wallElapsedSec?: number
      currentTime?: number
      totalDuration?: number
      warmProgress?: number
      warmFrameCount?: number
      warmTotalFrames?: number
      storyEndedAtFrame?: number
    }
  ): Promise<void> {
    const groupId = renderConfig.exportGroupId ?? renderConfig.sessionId
    if (!isWorker || !groupId) return
    const payload: WorkerProgressEvent = {
      sessionId: groupId,
      workerIndex,
      jobId: currentJobId,
      status,
      progress,
      frameCount,
      totalFrames: total,
      warmProgress: extras?.warmProgress,
      warmFrameCount: extras?.warmFrameCount,
      warmTotalFrames: extras?.warmTotalFrames,
      message: extras?.message,
      fps: extras?.fps,
      speed: extras?.speed,
      wallElapsedSec: extras?.wallElapsedSec,
      currentTime: extras?.currentTime,
      totalDuration: extras?.totalDuration,
      storyEndedAtFrame: extras?.storyEndedAtFrame
    }
    await emit('export-worker-progress', payload)
  }


  let captureTotal =
    Number.isFinite(endFrame) && endFrame > startFrame
      ? endFrame - startFrame
      : Math.max(1, totalFrames)
  let globalFrameIndex = 0
  let framesProcessed = 0
  let lastWall = performance.now()
  const frameTimeRing = new Float64Array(32)
  let frameTimeCount = 0
  let frameTimeWrite = 0
  let lastStatsAt = 0
  let idleAfterStoryFrames = 0
  let hungWarmFrames = 0
  // Estimate is short for motions; keep capturing until story is truly idle longer.
  const maxIdleAfterStory = Math.ceil(exportFps * 1.5)
  const readyFrame = new Uint8Array(frameByteLength)

  const pixelReader = createPixelReader(app, exportWidth, exportHeight, frameByteLength)
  // Higher inflight + larger batches; HTTP 503 still provides backpressure.
  const maxInflight = isWorker ? 3 : 4
  const freeBatches: Uint8Array[] = Array.from(
    { length: maxInflight },
    () => new Uint8Array(frameByteLength * batchFrames)
  )

  function pushFrameDelta(delta: number): void {
    frameTimeRing[frameTimeWrite] = delta
    frameTimeWrite = (frameTimeWrite + 1) % frameTimeRing.length
    if (frameTimeCount < frameTimeRing.length) frameTimeCount += 1
  }

  function avgFrameDeltaMs(): number {
    if (frameTimeCount === 0) return 0
    let sum = 0
    for (let i = 0; i < frameTimeCount; i += 1) sum += frameTimeRing[i]
    return sum / frameTimeCount
  }
  let activeBatch = freeBatches.pop() ?? new Uint8Array(frameByteLength * batchFrames)
  let batchCount = 0
  const batchWaiters: Array<() => void> = []
  const pendingUploads: Promise<void>[] = []
  let uploadError: Error | null = null

  function acquireBatchBuffer(): Promise<Uint8Array> {
    const buf = freeBatches.pop()
    if (buf) return Promise.resolve(buf)
    // Never hang forever if uploads are stuck holding buffers.
    return new Promise<Uint8Array>((resolve) => {
      let settled = false
      const timer = window.setTimeout(() => {
        if (settled) return
        settled = true
        const idx = batchWaiters.indexOf(onReady)
        if (idx >= 0) batchWaiters.splice(idx, 1)
        resolve(new Uint8Array(frameByteLength * batchFrames))
      }, 1500)
      const onReady = (): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve(freeBatches.pop() ?? new Uint8Array(frameByteLength * batchFrames))
      }
      batchWaiters.push(onReady)
    })
  }

  function releaseBatchBuffer(buf: Uint8Array): void {
    freeBatches.push(buf)
    batchWaiters.shift()?.()
  }

  async function postFramesWithRetry(payload: Uint8Array): Promise<void> {
    const maxAttempts = 3
    let lastError: Error | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), 4_000)
      try {
        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: payload as unknown as BodyInit,
          signal: controller.signal
        })
        if (response.ok || response.status === 204) return
        const text = await response.text().catch(() => '')
        if (response.status === 503 && attempt < maxAttempts) {
          await new Promise<void>((resolve) => setTimeout(resolve, 40 * attempt))
          continue
        }
        throw new Error(`Frame upload failed (${response.status}): ${text}`)
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error('Frame upload failed')
        if (
          attempt < maxAttempts &&
          (lastError.name === 'AbortError' || /503|queue/i.test(lastError.message))
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 40 * attempt))
          continue
        }
        throw lastError
      } finally {
        window.clearTimeout(timer)
      }
    }
    throw lastError ?? new Error('Frame upload failed')
  }

  async function flushBatch(force = false): Promise<void> {
    if (batchCount === 0) return
    if (!force && batchCount < batchFrames) return
    // Do not throw on prior upload errors during tail flush — still try to finish job.
    if (uploadError && !force) throw uploadError

    const bytes = frameByteLength * batchCount
    const filled = activeBatch
    // Hold `filled` until upload completes; subarray avoids an extra full copy.
    const payload = filled.subarray(0, bytes)
    batchCount = 0
    activeBatch = await acquireBatchBuffer()

    const task = postFramesWithRetry(payload)
      .catch((error: unknown) => {
        uploadError = error instanceof Error ? error : new Error('Frame upload failed')
        // Keep going; shortfall is better than hanging the whole export.
        logger.warn('export.frame_upload_failed', { error: describeError(uploadError) })
      })
      .finally(() => {
        releaseBatchBuffer(filled)
      })

    pendingUploads.push(task)
    // Bound wait: never block capture loop more than ~2s on backpressure.
    if (pendingUploads.length > maxInflight) {
      await Promise.race([
        Promise.allSettled(pendingUploads.splice(0, pendingUploads.length - maxInflight + 1)),
        new Promise<void>((resolve) => window.setTimeout(resolve, 2000))
      ])
    }
  }

  async function enqueueCapturedFrame(frame: Uint8Array): Promise<void> {
    if (framesProcessed >= captureTotal) return
    activeBatch.set(frame, batchCount * frameByteLength)
    batchCount += 1
    await flushBatch(false)
  }

  async function waitPendingUploads(ms: number): Promise<void> {
    try {
      await Promise.race([
        Promise.allSettled(pendingUploads.splice(0, pendingUploads.length)),
        new Promise<void>((resolve) => window.setTimeout(resolve, ms))
      ])
    } catch {
      // ignore
    }
  }

  async function finalizeSegmentFile(expectedFrames: number): Promise<void> {
    // Close encoder before validating — kill-before-trailer caused 15s-only outputs.
    try {
      await Promise.race([
        stopRenderSession(sessionKey),
        new Promise<void>((resolve) => window.setTimeout(resolve, 25_000))
      ])
    } catch (stopErr: unknown) {
      logger.warn('export.stop_session_issue', { error: describeError(stopErr) })
    }
    const minDur = Math.max(0.05, (Math.max(1, expectedFrames) - 2) / exportFps)
    // Brief FS settle.
    await new Promise<void>((r) => setTimeout(r, 150))
    const duration = await validateRenderSegment(outputPath, minDur * 0.5)
    logger.info('export.segment_ok', {
      outputPath,
      durationSec: duration,
      expectedFrames
    })
    logger.info('export.pipeline_done', {
      projectName,
      role: isWorker ? 'worker' : renderConfig.role ?? 'single',
      outputPath,
      framesProcessed,
      workerIndex: isWorker ? workerIndex : undefined
    })
  }

  const wallStartedAt = performance.now()
  let pauseAccumMs = 0
  let pauseStartedAt: number | null = null
  let remoteStopped = false
  let controlUnlisten: (() => void) | undefined
  const groupId = renderConfig.exportGroupId ?? renderConfig.sessionId
  if (groupId) {
    controlUnlisten = await listen<ExportControlEvent>('export-control', (event) => {
      if (event.payload.groupId !== groupId) return
      if (event.payload.action === 'pause') {
        if (pauseStartedAt === null) pauseStartedAt = performance.now()
      } else if (event.payload.action === 'resume') {
        if (pauseStartedAt !== null) {
          pauseAccumMs += performance.now() - pauseStartedAt
          pauseStartedAt = null
        }
      } else if (event.payload.action === 'stop') {
        remoteStopped = true
        if (pauseStartedAt !== null) {
          pauseAccumMs += performance.now() - pauseStartedAt
          pauseStartedAt = null
        }
      } else if (event.payload.action === 'truncate') {
        const ef = event.payload.endFrame
        if (typeof ef !== 'number' || !Number.isFinite(ef) || ef <= 0) return
        const locked = Math.floor(ef)
        // Clamp live exclusive end so in-flight workers stop at story end.
        if (!Number.isFinite(endFrame) || locked < endFrame) {
          endFrame = locked
          captureTotal = Math.max(1, Math.max(0, endFrame - startFrame))
        }
      }
    })
  }

  function wallElapsedSecNow(): number {
    const pausedExtra = pauseStartedAt !== null ? performance.now() - pauseStartedAt : 0
    return Math.max(0, (performance.now() - wallStartedAt - pauseAccumMs - pausedExtra) / 1000)
  }

  function shouldAbort(): boolean {
    return isCancelled() || remoteStopped
  }

  async function waitIfPaused(): Promise<void> {
    while (!shouldAbort()) {
      // Workers pause when coordinator emits pause (tracked via pauseStartedAt).
      // Single-export pause is driven by exportControlRef through a window flag.
      const paused =
        pauseStartedAt !== null ||
        (typeof window !== 'undefined' &&
          Boolean((window as unknown as { __MSS_EXPORT_PAUSED__?: boolean }).__MSS_EXPORT_PAUSED__))
      if (!paused) return
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
  }

  onStats({
    progress: 0,
    frameCount: 0,
    totalFrames: captureTotal,
    currentTime: 0,
    totalDuration: captureTotal / exportFps,
    fps: 0,
    speed: 1,
    status: startFrame > 0 ? 'warming' : 'rendering',
    workerLabel: isWorker ? `W${workerIndex}` : undefined,
    wallElapsedSec: 0,
    canPause: !isWorker,
    canStop: !isWorker,
    isPaused: false
  })
  await emitWorkerProgress(startFrame > 0 ? 'warming' : 'rendering', 0, 0, captureTotal, {
    wallElapsedSec: 0,
    fps: 0,
    speed: 0,
    warmProgress: 0,
    warmFrameCount: 0,
    warmTotalFrames: Math.max(0, startFrame)
  })

  // Overshoot past endFrame to flush PBO/batch lag; never upload more than captureTotal.
  const overshootPad = Math.max(4, batchFrames + 2)
  // Wall-clock phase markers for single/worker debug waterfall.
  let warmStartSec: number | null = startFrame > 0 ? 0 : null
  let warmEndSec: number | null = startFrame > 0 ? null : 0
  let captureStartSec: number | null = startFrame > 0 ? null : 0
  let captureEndSec: number | null = null
  let finalizeStartSec: number | null = null
  let finalizeEndSec: number | null = null

  function buildLocalTimingSpans(nowSec: number): TimingSpan[] {
    const spans: TimingSpan[] = []
    const lane = isWorker ? `W${workerIndex}` : 'main'
    if (warmStartSec !== null) {
      spans.push({
        id: `${lane}-warm`,
        label: `${lane} 预热`,
        lane,
        phase: 'warm',
        startSec: warmStartSec,
        endSec: warmEndSec ?? nowSec,
        state: warmEndSec === null ? 'running' : 'done'
      })
    }
    if (captureStartSec !== null) {
      spans.push({
        id: `${lane}-capture`,
        label: `${lane} 捕获`,
        lane,
        phase: 'capture',
        startSec: captureStartSec,
        endSec: captureEndSec ?? nowSec,
        state: captureEndSec === null ? 'running' : 'done'
      })
    }
    if (finalizeStartSec !== null) {
      spans.push({
        id: `${lane}-finalize`,
        label: `${lane} 收尾`,
        lane,
        phase: 'finalize',
        startSec: finalizeStartSec,
        endSec: finalizeEndSec ?? nowSec,
        state: finalizeEndSec === null ? 'running' : 'done'
      })
    }
    return spans
  }

  function publishCaptureStats(forceStatus?: RenderStats['status']): void {
    const avgDelta = avgFrameDeltaMs()
    const actualFps = avgDelta > 0 ? 1000 / avgDelta : 0
    const isWarming = globalFrameIndex < startFrame
    const reportFrames = Math.min(framesProcessed, captureTotal)
    const captureProgress = Math.min(1, reportFrames / Math.max(1, captureTotal))
    const warmTotal = Math.max(1, startFrame)
    const warmProgress = isWarming
      ? Math.min(0.999, globalFrameIndex / warmTotal)
      : startFrame > 0
        ? 1
        : 0
    const status: RenderStats['status'] =
      forceStatus ?? (isWarming ? 'warming' : 'rendering')
    const wallElapsedSec = wallElapsedSecNow()
    if (isWarming) {
      if (warmStartSec === null) warmStartSec = wallElapsedSec
    } else {
      if (warmStartSec !== null && warmEndSec === null) warmEndSec = wallElapsedSec
      if (captureStartSec === null) captureStartSec = wallElapsedSec
    }
    if (status === 'finalizing') {
      if (captureStartSec !== null && captureEndSec === null) captureEndSec = wallElapsedSec
      if (finalizeStartSec === null) finalizeStartSec = wallElapsedSec
    }
    if (status === 'done') {
      if (captureStartSec !== null && captureEndSec === null) captureEndSec = wallElapsedSec
      if (finalizeStartSec !== null && finalizeEndSec === null) finalizeEndSec = wallElapsedSec
    }
    const tickSpeed = exportFps > 0 ? actualFps / exportFps : 0
    const writeFps = isWarming ? 0 : actualFps
    const writeSpeed = isWarming ? 0 : tickSpeed
    const captureStoryTime = reportFrames / exportFps
    const singleSegments: ChunkBarSegment[] | undefined = !isWorker
      ? [
          {
            id: 'single',
            startFrame: 0,
            endFrame: captureTotal,
            progress: captureProgress,
            state: isWarming ? 'warming' : reportFrames >= captureTotal ? 'done' : 'running',
            label: 'main'
          }
        ]
      : [
          {
            id: `w-${workerIndex}`,
            jobId: currentJobId,
            startFrame,
            endFrame: Number.isFinite(endFrame) ? endFrame : startFrame + captureTotal,
            progress: captureProgress,
            state: isWarming ? 'warming' : reportFrames >= captureTotal ? 'done' : 'running',
            label: `W${workerIndex}`,
            slotIndex: workerIndex
          }
        ]
    onStats({
      progress: scaleCaptureProgress(captureProgress),
      frameCount: reportFrames,
      totalFrames: captureTotal,
      currentTime: captureStoryTime,
      totalDuration: captureTotal / exportFps,
      fps: writeFps,
      speed: writeSpeed,
      status,
      workerLabel: isWorker ? `W${workerIndex}` : undefined,
      wallElapsedSec,
      canPause: !isWorker,
      canStop: !isWorker,
      chunkSegments: singleSegments,
      timingSpans: buildLocalTimingSpans(wallElapsedSec),
      detailLines: [
        `模式: ${isWorker ? `W${workerIndex}` : '单路'}`,
        `帧 ${reportFrames}/${captureTotal}`,
        `墙钟 ${formatTime(wallElapsedSec)}`,
        `FPS ${writeFps.toFixed(1)} · Speed ${writeSpeed.toFixed(2)}x`,
        isWarming ? `预热 ${globalFrameIndex}/${startFrame}` : '捕获中'
      ],
      workerCards: isWorker
        ? [
            {
              index: workerIndex,
              status,
              progress: captureProgress,
              frameCount: reportFrames,
              totalFrames: captureTotal,
              warmProgress,
              warmFrameCount: isWarming ? globalFrameIndex : warmTotal,
              warmTotalFrames: warmTotal,
              fps: actualFps,
              speed: tickSpeed
            }
          ]
        : [
            {
              index: 0,
              status,
              progress: captureProgress,
              frameCount: reportFrames,
              totalFrames: captureTotal,
              warmProgress,
              warmFrameCount: isWarming ? globalFrameIndex : warmTotal,
              warmTotalFrames: warmTotal,
              fps: actualFps,
              speed: tickSpeed
            }
          ]
    })
    // Fire-and-forget: never block capture on Tauri IPC.
    void emitWorkerProgress(status, captureProgress, reportFrames, captureTotal, {
      fps: actualFps,
      speed: tickSpeed,
      wallElapsedSec,
      currentTime: captureStoryTime,
      totalDuration: captureTotal / exportFps,
      warmProgress,
      warmFrameCount: isWarming ? globalFrameIndex : warmTotal,
      warmTotalFrames: warmTotal
    })
  }

  /** Frames before startFrame where we must present+PBO to prime the pipeline. */
  const WARM_GPU_PRIME_FRAMES = 3
  /**
   * When pure-warming far from capture and story is idle, advance this many
   * virtual frames per step (Live2D gets combined dt). Keep 1 so story waits
   * (especially motion start→finish) are not skipped under multi-frame jumps.
   */
  const WARM_CLOCK_STEP = 1

  /**
   * Story snippets chain via async delays. Fixed huge drains waste warm time;
   * deepen only when the story may have scheduled new work.
   */
  async function drainStoryMicrotasks(maxTurns: number = 8): Promise<void> {
    const turns = Math.max(1, Math.min(48, Math.floor(maxTurns)))
    for (let i = 0; i < turns; i += 1) {
      await Promise.resolve()
    }
  }

  /**
   * Do not advance virtual time while story is blocked on Assets.load / startMotion, etc.
   * Otherwise multi-worker warm hits startFrame with the story still on early content.
   */
  async function waitForStoryExternalIdle(): Promise<void> {
    if (!isStoryAsyncPending()) return
    const startedAt: number = performance.now()
    let spins = 0
    // Hard cap: export must not hang forever on a stuck Assets.load / startMotion.
    const maxWaitMs: number = 10_000
    while (isStoryAsyncPending() && spins < 20_000 && !shouldAbort()) {
      if (performance.now() - startedAt > maxWaitMs) {
        logger.warn('export.story_async_wait_timeout', {
          workerIndex: isWorker ? workerIndex : 0,
          frame: globalFrameIndex,
          startFrame,
          waitedMs: Math.round(performance.now() - startedAt)
        })
        break
      }
      spins += 1
      await Promise.resolve()
      if (isStoryAsyncPending()) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 0)
        })
      }
    }
  }

  async function advanceStoryClock(deltaMs: number): Promise<void> {
    if (deltaMs <= 0) return
    // Do not advance virtual time while story is blocked on external async work.
    await waitForStoryExternalIdle()
    // Always drive story timers/VFX first so waitUntil(motion) and animations see this step.
    clock.advanceManual(deltaMs)
    // Yield so story awaits (Assets.load, startMotion, etc.) can progress between frames.
    await drainStoryMicrotasks(8)
    // Pixi/Live2D must use the same virtual timeline as the story (not wall clock).
    // Ticker.update(currentTime) derives deltaMS from currentTime - lastTime.
    app.ticker.update(clock.getSyntheticAppTimeMs())
    // Live2D applies delta only inside renderLive2D — render before polling isFinished.
    app.renderer.render({ container: app.stage })
    // Motion finish checks run on clock tasks; re-poll after Live2D advanced.
    clock.pollTasks()
    if (isStoryAsyncPending()) {
      await waitForStoryExternalIdle()
      await drainStoryMicrotasks(12)
      app.renderer.render({ container: app.stage })
      clock.pollTasks()
    } else {
      await drainStoryMicrotasks(4)
    }
  }

  async function captureOneStep(options: {
    advanceClock: boolean
    allowUpload: boolean
    /** When false, skip GPU present (rarely used). Warm must present near capture. */
    present?: boolean
  }): Promise<void> {
    const presentOpt = options.present !== false
    const frameIndexBefore = globalFrameIndex
    const enteredRange = frameIndexBefore >= startFrame
    const nearCapture = frameIndexBefore + WARM_GPU_PRIME_FRAMES >= startFrame
    // Live2D applies ticker delta only inside renderLive2D. Far warm MUST still render,
    // otherwise multi-worker segments stay frozen on the opening pose.
    // Readback/upload can stay gated to the capture window for throughput.
    const needPresent: boolean = presentOpt
    const needReadback: boolean =
      presentOpt && (nearCapture || enteredRange || !options.advanceClock)

    let framesToAdvance = 1
    let advancedStoryClock = false
    if (options.advanceClock) {
      // Never let the export frame index race ahead of the story timeline.
      // If the story is still running but has no clock tasks and no tracked async,
      // advancing would record an earlier pose at a later frame index (workers look early).
      const storyIdleWithoutWork: boolean =
        !storyDone && !clock.hasPendingTasks() && !isStoryAsyncPending()
      if (storyIdleWithoutWork && frameIndexBefore < startFrame && startFrame > 0) {
        hungWarmFrames += 1
        await waitForStoryExternalIdle()
        await drainStoryMicrotasks(16)
        if (!clock.hasPendingTasks() && !isStoryAsyncPending() && !storyDone) {
          if (hungWarmFrames >= Math.max(1, Math.ceil(exportFps * 1.0))) {
            logger.error('export.story_hung_during_warm', {
              workerIndex: isWorker ? workerIndex : 0,
              frame: frameIndexBefore,
              startFrame,
              endFrame: Number.isFinite(endFrame) ? endFrame : null,
              hungWarmFrames
            })
            throw new Error(
              `故事在预热阶段卡住 (frame=${frameIndexBefore} < startFrame=${startFrame}，无时钟任务)，无法渲染该分段`
            )
          }
          // Pump render so Live2D/UI can settle, but do NOT advance frame index.
          if (needPresent) {
            app.renderer.render({ container: app.stage })
          }
          const nowStuck = performance.now()
          pushFrameDelta(nowStuck - lastWall)
          lastWall = nowStuck
          return
        }
        hungWarmFrames = 0
      } else {
        hungWarmFrames = 0
      }

      const pureWarmFar = !nearCapture && !enteredRange
      // Multi-step only when far warm and not blocked on external I/O.
      if (pureWarmFar && !isStoryAsyncPending() && WARM_CLOCK_STEP > 1) {
        const remaining = Math.max(1, startFrame - frameIndexBefore - WARM_GPU_PRIME_FRAMES)
        framesToAdvance = Math.min(WARM_CLOCK_STEP, remaining)
      }
      await advanceStoryClock(frameIntervalMs * framesToAdvance)
      advancedStoryClock = true
      // Warm progress for coordinator (hidden workers previously looked stuck at ETA).
      if (pureWarmFar && frameIndexBefore % Math.max(1, Math.floor(exportFps * 2)) === 0) {
        logger.info('export.warm_tick', {
          workerIndex: isWorker ? workerIndex : 0,
          frame: frameIndexBefore,
          startFrame,
          endFrame: Number.isFinite(endFrame) ? endFrame : null,
          storyAsyncPending: isStoryAsyncPending(),
          pendingClockTasks: clock.hasPendingTasks(),
          storyDone
        })
      }
    }

    // advanceStoryClock already rendered; re-present when we need a stable capture surface.
    if (needPresent && (!options.advanceClock || needReadback || !advancedStoryClock)) {
      app.renderer.render({ container: app.stage })
    }

    if (needReadback) {
      // PBO returns the previous frame. Overshoot re-renders without advancing story time.
      const previous = pixelReader.capture(readyFrame)
      // Upload uses the story time of this step (index before advance).
      if (
        previous &&
        options.allowUpload &&
        frameIndexBefore >= startFrame &&
        framesProcessed < captureTotal
      ) {
        await enqueueCapturedFrame(readyFrame)
        framesProcessed += 1
      }
    }

    if (options.advanceClock && advancedStoryClock) {
      globalFrameIndex = frameIndexBefore + framesToAdvance
    }

    const now = performance.now()
    const delta = now - lastWall
    lastWall = now
    pushFrameDelta(delta)
  }

  async function flushCaptureTail(): Promise<void> {
    // Extra GPU frames only — do not advance virtual clock (keeps sticky continue correct).
    for (let i = 0; i < overshootPad && framesProcessed < captureTotal && !shouldAbort(); i += 1) {
      await captureOneStep({ advanceClock: false, allowUpload: true })
    }
    for (let i = 0; i < 2; i += 1) {
      const tail = pixelReader.finish(readyFrame)
      if (tail && framesProcessed < captureTotal) {
        await enqueueCapturedFrame(readyFrame)
        framesProcessed += 1
      } else {
        break
      }
    }
    if (framesProcessed > 0 && framesProcessed < captureTotal) {
      const shortfall = captureTotal - framesProcessed
      if (shortfall <= overshootPad) {
        for (let i = 0; i < shortfall; i += 1) {
          await enqueueCapturedFrame(readyFrame)
          framesProcessed += 1
        }
      }
    }
    // Force flush remaining batch, but never hang more than a few seconds.
    try {
      await Promise.race([
        flushBatch(true),
        new Promise<void>((resolve) => window.setTimeout(resolve, 3000))
      ])
    } catch {
      // ignore
    }
    await waitPendingUploads(2500)
    framesProcessed = Math.min(framesProcessed, captureTotal)
  }

  try {
    while (!shouldAbort()) {
      await waitIfPaused()
      if (shouldAbort()) break
      if (uploadError) throw uploadError

      // Soft caps for unbounded single export
      if (!Number.isFinite(endFrame)) {
        // Hard safety only — prefer storyDone + idle timers to decide true end.
        if (framesProcessed >= Math.max(totalFrames * 8, exportFps * 60 * 30)) break
      } else {
        // Job end: stop advancing story once exclusive endFrame reached.
        if (globalFrameIndex >= endFrame) break
      }

      await captureOneStep({ advanceClock: true, allowUpload: true })

      if (performance.now() - lastStatsAt > 500) {
        lastStatsAt = performance.now()
        publishCaptureStats()
      }

      // Story finished before this worker reached its capture range: warm only advanced
      // an empty timeline and would capture a frozen "opening" pose. Fail hard.
      if (
        storyDone &&
        !clock.hasPendingTasks() &&
        globalFrameIndex < startFrame &&
        startFrame > 0
      ) {
        logger.error('export.story_exhausted_during_warm', {
          workerIndex: isWorker ? workerIndex : 0,
          frame: globalFrameIndex,
          startFrame,
          endFrame: Number.isFinite(endFrame) ? endFrame : null,
          finishedNaturally: storyFinishedNaturally,
          storyError: storyError ? describeError(storyError) : null
        })
        throw new Error(
          storyFinishedNaturally
            ? `故事在预热阶段提前结束 (frame=${globalFrameIndex} < startFrame=${startFrame})，无法渲染该分段`
            : `故事在预热阶段异常结束 (frame=${globalFrameIndex} < startFrame=${startFrame})，无法渲染该分段`
        )
      }

      // Detect real story end for coordinator trim.
      // Only report after we have actually captured frames in-range (not during pure warm),
      // and only once the story has been idle for a meaningful stretch.
      if (storyDone && globalFrameIndex >= startFrame && framesProcessed > 0) {
        if (!clock.hasPendingTasks()) {
          idleAfterStoryFrames += 1
          if (idleAfterStoryFrames === Math.max(1, Math.ceil(exportFps * 0.5))) {
            logger.info('export.story_done_observed', {
              workerIndex: isWorker ? workerIndex : 0,
              frame: globalFrameIndex,
              startFrame,
              endFrame: Number.isFinite(endFrame) ? endFrame : null,
              framesProcessed
            })
            void emitWorkerProgress(
              'rendering',
              Math.min(0.999, framesProcessed / Math.max(1, captureTotal)),
              framesProcessed,
              captureTotal,
              {
                storyEndedAtFrame: globalFrameIndex,
                wallElapsedSec: wallElapsedSecNow(),
                message: `storyDone@${globalFrameIndex}`
              }
            )
          }
          // Stop after short idle past story end (single + parallel). Prevents black tail
          // and lets coordinator trim plan via storyEndedAtFrame.
          if (idleAfterStoryFrames >= maxIdleAfterStory) break
          if (Number.isFinite(endFrame) && globalFrameIndex >= endFrame) break
        } else {
          idleAfterStoryFrames = 0
          hungWarmFrames = 0
        }
      }
    }

    if (shouldAbort()) {
      throw new Error('渲染已取消')
    }

    publishCaptureStats('finalizing')
    await Promise.race([
      flushCaptureTail(),
      new Promise<void>((resolve) => window.setTimeout(resolve, 6000))
    ])
    if (shouldAbort()) {
      throw new Error('渲染已取消')
    }
    if (storyError) throw storyError
    void runPromise.catch(() => undefined)
    if (uploadError) {
      logger.warn('export.upload_after_capture_failed', { error: describeError(uploadError) })
    }

    framesProcessed = Math.min(framesProcessed, captureTotal)
    const reportDoneFrames = framesProcessed
    // Must finalize encoder + validate moov BEFORE done, or concat yields short/corrupt video.
    await finalizeSegmentFile(reportDoneFrames)
    if (shouldAbort()) {
      throw new Error('渲染已取消')
    }

    const finalWall = wallElapsedSecNow()
    const storySeconds = reportDoneFrames / exportFps
    const avgSpeed = finalWall > 0 ? storySeconds / finalWall : 0
    const avgFps = finalWall > 0 ? reportDoneFrames / finalWall : 0
    const efficiencyLines = [
      `时间轴长度: ${formatTime(storySeconds)}`,
      `总渲染耗时: ${formatTime(finalWall)}`,
      `全程平均 FPS: ${avgFps.toFixed(1)}`,
      `全程平均 Speed: ${avgSpeed.toFixed(2)}x`,
      `平均效率: ${avgSpeed.toFixed(2)}x（故事时间/墙钟时间）`,
      `输出帧数: ${reportDoneFrames}/${captureTotal}`,
      isWorker
        ? `分段: [${startFrame}, ${Number.isFinite(endFrame) ? endFrame : '∞'})`
        : '模式: 单路渲染'
    ]

    onStats({
      progress: 1,
      frameCount: reportDoneFrames,
      totalFrames: captureTotal,
      currentTime: storySeconds,
      totalDuration: captureTotal / exportFps,
      fps: avgFps,
      speed: avgSpeed,
      status: 'done',
      workerLabel: isWorker ? `W${workerIndex}` : undefined,
      wallElapsedSec: finalWall,
      detailLines: efficiencyLines,
      efficiency: avgSpeed,
      canPause: false,
      canStop: false
    })

    /** Arm assign listener before emitting done — coordinator may assign immediately. */
    async function armNextJobWait(): Promise<{ wait: Promise<JobAssignEvent | null> }> {
      let nextResolve: ((job: JobAssignEvent | null) => void) | null = null
      const nextJobPromise = new Promise<JobAssignEvent | null>((resolve) => {
        nextResolve = resolve
      })
      let settled = false
      const unlistenRef: { current: (() => void) | null } = { current: null }
      const finishWait = (job: JobAssignEvent | null): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        unlistenRef.current?.()
        unlistenRef.current = null
        nextResolve?.(job)
      }
      const timer = window.setTimeout(() => finishWait(null), 120_000)
      unlistenRef.current = await listen<JobAssignEvent>('export-job-assign', (event) => {
        const p = event.payload
        if (p.sessionId !== groupIdForJobs || p.workerIndex !== workerIndex) return
        finishWait(p)
      })
      return { wait: nextJobPromise }
    }

    let pendingNextJob: Promise<JobAssignEvent | null> | null = null
    if (multiJob && groupIdForJobs) {
      pendingNextJob = (await armNextJobWait()).wait
    }

    await emitWorkerProgress('done', 1, reportDoneFrames, captureTotal, {
      wallElapsedSec: finalWall,
      speed: avgSpeed,
      currentTime: storySeconds,
      warmProgress: startFrame > 0 ? 1 : 0,
      warmFrameCount: Math.max(0, startFrame),
      warmTotalFrames: Math.max(0, startFrame)
    })

    if (Number.isFinite(endFrame)) {
      // Prefer actual captured end when story-end truncated the exclusive range early.
      const actualEnd = startFrame + reportDoneFrames
      globalFrameIndex = Math.max(globalFrameIndex, Math.min(endFrame, actualEnd))
    }

    // Multi-job sticky continue: wait was armed before the done emit above.
    while (multiJob && groupIdForJobs && pendingNextJob && !shouldAbort()) {
      const nextJob = await pendingNextJob
      pendingNextJob = null
      if (!nextJob || nextJob.jobId < 0) break
      if (shouldAbort()) break

      // Keep state: allow pure sticky (start≈at) or forward catch-up (start>at).
      // Never accept start < at (would need rewind / restart from 0).
      const at = globalFrameIndex
      if (nextJob.startFrame < at - 1) {
        logger.error('export.job_rejected_backward', {
          workerIndex,
          jobId: nextJob.jobId,
          startFrame: nextJob.startFrame,
          atFrame: at
        })
        await emitWorkerProgress('error', 0, 0, 1, {
          message: `倒退任务被拒绝 start=${nextJob.startFrame} at=${at}`
        })
        pendingNextJob = (await armNextJobWait()).wait
        continue
      }

      sessionKey = nextJob.sessionKey
      startFrame = nextJob.startFrame
      endFrame = nextJob.endFrame
      outputPath = nextJob.segmentPath
      currentJobId = nextJob.jobId
      captureTotal = Math.max(1, endFrame - startFrame)
      framesProcessed = 0
      idleAfterStoryFrames = 0
      hungWarmFrames = 0

      // Forward catch-up: full story sim (tick+render); no upload until capture range.
      if (globalFrameIndex < startFrame) {
        const catchFrom = globalFrameIndex
        logger.info('export.catchup_warm', {
          workerIndex,
          fromFrame: catchFrom,
          toFrame: startFrame
        })
        while (!shouldAbort() && globalFrameIndex < startFrame) {
          await waitIfPaused()
          if (shouldAbort()) break
          // Must render every frame so later workers don't freeze on story-start visuals.
          await captureOneStep({
            advanceClock: true,
            allowUpload: false,
            present: true
          })
          const now = performance.now()
          if (now - lastStatsAt > 500) {
            lastStatsAt = now
            const warmTotal = Math.max(1, startFrame - catchFrom)
            const warmDone = Math.min(warmTotal, globalFrameIndex - catchFrom)
            const avgDelta = avgFrameDeltaMs()
            const actualFps = avgDelta > 0 ? 1000 / avgDelta : 0
            void emitWorkerProgress('warming', 0, 0, captureTotal, {
              fps: actualFps,
              speed: exportFps > 0 ? actualFps / exportFps : 0,
              wallElapsedSec: wallElapsedSecNow(),
              warmProgress: Math.min(0.999, warmDone / warmTotal),
              warmFrameCount: globalFrameIndex,
              warmTotalFrames: startFrame,
              message: `追赶 ${catchFrom}→${startFrame}`
            })
          }
        }
      } else if (Math.abs(globalFrameIndex - startFrame) <= 1) {
        globalFrameIndex = startFrame
      }

      if (shouldAbort()) break

      uploadUrl = (
        await startRenderSession(sessionKey, {
          exportPath: outputPath,
          width: exportWidth,
          height: exportHeight,
          fps: exportFps,
          sessionId: sessionKey
        })
      ).uploadUrl

      // Capture range; overshoot flush discards excess (no clock advance past end in flush).
      while (!shouldAbort()) {
        await waitIfPaused()
        if (shouldAbort()) break
        if (uploadError) throw uploadError
        if (globalFrameIndex >= endFrame) break
        await captureOneStep({ advanceClock: true, allowUpload: true })
        if (performance.now() - lastStatsAt > 500) {
          lastStatsAt = performance.now()
          publishCaptureStats()
        }
        if (storyDone && !clock.hasPendingTasks()) {
          idleAfterStoryFrames += 1
          if (idleAfterStoryFrames >= maxIdleAfterStory) break
        } else {
          idleAfterStoryFrames = 0
          hungWarmFrames = 0
        }
      }
      if (shouldAbort()) {
        throw new Error('渲染已取消')
      }
      publishCaptureStats('finalizing')
      await Promise.race([
        flushCaptureTail(),
        new Promise<void>((resolve) => window.setTimeout(resolve, 6000))
      ])
      if (shouldAbort()) {
        throw new Error('渲染已取消')
      }
      framesProcessed = Math.min(framesProcessed, captureTotal)
      await finalizeSegmentFile(framesProcessed)
      if (shouldAbort()) {
        throw new Error('渲染已取消')
      }

      const contWall = wallElapsedSecNow()
      const contSeconds = framesProcessed / exportFps
      const contSpeed = contWall > 0 ? contSeconds / contWall : 0
      // Arm next assign before done so a fast coordinator cannot race the listener.
      pendingNextJob = (await armNextJobWait()).wait
      await emitWorkerProgress('done', 1, framesProcessed, captureTotal, {
        wallElapsedSec: contWall,
        speed: contSpeed,
        currentTime: contSeconds,
        warmProgress: 1,
        warmFrameCount: startFrame,
        warmTotalFrames: startFrame
      })
      if (Number.isFinite(endFrame)) {
        const actualEnd = startFrame + framesProcessed
        globalFrameIndex = Math.max(globalFrameIndex, Math.min(endFrame, actualEnd))
      }
    }
    if (shouldAbort()) {
      throw new Error('渲染已取消')
    }
  } catch (error: unknown) {
    await Promise.allSettled(pendingUploads)
    await stopRenderSession(sessionKey).catch(() => undefined)
    const message = error instanceof Error ? error.message : 'Export failed'
    await emitWorkerProgress(
      'error',
      framesProcessed / Math.max(1, captureTotal),
      framesProcessed,
      captureTotal,
      { message, wallElapsedSec: wallElapsedSecNow() }
    )
    throw error
  } finally {
    controlUnlisten?.()
    pixelReader.destroy()
    clock.setTickerDriven(true)
    app.ticker.autoStart = true
  }
}

async function runCoordinatorExport(options: {
  projectName: string
  story: StoryData
  renderConfig: RenderConfig
  dataPath: string
  isCancelled: () => boolean
  onStats: (stats: RenderStats) => void
  controlRef: {
    paused: boolean
    stopped: boolean
    groupId?: string
  }
}): Promise<void> {
  const { projectName, story, renderConfig, dataPath, isCancelled, onStats, controlRef } = options
  const exportFps = Math.max(1, Math.floor(Number(renderConfig.fps) || 60))
  const concurrency = clampConcurrency(renderConfig.concurrency)
  // Sticky-only lanes: concurrency == fixed worker count (no spare cold-starts).
  const { estimatedSec, planningSec } = planExportDuration(story)
  let totalDuration = planningSec
  let totalFrames = Math.max(1, Math.ceil(totalDuration * exportFps))
  const estimatedDuration = estimatedSec
  const estimatedFrames = Math.max(1, Math.ceil(estimatedDuration * exportFps))
  let runtimeExtendedFrames = 0
  /** Locked when any worker reports storyDone frame; trims black tail. */
  let knownEndFrame: number | null = null
  const CATCHUP_BUDGET_FRAMES = Math.max(exportFps * 2, 120) // ~2s default
  const wallStartedAt = performance.now()
  let pauseAccumMs = 0
  let pauseStartedAt: number | null = null
  const STALL_MS = 20_000
  const MAX_ATTEMPTS = 3

  const wallElapsedSecNow = (): number => {
    const extra = pauseStartedAt !== null ? performance.now() - pauseStartedAt : 0
    return Math.max(0, (performance.now() - wallStartedAt - pauseAccumMs - extra) / 1000)
  }

  onStats({
    progress: 0,
    frameCount: 0,
    totalFrames,
    currentTime: 0,
    totalDuration,
    fps: 0,
    speed: 0,
    status: 'rendering',
    message: `任务队列启动 · ${concurrency} 线程`,
    wallElapsedSec: 0,
    canPause: true,
    canStop: true,
    isPaused: false,
    detailLines: [
      `故事时间轴 ${formatTime(totalDuration)}`,
      `目标 ${totalFrames} 帧 @ ${exportFps}fps`,
      `线程 ${concurrency} · 跑完一块立刻下一块`
    ]
  })

  const prepared = await prepareParallelExport({
    projectName,
    exportPath: renderConfig.exportPath,
    concurrency: 1,
    totalFrames,
    width: Math.max(1, Math.floor(renderConfig.width) || 1920),
    height: Math.max(1, Math.floor(renderConfig.height) || 1080),
    fps: exportFps,
    dataPath
  })

  controlRef.groupId = prepared.sessionId
  controlRef.paused = false
  controlRef.stopped = false

  const planner = createLaneJobPlanner(totalFrames, concurrency)
  /** Retried jobs waiting per slot (prefer sticky within that slot's lane). */
  const freeJobsBySlot = new Map<number, ExportJob[]>()
  for (let i = 0; i < concurrency; i += 1) freeJobsBySlot.set(i, [])
  const completed = new Map<number, ExportJob>()
  const completedFramesByJob = new Map<number, number>()
  let recentRetries = 0
  let recentStable = 0

  type SlotState = {
    status: RenderStats['status']
    job: ExportJob | null
    frameCount: number
    totalFrames: number
    warmProgress: number
    warmFrameCount: number
    warmTotalFrames: number
    fps: number
    speed: number
    lastProgressAt: number
    lastFrameCount: number
    lastWarmFrameCount: number
    lastEndFrame: number | null
    message?: string
    /** Wall-clock phase spans for waterfall (sec from export start). */
    warmStartSec: number | null
    warmEndSec: number | null
    captureStartSec: number | null
    captureEndSec: number | null
    finalizeStartSec: number | null
    finalizeEndSec: number | null
  }

  const slots = new Map<number, SlotState>()
  for (let i = 0; i < concurrency; i += 1) {
    slots.set(i, {
      status: 'warming',
      job: null,
      frameCount: 0,
      totalFrames: 1,
      warmProgress: 0,
      warmFrameCount: 0,
      warmTotalFrames: 0,
      fps: 0,
      speed: 0,
      lastProgressAt: Date.now(),
      lastFrameCount: 0,
      lastWarmFrameCount: 0,
      lastEndFrame: null,
      warmStartSec: null,
      warmEndSec: null,
      captureStartSec: null,
      captureEndSec: null,
      finalizeStartSec: null,
      finalizeEndSec: null
    })
  }

  let mergeStartSec: number | null = null
  let mergeEndSec: number | null = null
  /** While true, coordinator heartbeat must not overwrite concatenating UI. */
  let mergingPhase = false

  function noteSlotPhase(slot: SlotState, status: RenderStats['status']): void {
    const t = wallElapsedSecNow()
    if (status === 'warming') {
      if (slot.warmStartSec === null) slot.warmStartSec = t
    } else if (status === 'rendering') {
      if (slot.warmStartSec !== null && slot.warmEndSec === null) slot.warmEndSec = t
      if (slot.captureStartSec === null) slot.captureStartSec = t
    } else if (status === 'finalizing') {
      if (slot.captureStartSec !== null && slot.captureEndSec === null) slot.captureEndSec = t
      if (slot.warmStartSec !== null && slot.warmEndSec === null) slot.warmEndSec = t
      if (slot.finalizeStartSec === null) slot.finalizeStartSec = t
    } else if (status === 'done') {
      if (slot.finalizeStartSec !== null && slot.finalizeEndSec === null) slot.finalizeEndSec = t
      if (slot.captureStartSec !== null && slot.captureEndSec === null) slot.captureEndSec = t
      if (slot.warmStartSec !== null && slot.warmEndSec === null) slot.warmEndSec = t
    } else if (status === 'error') {
      if (slot.captureStartSec !== null && slot.captureEndSec === null) slot.captureEndSec = t
      if (slot.warmStartSec !== null && slot.warmEndSec === null) slot.warmEndSec = t
      if (slot.finalizeStartSec !== null && slot.finalizeEndSec === null) slot.finalizeEndSec = t
    }
  }

  function buildTimingSpans(nowSec: number): TimingSpan[] {
    const spans: TimingSpan[] = []
    for (const [idx, slot] of [...slots.entries()].sort((a, b) => a[0] - b[0])) {
      const lane = `W${idx}`
      if (slot.warmStartSec !== null) {
        const end =
          slot.warmEndSec ??
          (slot.status === 'warming' ? nowSec : slot.warmEndSec ?? slot.warmStartSec)
        spans.push({
          id: `w${idx}-warm`,
          label: `${lane} 预热`,
          lane,
          phase: 'warm',
          startSec: slot.warmStartSec,
          endSec: Math.max(slot.warmStartSec, end),
          state:
            slot.status === 'error'
              ? 'error'
              : slot.warmEndSec !== null
                ? 'done'
                : slot.status === 'warming'
                  ? 'running'
                  : 'done'
        })
      }
      if (slot.captureStartSec !== null) {
        const end =
          slot.captureEndSec ??
          (slot.status === 'rendering' ? nowSec : slot.captureEndSec ?? slot.captureStartSec)
        spans.push({
          id: `w${idx}-cap`,
          label: `${lane} 捕获`,
          lane,
          phase: 'capture',
          startSec: slot.captureStartSec,
          endSec: Math.max(slot.captureStartSec, end),
          state:
            slot.status === 'error'
              ? 'error'
              : slot.captureEndSec !== null
                ? 'done'
                : slot.status === 'rendering'
                  ? 'running'
                  : 'done'
        })
      }
      if (slot.finalizeStartSec !== null) {
        const end =
          slot.finalizeEndSec ??
          (slot.status === 'finalizing' ? nowSec : slot.finalizeEndSec ?? slot.finalizeStartSec)
        spans.push({
          id: `w${idx}-fin`,
          label: `${lane} 收尾`,
          lane,
          phase: 'finalize',
          startSec: slot.finalizeStartSec,
          endSec: Math.max(slot.finalizeStartSec, end),
          state:
            slot.status === 'error'
              ? 'error'
              : slot.finalizeEndSec !== null
                ? 'done'
                : slot.status === 'finalizing'
                  ? 'running'
                  : 'done'
        })
      }
    }
    if (mergeStartSec !== null) {
      const end = mergeEndSec ?? nowSec
      spans.push({
        id: 'merge',
        label: '合并压制',
        lane: 'merge',
        phase: 'merge',
        startSec: mergeStartSec,
        endSec: Math.max(mergeStartSec, end),
        state: mergeEndSec !== null ? 'done' : 'running'
      })
    }
    return spans
  }

  function makeJob(
    partial: Omit<ExportJob, 'segmentPath' | 'sessionKey' | 'attempts'>,
    attempts = 0
  ): ExportJob {
    const paths = buildJobPaths(prepared.sessionId, prepared.tempDir, partial)
    return { ...partial, ...paths, attempts }
  }

  function claimJob(slotId: number): ExportJob | null {
    const slot = slots.get(slotId)
    const lastEnd = slot?.lastEndFrame ?? null
    const free = freeJobsBySlot.get(slotId) ?? []

    // Fastest wall-clock: minimize (job.start - lastEnd) among work this slot can do.
    // 1) Local free queue: sticky first, then nearest forward.
    if (lastEnd !== null) {
      const sticky = free.find((j) => j.startFrame === lastEnd)
      if (sticky) {
        free.splice(free.indexOf(sticky), 1)
        return sticky
      }
      const forward = free
        .filter((j) => j.startFrame >= lastEnd)
        .sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)[0]
      if (forward) {
        free.splice(free.indexOf(forward), 1)
        return forward
      }
    } else if (free.length > 0) {
      const lane0 = planner.lanes.find((l) => l.slotId === slotId)
      const first = free.find((j) => j.startFrame === (lane0?.laneStart ?? 0)) ?? free[0]
      if (first) {
        free.splice(free.indexOf(first), 1)
        return first
      }
    }

    // 2) Mint: prefer own lane at lastEnd / first job, else nearest unminted S >= lastEnd.
    const own = planner.lanes.find((l) => l.slotId === slotId)
    if (!own) return null

    if (lastEnd === null) {
      // First job for this slot — start at own laneStart (one 0→laneStart warm allowed).
      if (own.nextFrame !== own.laneStart) return null
      const planned = planner.takeForSlot(slotId, exportFps, { recentRetries, recentStable })
      return planned ? makeJob(planned, 0) : null
    }

    // Own lane sticky mint
    if (own.nextFrame === lastEnd && own.nextFrame < own.laneEnd) {
      const planned = planner.takeForSlot(slotId, exportFps, { recentRetries, recentStable })
      if (planned) return makeJob(planned, 0)
    }

    // Global nearest unminted start S >= lastEnd
    type Cand = { laneSlot: number; s: number }
    const cands: Cand[] = []
    for (const l of planner.lanes) {
      if (l.nextFrame < l.laneEnd && l.nextFrame >= lastEnd) {
        cands.push({ laneSlot: l.slotId, s: l.nextFrame })
      }
    }
    if (cands.length === 0) return null
    cands.sort((a, b) => a.s - b.s || a.laneSlot - b.laneSlot)
    const best = cands[0]
    const gap = best.s - lastEnd

    // If another idle worker is strictly closer to S, let them take it (faster wall clock).
    for (const [otherId, other] of slots) {
      if (otherId === slotId) continue
      if (other.job) continue
      if (other.lastEndFrame === null) continue
      if (other.lastEndFrame > best.s) continue
      const otherGap = best.s - other.lastEndFrame
      if (otherGap < gap) {
        // Nearer idle worker exists — do not far-claim.
        return null
      }
      if (otherGap === gap && other.lastEndFrame === best.s && lastEnd !== best.s) {
        // Prefer true sticky owner.
        return null
      }
    }

    // Suppress unhelpful long catch-up unless we are the unique candidate.
    const nearerBusyOnly = gap > CATCHUP_BUDGET_FRAMES
    if (nearerBusyOnly) {
      let someoneNearerExists = false
      for (const [otherId, other] of slots) {
        if (otherId === slotId) continue
        if (other.lastEndFrame === null) continue
        if (other.lastEndFrame <= best.s && best.s - other.lastEndFrame < gap) {
          someoneNearerExists = true
          break
        }
      }
      if (someoneNearerExists) return null
    }

    const planned = planner.takeForSlot(best.laneSlot, exportFps, {
      recentRetries,
      recentStable
    })
    if (!planned || planned.startFrame < lastEnd) return null
    if (planned.startFrame === lastEnd) {
      logger.info('export.sticky_attach', {
        slotId,
        startFrame: planned.startFrame,
        endFrame: planned.endFrame
      })
    } else {
      logger.info('export.nearest_catchup', {
        slotId,
        gap: planned.startFrame - lastEnd,
        startFrame: planned.startFrame,
        endFrame: planned.endFrame
      })
    }
    return makeJob({ ...planned, slotId }, 0)
  }

  function freeJobsCount(): number {
    let n = 0
    for (const arr of freeJobsBySlot.values()) n += arr.length
    return n
  }

  type CatchUpAssessment = {
    lagging: Array<{
      slotId: number
      etaSec: number
      aheadEtaSec: number
      canCatchUp: boolean
      remainingWarm: number
      remainingCapture: number
    }>
    anyCannotCatchUp: boolean
  }

  function assessWarmCatchUp(): CatchUpAssessment {
    const writing: Array<{ etaSec: number }> = []
    const warming: Array<{
      slotId: number
      remainingWarm: number
      remainingCapture: number
      fps: number
    }> = []
    for (const [slotId, slot] of slots) {
      if (!slot.job) continue
      const fps = Math.max(1, slot.fps || exportFps * 0.4)
      if (slot.status === 'warming') {
        const remainingWarm = Math.max(
          0,
          (slot.warmTotalFrames || slot.job.startFrame) - slot.warmFrameCount
        )
        const remainingCapture = Math.max(0, slot.totalFrames - slot.frameCount)
        warming.push({ slotId, remainingWarm, remainingCapture, fps })
      } else if (slot.status === 'rendering' || slot.status === 'finalizing') {
        const remainingCapture = Math.max(0, slot.totalFrames - slot.frameCount)
        writing.push({ etaSec: remainingCapture / fps })
      }
    }
    const lagging: CatchUpAssessment['lagging'] = []
    for (const w of warming) {
      const totalEta = (w.remainingWarm + w.remainingCapture) / w.fps
      const aheadEta = writing.length > 0 ? Math.max(...writing.map((x) => x.etaSec)) : 0
      const canCatchUp = writing.length === 0 || totalEta <= aheadEta + 8
      lagging.push({
        slotId: w.slotId,
        etaSec: totalEta,
        aheadEtaSec: aheadEta,
        canCatchUp,
        remainingWarm: w.remainingWarm,
        remainingCapture: w.remainingCapture
      })
    }
    return { lagging, anyCannotCatchUp: lagging.some((l) => !l.canCatchUp) }
  }

  async function rebalanceIfWarmLagging(): Promise<void> {
    // Sticky-only policy: never hand off lane work (would force cold warm-up).
    const assessment = assessWarmCatchUp()
    for (const lag of assessment.lagging) {
      const slot = slots.get(lag.slotId)
      if (!slot) continue
      if (!lag.canCatchUp) {
        slot.message = `预热偏慢 ETA ${lag.etaSec.toFixed(0)}s（粘连保留，不移交）`
        logger.warn('export.warm_lag_sticky_only', {
          slotId: lag.slotId,
          etaSec: lag.etaSec,
          aheadEtaSec: lag.aheadEtaSec
        })
      }
    }
  }

  function applyKnownEndFrame(endFrameAbs: number, sourceWorker?: number): void {
    // Ignore implausibly early ends (common when a lagging worker finishes story early).
    const minPlausible = Math.max(1, Math.floor(estimatedFrames * 0.5))
    if (endFrameAbs < minPlausible) {
      logger.warn('export.story_end_ignored_early', {
        endFrameAbs,
        sourceWorker,
        minPlausible
      })
      return
    }
    const pad = Math.ceil(exportFps * 0.35)
    const locked = Math.max(1, endFrameAbs + pad)
    if (knownEndFrame !== null && locked >= knownEndFrame) return
    const prevKnown = knownEndFrame
    // Prefer later ends: only shrink, never take a much earlier worker's guess over a later one.
    knownEndFrame = knownEndFrame === null ? locked : Math.min(knownEndFrame, locked)
    if (knownEndFrame >= totalFrames) {
      logger.info('export.story_end_detected', {
      endFrameAbs,
      planFrames: totalFrames,
      shrunk: false
    })
      return
    }
    const prev = totalFrames
    planner.shrinkTotalFrames(knownEndFrame)
    totalFrames = planner.totalFrames
    totalDuration = totalFrames / exportFps
    // Truncate in-flight / queued jobs past known end.
    for (const [, arr] of freeJobsBySlot) {
      for (const j of arr) {
        if (j.endFrame > totalFrames) j.endFrame = totalFrames
      }
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        if (arr[i].startFrame >= arr[i].endFrame) arr.splice(i, 1)
      }
    }
    for (const [, s] of slots) {
      if (s.job && s.job.startFrame >= totalFrames) {
        // Job entirely past story end — drop; worker will stop via truncate.
        s.job = null
        s.status = 'done'
        s.totalFrames = 1
        continue
      }
      if (s.job && s.job.endFrame > totalFrames) {
        s.job.endFrame = totalFrames
        s.totalFrames = Math.max(1, s.job.endFrame - s.job.startFrame)
      }
    }
    // Push exclusive end to in-flight workers (they keep local endFrame otherwise).
    void emit('export-control', {
      groupId: prepared.sessionId,
      action: 'truncate',
      endFrame: totalFrames
    } satisfies ExportControlEvent)
    logger.info('export.story_end_trim', {
      endFrameAbs,
      sourceWorker,
      prevFrames: prev,
      totalFrames,
      prevKnown
    })
  }

  function maybeExtendFromProgress(payload: WorkerProgressEvent): void {
    if (typeof payload.storyEndedAtFrame === 'number' && payload.storyEndedAtFrame > 0) {
      // Only trust end reports from workers that are writing frames (not pure warm).
      if (payload.status === 'warming' || (payload.frameCount ?? 0) <= 0) {
        return
      }
      applyKnownEndFrame(payload.storyEndedAtFrame, payload.workerIndex)
    }
    // After known end, never grow past it.
    if (knownEndFrame !== null) return
    let observed = 0
    if (payload.status === 'warming') {
      observed = Math.max(0, payload.warmFrameCount ?? 0)
    }
    const captured = captureFrameCount()
    const need = Math.max(observed + Math.ceil(exportFps * 2), captured)
    if (need <= totalFrames) return
    const grown = Math.max(need, totalFrames + Math.ceil(exportFps * 2))
    const prev = totalFrames
    planner.extendTotalFrames(grown)
    totalFrames = planner.totalFrames
    totalDuration = totalFrames / exportFps
    runtimeExtendedFrames += totalFrames - prev
    logger.info('export.plan_extended', { prevFrames: prev, totalFrames })
  }

  /** Keep unminted remainder on the same slot only (sticky). Never publish to other slots. */
  function parkLaneRemainderOnSlot(slotId: number): void {
    const local = freeJobsBySlot.get(slotId) ?? []
    const abandoned = planner.abandonSlotRemainder(slotId, exportFps, {
      recentRetries,
      recentStable
    })
    for (const partial of abandoned) {
      local.push(makeJob(partial, 0))
    }
    freeJobsBySlot.set(slotId, local)
    logger.warn('export.remainder_parked_sticky', {
      slotId,
      count: abandoned.length
    })
  }

  /**
   * Auto spare worker: when orphan work exists and no idle healthy slot can take it,
   * spawn an extra slot (≤ maxSlots) that only steals orphans / free work.
   */

  function captureFrameCount(): number {
    let sum = 0
    for (const frames of completedFramesByJob.values()) sum += frames
    for (const slot of slots.values()) {
      if (slot.job && !completed.has(slot.job.jobId)) {
        sum += Math.max(0, slot.frameCount)
      }
    }
    return Math.min(totalFrames, sum)
  }

  function allWorkDone(): boolean {
    if (planner.hasRemaining()) return false
    if (freeJobsCount() > 0) return false
    for (const slot of slots.values()) {
      if (slot.job) return false
    }
    return completed.size > 0 || totalFrames === 0
  }

  const publishCoordinatorStatus = (): void => {
    if (mergingPhase) return
    const entries = [...slots.entries()].sort((a, b) => a[0] - b[0])
    const captured = captureFrameCount()
    const writing = entries
      .map(([, v]) => v)
      .filter((v) => v.status === 'rendering' || v.status === 'finalizing')
    const fpsSum = writing.reduce((s, v) => s + (v.fps || 0), 0)
    const speedAvg =
      writing.length > 0
        ? writing.reduce((s, v) => s + (v.speed || 0), 0) / writing.length
        : 0
    const wallElapsedSec = wallElapsedSecNow()
    const efficiency = wallElapsedSec > 0 ? captured / exportFps / wallElapsedSec : 0
    const runningJobs = entries.filter(([, v]) => v.job).length
    const workerCards: WorkerCardStats[] = entries.map(([idx, v]) => ({
      index: idx,
      status: v.status,
      progress: v.job ? v.frameCount / Math.max(1, v.totalFrames) : 0,
      frameCount: v.frameCount,
      totalFrames: v.totalFrames,
      warmProgress: v.warmProgress,
      warmFrameCount: v.warmFrameCount,
      warmTotalFrames: v.warmTotalFrames,
      fps: v.fps,
      speed: v.speed,
      message: v.job
        ? `job#${v.job.jobId} [${v.job.startFrame},${v.job.endFrame})`
        : v.message ?? 'idle'
    }))

    const chunkSegments: ChunkBarSegment[] = []
    for (const job of [...completed.values()].sort((a, b) => a.startFrame - b.startFrame)) {
      chunkSegments.push({
        id: `done-${job.jobId}`,
        jobId: job.jobId,
        startFrame: job.startFrame,
        endFrame: job.endFrame,
        progress: 1,
        state: 'done',
        label: `#${job.jobId}`
      })
    }
    for (const [slotId, slot] of entries) {
      if (!slot.job || completed.has(slot.job.jobId)) continue
      const job = slot.job
      const span = Math.max(1, job.endFrame - job.startFrame)
      const state: ChunkBarSegment['state'] =
        slot.status === 'warming'
          ? 'warming'
          : slot.status === 'error'
            ? 'error'
            : 'running'
      chunkSegments.push({
        id: `run-${job.jobId}`,
        jobId: job.jobId,
        startFrame: job.startFrame,
        endFrame: job.endFrame,
        progress: Math.min(1, Math.max(0, slot.frameCount / span)),
        state,
        label: `W${slotId}`,
        slotIndex: slotId
      })
    }
    for (const job of [...freeJobsBySlot.values()]
      .flat()
      .sort((a, b) => a.startFrame - b.startFrame)) {
      chunkSegments.push({
        id: `q-${job.jobId}-${job.attempts}`,
        jobId: job.jobId,
        startFrame: job.startFrame,
        endFrame: job.endFrame,
        progress: 0,
        state: 'queued',
        label: `#${job.jobId}`
      })
    }
    for (const lane of planner.lanes) {
      if (lane.nextFrame < lane.laneEnd) {
        chunkSegments.push({
          id: `pending-lane-${lane.slotId}`,
          startFrame: lane.nextFrame,
          endFrame: lane.laneEnd,
          progress: 0,
          state: 'pending',
          label: `L${lane.slotId}`,
          slotIndex: lane.slotId
        })
      }
    }
    chunkSegments.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)

    const timingSpans = buildTimingSpans(wallElapsedSec)
    const captureRatio = Math.min(1, captured / Math.max(1, totalFrames))
    onStats({
      progress: scaleCaptureProgress(captureRatio),
      frameCount: captured,
      totalFrames,
      currentTime: captured / exportFps,
      totalDuration,
      fps: fpsSum,
      speed: speedAvg,
      status: controlRef.paused ? 'paused' : 'rendering',
      message: `完成块 ${completed.size} · 运行 ${runningJobs} · 排队 ${freeJobsCount()}`,
      workerCards,
      chunkSegments,
      timingSpans,
      detailLines: [
        `规划 ${formatTime(totalDuration)} / 估算 ${formatTime(estimatedDuration)} · 目标 ${totalFrames}f` +
          (runtimeExtendedFrames > 0 ? ` · 已延伸 +${runtimeExtendedFrames}` : '') +
          (knownEndFrame !== null ? ` · 检测结尾 ${knownEndFrame}f` : ''),
        `墙钟 ${formatTime(wallElapsedSec)} · 效率 ${efficiency.toFixed(2)}x`,
        `队列 完成${completed.size} · lane剩余 ${planner.lanes.map((l) => l.laneEnd - l.nextFrame).join('/')} · 禁 0 重开 · 近者优先`,
        (() => {
          const a = assessWarmCatchUp()
          if (a.lagging.length === 0) {
            return controlRef.paused ? '已暂停' : '运行中 · 最近领取+真实结尾收口'
          }
          return a.lagging
            .map(
              (l) =>
                `W${l.slotId}预热ETA ${l.etaSec.toFixed(0)}s` +
                (l.canCatchUp ? '·正常' : '·偏慢')
            )
            .join(' · ')
        })()
      ],
      wallElapsedSec,
      efficiency,
      doneWorkers: completed.size,
      totalWorkers: Math.max(slots.size, concurrency),
      canPause: true,
      canStop: true,
      isPaused: controlRef.paused
    })
  }

  const openedSlots = new Set<number>()

  async function launchSlot(slotId: number, job: ExportJob, mode: 'open' | 'assign'): Promise<void> {
    const slot = slots.get(slotId)
    if (!slot) return
    // continueFrom is the worker clock to keep (lastEnd). Equal start → pure sticky;
    // start > continueFrom → forward catch-up warm (not from 0).
    const continueFrom =
      mode === 'assign' && slot.lastEndFrame !== null ? slot.lastEndFrame : null
    const needsCatchupWarm =
      continueFrom !== null && job.startFrame > continueFrom
    const pureSticky = continueFrom !== null && job.startFrame === continueFrom
    slot.job = job
    slot.status = pureSticky ? 'rendering' : job.startFrame > 0 || needsCatchupWarm ? 'warming' : 'rendering'
    // New job: reset open phase ends so multi-job sticky still draws new spans.
    if (!pureSticky) {
      if (job.startFrame > 0 || needsCatchupWarm) {
        slot.warmStartSec = wallElapsedSecNow()
        slot.warmEndSec = null
        slot.captureStartSec = null
        slot.captureEndSec = null
      } else {
        slot.warmStartSec = null
        slot.warmEndSec = null
        slot.captureStartSec = wallElapsedSecNow()
        slot.captureEndSec = null
      }
      slot.finalizeStartSec = null
      slot.finalizeEndSec = null
    } else {
      slot.captureStartSec = wallElapsedSecNow()
      slot.captureEndSec = null
      slot.finalizeStartSec = null
      slot.finalizeEndSec = null
    }
    noteSlotPhase(slot, slot.status)
    slot.frameCount = 0
    slot.totalFrames = Math.max(1, job.endFrame - job.startFrame)
    slot.warmProgress = pureSticky ? 1 : 0
    slot.warmFrameCount = pureSticky ? job.startFrame : continueFrom ?? 0
    slot.warmTotalFrames = Math.max(0, job.startFrame)
    slot.message = needsCatchupWarm
      ? `追赶 ${continueFrom}→${job.startFrame}`
      : pureSticky
        ? '粘连'
        : undefined
    slot.fps = 0
    slot.speed = 0
    slot.lastProgressAt = Date.now()
    slot.lastFrameCount = 0
    slot.lastWarmFrameCount = 0
    slot.message = undefined

    if (mode === 'open' || !openedSlots.has(slotId)) {
      openedSlots.add(slotId)
      await openPlayerWindow(projectName, true, {
        exportPath: renderConfig.exportPath,
        width: renderConfig.width,
        height: renderConfig.height,
        fps: renderConfig.fps,
        concurrency,
        role: 'worker',
        sessionId: job.sessionKey,
        exportGroupId: prepared.sessionId,
        workerIndex: slotId,
        workers: concurrency,
        startFrame: job.startFrame,
        endFrame: job.endFrame,
        segmentPath: job.segmentPath,
        jobId: job.jobId,
        multiJob: true,
        dataPath
      })
      return
    }

    await emit('export-job-assign', {
      sessionId: prepared.sessionId,
      workerIndex: slotId,
      jobId: job.jobId,
      startFrame: job.startFrame,
      endFrame: job.endFrame,
      segmentPath: job.segmentPath,
      sessionKey: job.sessionKey,
      continueFrom
    } satisfies JobAssignEvent)
  }

  async function assignNext(slotId: number): Promise<void> {
    if (isCancelled() || controlRef.stopped) return
    while (controlRef.paused && !controlRef.stopped && !isCancelled()) {
      await new Promise<void>((r) => setTimeout(r, 100))
    }
    if (isCancelled() || controlRef.stopped) return
    const job = claimJob(slotId)
    if (!job) {
      const slot = slots.get(slotId)
      const moreWork =
        planner.remainingInSlot(slotId) > 0 ||
        (freeJobsBySlot.get(slotId)?.length ?? 0) > 0
      if (slot) {
        slot.job = null
        // Stay idle (not terminal done) if other workers still hold earlier ranges we may sticky later.
        slot.status = moreWork ? 'idle' : 'done'
        slot.fps = 0
        slot.speed = 0
        slot.message = moreWork ? '等待下一块' : 'idle'
      }
      // Only send terminal poison pill when the whole export has no remaining work.
      if (!moreWork && openedSlots.has(slotId)) {
        await emit('export-job-assign', {
          sessionId: prepared.sessionId,
          workerIndex: slotId,
          jobId: -1,
          startFrame: 0,
          endFrame: 0,
          segmentPath: '',
          sessionKey: '',
          continueFrom: null
        } satisfies JobAssignEvent)
      }
      return
    }
    const slot = slots.get(slotId)
    if (!slot) return
    const isFirst = slot.lastEndFrame === null
    const sticky = slot.lastEndFrame !== null && slot.lastEndFrame === job.startFrame
    const forwardCatchup =
      slot.lastEndFrame !== null && job.startFrame > slot.lastEndFrame
    // Backward jump would require rewind/restart from 0 — forbidden.
    if (slot.lastEndFrame !== null && job.startFrame < slot.lastEndFrame) {
      logger.error('export.job_rejected_backward', {
        slotId,
        jobId: job.jobId,
        startFrame: job.startFrame,
        lastEndFrame: slot.lastEndFrame
      })
      const q = freeJobsBySlot.get(slotId) ?? []
      q.unshift(job)
      freeJobsBySlot.set(slotId, q)
      slot.job = null
      slot.status = 'idle'
      slot.message = '拒绝倒退任务'
      return
    }
    if (!openedSlots.has(slotId) && !isFirst && !sticky && !forwardCatchup) {
      logger.error('export.job_rejected_no_sticky', { slotId })
      const q = freeJobsBySlot.get(slotId) ?? []
      q.unshift(job)
      freeJobsBySlot.set(slotId, q)
      return
    }
    // Forward catch-up keeps the same window; never closeExportWorker.
    const mode = openedSlots.has(slotId) ? 'assign' : 'open'
    await launchSlot(slotId, job, mode)
  }

  async function requeueStalled(slotId: number, reason: string): Promise<void> {
    const slot = slots.get(slotId)
    if (!slot?.job) return
    const job = slot.job
    job.attempts += 1
    recentRetries += 1
    recentStable = 0
    logger.warn('export.job_stalled', {
      slotId,
      jobId: job.jobId,
      reason,
      attempts: job.attempts
    })
    // Keep lastEndFrame / opened window so retry stays sticky (no cold warm-up).
    const savedLastEnd = slot.lastEndFrame
    slot.job = null
    slot.status = 'error'
    slot.message = reason
    // Only stop broken encode session; do NOT destroy worker window/runtime.
    await stopRenderSession(job.sessionKey).catch(() => undefined)

    if (job.attempts >= MAX_ATTEMPTS) {
      slot.status = 'error'
      slot.message = `失败 · ${reason}`
      parkLaneRemainderOnSlot(slotId)
      // Sticky-only: do not hand off to other workers. Fail the export.
      throw new Error(
        `W${slotId} job#${job.jobId} 粘连重试超过 ${MAX_ATTEMPTS} 次（禁止冷启动换人）: ${reason}`
      )
    }

    // Same-slot sticky retry: job must start at savedLastEnd or be the in-progress range.
    // If we were mid-job, re-run the same [start,end) — worker may need reopen ONLY if window died.
    const q = freeJobsBySlot.get(slotId) ?? []
    q.unshift(job)
    freeJobsBySlot.set(slotId, q)
    slot.lastEndFrame = savedLastEnd
    // Prefer assign (window still open). If window was lost externally, open is first-only.
    if (!openedSlots.has(slotId)) {
      // Window gone: only allowed recovery is re-open and warm to job.start once.
      logger.warn('export.worker_window_reopen', {
        slotId,
        startFrame: job.startFrame
      })
      slot.lastEndFrame = null
    }
    await assignNext(slotId)
  }

  const unlistenProgress = await listen<WorkerProgressEvent>('export-worker-progress', (event) => {
    const payload = event.payload
    if (payload.sessionId !== prepared.sessionId) return
    const slot = slots.get(payload.workerIndex)
    if (!slot) return
    if (slot.job && payload.jobId !== undefined && payload.jobId !== slot.job.jobId) return

    const nextWarm = Math.max(0, payload.warmFrameCount ?? slot.warmFrameCount)
    const nextFrames = Math.max(0, payload.frameCount)
    // Capture-only frameCount stays 0 during warm-up — also treat warm ticks as progress,
    // otherwise watchdog false-stalls long pre-roll and requeues healthy jobs.
    const progressed =
      nextFrames > slot.lastFrameCount ||
      nextWarm > slot.lastWarmFrameCount ||
      payload.status !== slot.status ||
      (typeof payload.fps === 'number' && payload.fps > 0.5)
    if (progressed) {
      slot.lastProgressAt = Date.now()
      slot.lastFrameCount = nextFrames
      slot.lastWarmFrameCount = nextWarm
    }
    slot.status = payload.status
    noteSlotPhase(slot, payload.status)
    slot.frameCount = nextFrames
    slot.totalFrames = Math.max(1, payload.totalFrames || slot.totalFrames)
    slot.warmProgress = Math.min(1, Math.max(0, payload.warmProgress ?? slot.warmProgress))
    slot.warmFrameCount = nextWarm
    slot.warmTotalFrames = Math.max(0, payload.warmTotalFrames ?? slot.warmTotalFrames)
    slot.fps = payload.fps ?? slot.fps
    slot.speed = payload.speed ?? slot.speed
    maybeExtendFromProgress(payload)

    if (payload.status === 'done') {
      if (slot.job) {
        const job = slot.job
        const captured = Math.max(0, payload.frameCount)
        const actualEnd = job.startFrame + captured
        // Empty post-trim job: do not publish a zero-length segment into coverage.
        if (captured <= 0 && knownEndFrame !== null && job.startFrame >= knownEndFrame) {
          slot.job = null
          slot.status = 'done'
          noteSlotPhase(slot, 'done')
        } else {
          // Story-end / truncate may finish before the planned exclusive end.
          if (actualEnd > job.startFrame && actualEnd < job.endFrame) {
            job.endFrame = actualEnd
          }
          completed.set(job.jobId, job)
          completedFramesByJob.set(job.jobId, captured)
          slot.lastEndFrame = job.endFrame
          noteSlotPhase(slot, 'done')
          slot.job = null
          recentStable += 1
          if (recentStable > 2) recentRetries = Math.max(0, recentRetries - 1)
        }
      } else {
        noteSlotPhase(slot, 'done')
      }
      // Continue this slot; wake idle slots so they can forward-catchup unminted tails.
      // Also runs when trim already cleared slot.job so the worker is not left waiting.
      void (async () => {
        await assignNext(payload.workerIndex)
        for (const [otherId, other] of slots) {
          if (otherId === payload.workerIndex) continue
          if (other.job) continue
          await assignNext(otherId)
        }
      })()
    } else if (payload.status === 'error' && slot.job) {
      noteSlotPhase(slot, 'error')
      void requeueStalled(payload.workerIndex, payload.message ?? 'worker error').catch((err) => {
        logger.error('export.error', { error: describeError(err) })
      })
    }
    publishCoordinatorStatus()
  })

  let rebalanceTick = 0
  const heartbeat = window.setInterval(() => {
    if (controlRef.paused) {
      if (pauseStartedAt === null) pauseStartedAt = performance.now()
    } else if (pauseStartedAt !== null) {
      pauseAccumMs += performance.now() - pauseStartedAt
      pauseStartedAt = null
    }
    rebalanceTick += 1
    if (!controlRef.paused && rebalanceTick % 5 === 0) {
      void rebalanceIfWarmLagging()
    }
    publishCoordinatorStatus()
  }, 400)

  const watchdog = window.setInterval(() => {
    if (controlRef.paused || controlRef.stopped || isCancelled()) return
    const now = Date.now()
    for (const [slotId, slot] of slots) {
      if (!slot.job) continue
      if (slot.status === 'done' || slot.status === 'concatenating') continue

      // finalizing waits for encoder trailer + validate; allow longer before requeue.
      if (slot.status === 'finalizing') {
        if (now - slot.lastProgressAt > 45_000) {
          void requeueStalled(slotId, '写入收尾超时').catch((err: unknown) => {
            controlRef.stopped = true
            logger.error('export.error', { error: describeError(err) })
          })
        }
        continue
      }

      const warmNeed = Math.max(0, slot.job.startFrame)
      const warmBudgetMs = Math.min(180_000, Math.max(45_000, (warmNeed / 15) * 1000))
      const limit = slot.status === 'warming' ? Math.max(STALL_MS * 3, warmBudgetMs) : STALL_MS * 2
      if (now - slot.lastProgressAt > limit) {
        void requeueStalled(
          slotId,
          `无进展超时(${Math.round((now - slot.lastProgressAt) / 1000)}s, ${slot.status})`
        ).catch((err: unknown) => {
          controlRef.stopped = true
          logger.error('export.error', { error: describeError(err) })
        })
      }
    }
  }, 1000)

  try {
    for (let slotId = 0; slotId < concurrency; slotId += 1) {
      if (isCancelled() || controlRef.stopped) throw new Error('渲染已取消')
      await assignNext(slotId)
    }
    publishCoordinatorStatus()

    const deadline = Date.now() + Math.max(180_000, totalFrames * 1500)
    while (!isCancelled() && !controlRef.stopped) {
      if (allWorkDone()) break
      if (Date.now() > deadline) throw new Error('等待任务队列超时')
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
    }
    if (isCancelled() || controlRef.stopped) throw new Error('渲染已取消')

    const ordered = [...completed.values()].sort((a, b) => a.startFrame - b.startFrame)
    if (ordered.length === 0) throw new Error('没有可合并的分段')
    // Contiguous coverage — gaps would produce short/wrong-duration videos.
    if (ordered[0].startFrame !== 0) {
      throw new Error(`渲染覆盖缺口：首块从 ${ordered[0].startFrame} 开始，缺少 [0,${ordered[0].startFrame})`)
    }
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i].startFrame !== ordered[i - 1].endFrame) {
        throw new Error(
          `渲染覆盖缺口：[${ordered[i - 1].startFrame},${ordered[i - 1].endFrame}) 与 [${ordered[i].startFrame},${ordered[i].endFrame})`
        )
      }
    }
    const maxEnd = ordered[ordered.length - 1].endFrame
    if (knownEndFrame !== null && maxEnd + Math.ceil(exportFps * 0.5) < knownEndFrame) {
      logger.warn('export.coverage_before_known_end', {
        maxEnd,
        knownEndFrame
      })
    }
    if (knownEndFrame === null && maxEnd + 1 < estimatedFrames * 0.85) {
      logger.warn('export.coverage_short_vs_estimate', {
        maxEnd,
        estimatedFrames
      })
    }
    const doneSegments: ChunkBarSegment[] = ordered.map((job) => ({
      id: `done-${job.jobId}`,
      jobId: job.jobId,
      startFrame: job.startFrame,
      endFrame: job.endFrame,
      progress: 1,
      state: 'done' as const,
      label: `#${job.jobId}`
    }))

    const preConcatWall = wallElapsedSecNow()
    mergeStartSec = preConcatWall
    mergeEndSec = null
    mergingPhase = true
    // Stop render-phase timers so they cannot flip status back to "rendering".
    window.clearInterval(heartbeat)
    window.clearInterval(watchdog)
    let ffmpegMergeRatio = 0
    const publishMergeStats = (wall: number, message: string): void => {
      const mergeElapsed = Math.max(0, wall - preConcatWall)
      onStats({
        progress: scaleMergeProgressFromFfmpeg(ffmpegMergeRatio),
        frameCount: totalFrames,
        totalFrames,
        currentTime: totalDuration,
        totalDuration,
        fps: 0,
        speed: wall > 0 ? totalDuration / wall : 0,
        status: 'concatenating',
        message,
        wallElapsedSec: wall,
        efficiency: wall > 0 ? totalDuration / wall : 0,
        doneWorkers: ordered.length,
        totalWorkers: ordered.length,
        chunkSegments: doneSegments,
        timingSpans: buildTimingSpans(wall),
        detailLines: [
          `任务块 ${ordered.length}`,
          `渲染墙钟 ${formatTime(preConcatWall)}`,
          `压制已进行 ${formatTime(mergeElapsed)}`,
          `FFmpeg ${(ffmpegMergeRatio * 100).toFixed(1)}%`,
          '最终合并：重新压制（优先 libx265 medium）'
        ],
        canPause: false,
        canStop: false,
        isPaused: false
      })
    }
    publishMergeStats(preConcatWall, '正在合成视频…')
    // Let React paint concatenating state before blocking on encode IPC.
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0)
    })

    const unlistenFfmpeg = await listen<FfmpegProgressEvent>(
      'export-ffmpeg-progress',
      (event) => {
        const ratio = Number(event.payload?.ratio)
        if (!Number.isFinite(ratio)) return
        // Monotonic: never go backwards if a late/out-of-order event arrives.
        ffmpegMergeRatio = Math.max(ffmpegMergeRatio, Math.min(1, Math.max(0, ratio)))
        publishMergeStats(wallElapsedSecNow(), '正在合成视频…')
      }
    )

    const mergeHeartbeat = window.setInterval(() => {
      // Keep wall clock / remaining estimate fresh even if ffmpeg is quiet at start.
      publishMergeStats(wallElapsedSecNow(), '正在合成视频…')
    }, 500)

    logger.info('export.merge_started', {
      projectName,
      segmentCount: ordered.length,
      exportPath: renderConfig.exportPath,
      totalDurationSec: totalDuration
    })
    try {
      await concatRenderSegments(
        ordered.map((j) => j.segmentPath),
        renderConfig.exportPath,
        totalDuration
      )
      ffmpegMergeRatio = 1
      logger.info('export.merge_done', {
        projectName,
        exportPath: renderConfig.exportPath,
        segmentCount: ordered.length
      })
    } finally {
      window.clearInterval(mergeHeartbeat)
      unlistenFfmpeg()
    }

    // Publish completed UI immediately — cleanup must not leave the dashboard on 98.9%.
    const finalWall = wallElapsedSecNow()
    mergeEndSec = finalWall
    const efficiency = finalWall > 0 ? totalDuration / finalWall : 0
    const avgFps = finalWall > 0 ? totalFrames / finalWall : 0
    const encodeSec = Math.max(0, finalWall - preConcatWall)
    logger.info('export.coordinator_done', {
      projectName,
      concurrency,
      segmentCount: ordered.length,
      totalFrames,
      wallElapsedSec: finalWall,
      efficiency,
      exportPath: renderConfig.exportPath
    })
    onStats({
      progress: 1,
      frameCount: totalFrames,
      totalFrames,
      currentTime: totalDuration,
      totalDuration,
      fps: avgFps,
      speed: efficiency,
      status: 'done',
      message: `完成（${ordered.length} 块合并）`,
      wallElapsedSec: finalWall,
      efficiency,
      doneWorkers: ordered.length,
      totalWorkers: ordered.length,
      chunkSegments: doneSegments,
      timingSpans: buildTimingSpans(finalWall),
      detailLines: [
        `故事时间轴 ${formatTime(totalDuration)}`,
        `总渲染耗时 ${formatTime(finalWall)} · 其中压制 ${formatTime(encodeSec)}`,
        `全程平均 FPS ${avgFps.toFixed(1)} · Speed ${efficiency.toFixed(2)}x`,
        `平均效率 ${efficiency.toFixed(2)}x（故事时间/墙钟）`,
        `线程 ${concurrency} · 块 ${ordered.length}`,
        `输出 ${renderConfig.exportPath}`
      ],
      canPause: false,
      canStop: false,
      isPaused: false
    })
    // Yield so React paints "渲染完成 / 100%" before cleanup work.
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0)
    })

    await cleanupExportTemp(prepared.tempDir).catch((err: unknown) => {
      logger.warn('export.cleanup_failed', { error: describeError(err) })
    })
    for (const id of slots.keys()) {
      await closeExportWorker(id).catch(() => undefined)
    }
  } catch (error: unknown) {
    logger.error('export.coordinator_failed', {
      projectName,
      error: describeError(error)
    })
    for (const id of slots.keys()) {
      await closeExportWorker(id).catch(() => undefined)
    }
    await cleanupExportTemp(prepared.tempDir).catch(() => undefined)
    const finalWall = wallElapsedSecNow()
    onStats({
      progress: 0,
      frameCount: captureFrameCount(),
      totalFrames,
      currentTime: 0,
      totalDuration,
      fps: 0,
      speed: 0,
      status: 'error',
      message: error instanceof Error ? error.message : '渲染失败',
      wallElapsedSec: finalWall,
      canPause: false,
      canStop: false,
      isPaused: false,
      detailLines: [`失败前耗时: ${formatTime(finalWall)}`]
    })
    throw error
  } finally {
    window.clearInterval(heartbeat)
    window.clearInterval(watchdog)
    unlistenProgress()
    controlRef.groupId = undefined
  }
}

type PixelReader = {
  capture(out: Uint8Array): boolean
  finish(out: Uint8Array): boolean
  destroy(): void
}

function createPixelReader(
  app: Application,
  width: number,
  height: number,
  frameByteLength: number
): PixelReader {
  const gl = getWebGlContext(app)
  if (gl && 'PIXEL_PACK_BUFFER' in gl) {
    return createPboPixelReader(gl as WebGL2RenderingContext, width, height, frameByteLength)
  }
  return createSyncPixelReader(app, width, height)
}

function createPboPixelReader(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  frameByteLength: number
): PixelReader {
  const depth = 3
  const pbos: WebGLBuffer[] = []
  const fences: Array<WebGLSync | null> = Array.from({ length: depth }, () => null)
  for (let i = 0; i < depth; i += 1) {
    const pbo = gl.createBuffer()
    if (!pbo) throw new Error('Failed to create PIXEL_PACK_BUFFER')
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, frameByteLength, gl.STREAM_READ)
    pbos.push(pbo)
  }
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)

  let writeIndex = 0
  let framesStarted = 0

  function clearFence(index: number): void {
    const fence = fences[index]
    if (fence) {
      gl.deleteSync(fence)
      fences[index] = null
    }
  }

  function startRead(index: number): void {
    clearFence(index)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbos[index])
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    fences[index] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
  }

  function waitReady(index: number): void {
    const fence = fences[index]
    if (!fence) return
    // Prefer non-blocking poll; fall back to short wait to avoid infinite stall.
    const status = gl.clientWaitSync(fence, 0, 0)
    if (status === gl.TIMEOUT_EXPIRED || status === gl.WAIT_FAILED) {
      gl.clientWaitSync(fence, gl.SYNC_FLUSH_COMMANDS_BIT, 2_000_000)
    }
    clearFence(index)
  }

  function readInto(index: number, out: Uint8Array): void {
    waitReady(index)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbos[index])
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
  }

  return {
    capture(out: Uint8Array): boolean {
      const current = writeIndex
      startRead(current)
      writeIndex = (writeIndex + 1) % depth
      framesStarted += 1

      // 1-frame lag: return the buffer written on the previous capture.
      if (framesStarted < 2) {
        return false
      }
      const readyIndex = (current + depth - 1) % depth
      readInto(readyIndex, out)
      return true
    },
    finish(out: Uint8Array): boolean {
      if (framesStarted === 0) return false
      // Drain the most recently started buffer.
      const readyIndex = (writeIndex + depth - 1) % depth
      readInto(readyIndex, out)
      return true
    },
    destroy(): void {
      for (let i = 0; i < depth; i += 1) {
        clearFence(i)
        gl.deleteBuffer(pbos[i])
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    }
  }
}

function createSyncPixelReader(app: Application, width: number, height: number): PixelReader {
  let pending: Uint8Array | null = null
  return {
    capture(out: Uint8Array): boolean {
      const current = new Uint8Array(width * height * 4)
      readFramePixels(app, width, height, current)
      if (!pending) {
        pending = current
        return false
      }
      out.set(pending)
      pending = current
      return true
    },
    finish(out: Uint8Array): boolean {
      if (!pending) return false
      out.set(pending)
      pending = null
      return true
    },
    destroy(): void {
      pending = null
    }
  }
}

function readFramePixels(
  app: Application,
  width: number,
  height: number,
  out: Uint8Array
): void {
  const gl = getWebGlContext(app)
  if (gl) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out)
    if (gl.getError() === gl.NO_ERROR) {
      return
    }
  }

  const pixels = app.renderer.extract.pixels({
    target: app.stage,
    resolution: 1
  })
  out.set(pixels.pixels.subarray(0, Math.min(out.length, pixels.pixels.length)))
}

function getWebGlContext(
  app: Application
): WebGLRenderingContext | WebGL2RenderingContext | null {
  const renderer = app.renderer as unknown as {
    gl?: WebGLRenderingContext | WebGL2RenderingContext
    context?: { gl?: WebGLRenderingContext | WebGL2RenderingContext }
  }
  return renderer.gl ?? renderer.context?.gl ?? null
}

function parseRenderConfig(raw: string | null): RenderConfig | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const exportPath = record.exportPath
    const width = Number(record.width)
    const height = Number(record.height)
    const fps = Number(record.fps)
    if (typeof exportPath !== 'string' || !exportPath) return null
    const concurrency = Number(record.concurrency)
    const workerIndex = Number(record.workerIndex)
    const workers = Number(record.workers)
    const startFrame = Number(record.startFrame)
    const endFrame = Number(record.endFrame)
    const roleRaw = record.role
    const role =
      roleRaw === 'coordinator' ||
      roleRaw === 'worker' ||
      roleRaw === 'single' ||
      roleRaw === 'debug'
        ? roleRaw
        : undefined
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined
    const exportGroupId =
      typeof record.exportGroupId === 'string' ? record.exportGroupId : undefined
    const segmentPath = typeof record.segmentPath === 'string' ? record.segmentPath : undefined

    return {
      exportPath,
      width: Number.isFinite(width) ? width : 1920,
      height: Number.isFinite(height) ? height : 1080,
      fps: Number.isFinite(fps) ? fps : 60,
      concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
      role,
      sessionId,
      exportGroupId,
      workerIndex: Number.isFinite(workerIndex) ? workerIndex : undefined,
      workers: Number.isFinite(workers) ? workers : undefined,
      startFrame: Number.isFinite(startFrame) ? startFrame : undefined,
      endFrame: Number.isFinite(endFrame) ? endFrame : undefined,
      segmentPath,
      jobId: Number.isFinite(Number(record.jobId)) ? Number(record.jobId) : undefined,
      multiJob: record.multiJob === true,
      dataPath: typeof record.dataPath === 'string' ? record.dataPath : undefined
    }
  } catch (error: unknown) {
    logger.error('export.render_config_parse_failed', { error: describeError(error) })
    return null
  }
}


function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const mins = Math.floor(safe / 60)
  const secs = Math.floor(safe % 60)
  const cs = Math.floor((safe % 1) * 100)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${cs
    .toString()
    .padStart(2, '0')}`
}

function startWindowDrag(event: ReactMouseEvent<HTMLDivElement>): void {
  if (event.button !== 0) return

  event.preventDefault()
  void getCurrentWindow()
    .startDragging()
    .catch((error: unknown) => {
      logger.error('player.drag_start_failed', { error: describeError(error) })
    })
}

async function loadPlayerStoryInput(
  projectName: string,
  preferredDataPath?: string | null
): Promise<PlayerStoryInput> {
  const preferred: string | null =
    typeof preferredDataPath === 'string' && preferredDataPath.trim().length > 0
      ? preferredDataPath.trim()
      : null

  const [rawMetadata, rawSettings, resolvedDataPath, projectPath, rawModelRegistry, rawAssets] =
    await Promise.all([
      getProjectMetadata(projectName),
      getSettings(),
      preferred
        ? Promise.resolve(preferred)
        : getDataPath().catch(async (error: unknown): Promise<string> => {
            // Last resort: settings may still have workspace if get_data_path raced.
            const settings = await getSettings().catch(() => null)
            if (settings?.workspaceDir) return settings.workspaceDir
            throw error
          }),
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
    dataPath: resolvedDataPath,
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
