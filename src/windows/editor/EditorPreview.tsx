import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Application } from 'pixi.js'
import { LoaderCircle, Pause, Play, RotateCcw, Square } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/style'
import { describeError as describeLogError, logger } from '@/lib/logger'
import { ensureSekaiLive2DReady } from '@/lib/live2d'
import type { ModelRegistry } from '@/modelRegistry/schema'
import type { ProjectAssets } from '@/project/assets'
import type { AppSettings, RenderPrecision } from '@/settings/types'
import { loadPlaybackFontFamily } from '@/settings/fonts'
import {
  createStoryRuntime,
  destroyStoryRuntime,
  preloadStoryModels,
  StoryDispatcher,
  StoryModelPreloadError,
  StorySnippetError,
  type StoryData,
  type StoryDispatcherEvent,
  type StoryModelInstance,
  type StoryRuntime
} from '@/story'
import type { EditorStory } from './editorDocument'
import { useTranslation } from 'react-i18next'

export type EditorPreviewInput = {
  projectName: string
  dataPath: string
  projectPath: string
  settings: AppSettings | null
  modelRegistry: ModelRegistry
  assets: ProjectAssets
}

type PreviewStatus = 'idle' | 'loading' | 'running' | 'paused' | 'completed' | 'stopped' | 'error'

type PreviewSession = {
  dispatcher: StoryDispatcher
  dispose(): void
}

export function EditorPreview({
  input,
  story,
  previewRequest,
  previewTargetNodeId,
  pauseAfterPreviewTarget,
  onPreviewFromBeginning,
  onActiveSnippetIdsChange
}: {
  input: EditorPreviewInput
  story: EditorStory
  previewRequest: number
  previewTargetNodeId: string | null
  pauseAfterPreviewTarget: boolean
  onPreviewFromBeginning: () => void
  onActiveSnippetIdsChange: (ids: ReadonlySet<string>) => void
}): JSX.Element {
  const { t } = useTranslation()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<PreviewSession | null>(null)
  const previousPreviewRequestRef = useRef<number>(previewRequest)
  const initialLoadRef = useRef<boolean>(true)
  const [status, setStatus] = useState<PreviewStatus>('idle')
  const [message, setMessage] = useState<string>(() => t('editor.waitingPreview'))

  useEffect((): (() => void) | undefined => {
    const currentStageElement: HTMLDivElement | null = stageRef.current
    if (!currentStageElement) return undefined
    const stageElement: HTMLDivElement = currentStageElement

    let disposed = false
    let app: Application | null = null
    let appInitialized = false
    let appDestroyed = false
    let mountedCanvas: HTMLCanvasElement | null = null
    let dispatcher: StoryDispatcher | null = null
    let runtime: StoryRuntime | null = null
    let preloadedModels: StoryModelInstance[] = []
    let started = false
    const activeSnippetIdsRef: Set<string> = new Set()
    const targetPausedRef: { current: boolean } = { current: false }
    const startedAt: number = performance.now()
    const requestedFromToolbar: boolean = previousPreviewRequestRef.current !== previewRequest
    const useImmediateStart: boolean = initialLoadRef.current || requestedFromToolbar
    previousPreviewRequestRef.current = previewRequest
    initialLoadRef.current = false

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

    function dispose(): void {
      if (disposed) return
      disposed = true
      activeSnippetIdsRef.clear()
      onActiveSnippetIdsChange(new Set())
      logger.debug('editor.preview_disposed', {
        projectName: input.projectName,
        durationMs: Math.round(performance.now() - startedAt)
      })
      dispatcher?.cancel()
      if (runtime) {
        destroyStoryRuntime(runtime)
        preloadedModels = []
      } else {
        destroyPreloadedModels()
      }
      detachMountedCanvas()
      destroyInitializedApp()
      if (sessionRef.current?.dispatcher === dispatcher) {
        sessionRef.current = null
      }
    }

    async function start(): Promise<void> {
      if (disposed) return
      started = true
      activeSnippetIdsRef.clear()
      onActiveSnippetIdsChange(new Set())
      setStatus('loading')
      setMessage(t('editor.initializingPreview'))
      logger.info('editor.preview_started', {
        projectName: input.projectName,
        snippetCount: story.snippets.length,
        targetNodeId: previewTargetNodeId,
        pauseAfterTarget: pauseAfterPreviewTarget
      })

      try {
        await ensureSekaiLive2DReady()
        if (disposed) return
        logger.debug('editor.preview_live2d_ready', { projectName: input.projectName })

        const previewApp: Application = new Application()
        app = previewApp
        await previewApp.init({
          resizeTo: stageElement,
          preference: 'webgl',
          autoDensity: true,
          resolution: resolveRenderPrecision(input.settings),
          backgroundAlpha: 0
        })
        appInitialized = true
        mountedCanvas = previewApp.canvas
        if (disposed) {
          detachMountedCanvas()
          destroyInitializedApp()
          return
        }
        stageElement.replaceChildren(mountedCanvas)
        logger.info('editor.preview_pixi_ready', {
          projectName: input.projectName,
          resolution: resolveRenderPrecision(input.settings)
        })

        setMessage(t('editor.loadingResources'))
        const fontFamily: string = await loadPlaybackFontFamily(input.settings, input.dataPath)
        if (disposed) return
        preloadedModels = await preloadStoryModels({
          app: previewApp,
          dataPath: input.dataPath,
          assets: input.assets,
          modelRegistry: input.modelRegistry
        })
        if (disposed) {
          destroyPreloadedModels()
          return
        }
        logger.info('editor.preview_models_loaded', {
          projectName: input.projectName,
          modelCount: preloadedModels.length
        })

        runtime = createStoryRuntime({
          app: previewApp,
          dataPath: input.dataPath,
          projectPath: input.projectPath,
          assets: input.assets,
          modelRegistry: input.modelRegistry,
          models: preloadedModels,
          fontFamily
        })
        dispatcher = new StoryDispatcher(runtime, {
          onEvent: (event: StoryDispatcherEvent): void => handleStoryEvent(event)
        })
        sessionRef.current = { dispatcher, dispose }
        setStatus('running')
        setMessage(
          previewTargetNodeId
            ? '正在恢复选中片段前状态'
            : preloadedModels.length > 0
              ? `已加载 ${preloadedModels.length} 个模型`
              : t('editor.playing')
        )
        if (previewTargetNodeId) {
          await dispatcher.runFrom(
            story as StoryData,
            previewTargetNodeId,
            pauseAfterPreviewTarget ? { pauseAfterSnippetId: previewTargetNodeId } : {}
          )
        } else {
          await dispatcher.run(story as StoryData)
        }
        if (!disposed) {
          setStatus('completed')
          setMessage(t('editor.completed'))
          logger.info('editor.preview_completed', {
            projectName: input.projectName,
            durationMs: Math.round(performance.now() - startedAt)
          })
        }
      } catch (error: unknown) {
        if (disposed) return
        console.error('Editor preview failed', error)
        logger.error('editor.preview_failed', {
          projectName: input.projectName,
          durationMs: Math.round(performance.now() - startedAt),
          error: describeLogError(error)
        })
        setStatus('error')
        setMessage(describePreviewError(error))
      }
    }

    function handleStoryEvent(event: StoryDispatcherEvent): void {
      if (disposed) return
      if (event.type === 'snippet:start') {
        const snippetId: string | undefined = event.snippet.id
        if (snippetId) {
          activeSnippetIdsRef.add(snippetId)
          onActiveSnippetIdsChange(new Set(activeSnippetIdsRef))
        }
        setMessage(t('editor.playing'))
      }
      if (event.type === 'snippet:complete' || event.type === 'snippet:error') {
        const snippetId: string | undefined = event.snippet.id
        if (snippetId) {
          activeSnippetIdsRef.delete(snippetId)
          onActiveSnippetIdsChange(new Set(activeSnippetIdsRef))
        }
        if (
          pauseAfterPreviewTarget &&
          event.type === 'snippet:complete' &&
          event.snippet.id === previewTargetNodeId
        ) {
          targetPausedRef.current = true
        }
      }
      if (event.type === 'story:pause') {
        setStatus('paused')
        setMessage(t('editor.paused'))
        if (targetPausedRef.current && previewTargetNodeId) {
          activeSnippetIdsRef.add(previewTargetNodeId)
          onActiveSnippetIdsChange(new Set(activeSnippetIdsRef))
        }
      }
      if (event.type === 'story:resume') {
        setStatus('running')
        setMessage(t('editor.resume'))
        if (targetPausedRef.current && previewTargetNodeId) {
          targetPausedRef.current = false
          activeSnippetIdsRef.delete(previewTargetNodeId)
          onActiveSnippetIdsChange(new Set(activeSnippetIdsRef))
        }
      }
      if (
        event.type === 'story:complete' ||
        event.type === 'story:cancel' ||
        event.type === 'story:error'
      ) {
        activeSnippetIdsRef.clear()
        onActiveSnippetIdsChange(new Set())
      }
    }

    const delayMs: number = useImmediateStart ? 0 : 500
    const timeoutId: number = window.setTimeout((): void => {
      void start()
    }, delayMs)

    return (): void => {
      window.clearTimeout(timeoutId)
      if (started || app || dispatcher || runtime) dispose()
      else disposed = true
    }
  }, [
    input,
    onActiveSnippetIdsChange,
    pauseAfterPreviewTarget,
    previewRequest,
    previewTargetNodeId,
    story,
    t
  ])

  function restart(): void {
    sessionRef.current?.dispose()
    onPreviewFromBeginning()
  }

  function togglePause(): void {
    const dispatcher: StoryDispatcher | undefined = sessionRef.current?.dispatcher
    if (!dispatcher) return
    if (dispatcher.currentStatus === 'running') {
      dispatcher.pause()
      return
    }
    if (dispatcher.currentStatus === 'paused') {
      dispatcher.resume()
    }
  }

  function stop(): void {
    sessionRef.current?.dispose()
    setStatus('stopped')
    setMessage(t('editor.stopped'))
  }

  const playing: boolean = status === 'running'
  const paused: boolean = status === 'paused'

  return (
    <section
      data-tour="editor-preview-stage"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-muted/15"
    >
      <div className="flex h-12 shrink-0 items-center border-b bg-background/70 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium">{t('editor.previewPanel')}</span>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {status === 'loading' ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                playing ? 'bg-emerald-500' : paused ? 'bg-amber-500' : 'bg-muted-foreground/55'
              )}
            />
          )}
          <span className="truncate">{message}</span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-5">
        <div className="relative w-full max-w-[960px] overflow-hidden rounded-md border bg-black shadow-sm">
          <div className="relative aspect-video overflow-hidden">
            <div ref={stageRef} className="absolute inset-0" />
            <div className="pointer-events-none absolute inset-[7%] border border-white/12">
              <div className="absolute inset-y-0 left-1/3 border-l border-white/10" />
              <div className="absolute inset-y-0 left-2/3 border-l border-white/10" />
            </div>
            {status === 'error' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/65 px-8 text-center text-sm leading-6 text-white/80">
                {message}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex h-12 shrink-0 items-center border-t bg-background px-4">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t('editor.replay')}
            title={t('editor.replay')}
            onClick={restart}
          >
            <RotateCcw className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={paused ? t('editor.resume') : t('editor.pause')}
            title={paused ? t('editor.resume') : t('editor.pause')}
            disabled={!playing && !paused}
            onClick={togglePause}
          >
            {playing ? (
              <Pause className="size-3.5 fill-current" />
            ) : (
              <Play className="size-3.5 fill-current" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t('editor.stop')}
            title={t('editor.stop')}
            disabled={status === 'stopped' || status === 'idle'}
            onClick={stop}
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        </div>
        <div className="mx-3 h-px flex-1 bg-border" />
        <span className="font-mono text-[11px] text-muted-foreground">
          {paused ? 'PAUSED' : status.toUpperCase()}
        </span>
      </div>
    </section>
  )
}

function resolveRenderPrecision(settings: AppSettings | null): number {
  const precision: RenderPrecision | undefined = settings?.playback?.renderPrecision
  if (typeof precision === 'number' && Number.isFinite(precision) && precision > 0) {
    return precision
  }
  return window.devicePixelRatio
}

function describePreviewError(error: unknown): string {
  if (error instanceof StoryModelPreloadError) {
    return `模型加载失败：${error.modelName}`
  }
  if (error instanceof StorySnippetError) {
    const reason: string = error.cause instanceof Error ? `：${error.cause.message}` : ''
    return `片段 ${error.path.join('.')} (${error.snippet.type}) 执行失败${reason}`
  }
  return error instanceof Error ? error.message : '预览初始化失败'
}
