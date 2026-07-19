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
  StoryStatePrefixCache,
  StorySnippetError,
  type StoryData,
  type StoryDispatcherEvent,
  type StoryModelInstance,
  type StoryRuntime
} from '@/story'
import type { EditorStory } from './editorDocument'
import { useTranslation } from 'react-i18next'
import { i18n } from '@/i18n'

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

type PreviewEngine = {
  app: Application
  runtime: StoryRuntime
}

export function EditorPreview({
  input,
  story,
  previewRequest,
  previewTargetNodeId,
  pauseAfterPreviewTarget,
  onPreviewFromBeginning,
  onActiveSnippetIdsChange,
  compact = false
}: {
  input: EditorPreviewInput
  story: EditorStory
  previewRequest: number
  previewTargetNodeId: string | null
  pauseAfterPreviewTarget: boolean
  onPreviewFromBeginning: () => void
  onActiveSnippetIdsChange: (ids: ReadonlySet<string>) => void
  compact?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<PreviewSession | null>(null)
  const pendingDisposeRef = useRef<(() => void) | null>(null)
  const previousPreviewRequestRef = useRef<number>(previewRequest)
  const initialLoadRef = useRef<boolean>(true)
  const prefixCacheRef = useRef<StoryStatePrefixCache>(new StoryStatePrefixCache())
  const playbackQueueRef = useRef<Promise<void>>(Promise.resolve())
  const engineLifecycleRef = useRef<Promise<void>>(Promise.resolve())
  const [engine, setEngine] = useState<PreviewEngine | null>(null)
  const [status, setStatus] = useState<PreviewStatus>('idle')
  const [message, setMessage] = useState<string>(() => t('editor.waitingPreview'))

  useEffect((): (() => void) | undefined => {
    const currentStageElement: HTMLDivElement | null = stageRef.current
    if (!currentStageElement) return undefined
    const stageElement: HTMLDivElement = currentStageElement

    let disposed = false
    let app: Application | null = null
    let appInitialized = false
    let runtime: StoryRuntime | null = null
    let preloadedModels: StoryModelInstance[] = []
    let resourcesDestroyed = false
    let initializationTask: Promise<void> = Promise.resolve()
    const startedAt: number = performance.now()
    setEngine(null)
    setStatus('loading')
    setMessage(t('editor.initializingPreview'))

    function destroyPreloadedModels(): void {
      const models: StoryModelInstance[] = preloadedModels
      preloadedModels = []
      for (const { model } of models) {
        model.destroy({ children: true })
      }
    }

    function destroyResources(): void {
      if (resourcesDestroyed) return
      resourcesDestroyed = true
      logger.debug('editor.preview_engine_disposed', {
        projectName: input.projectName,
        durationMs: Math.round(performance.now() - startedAt)
      })
      if (runtime) {
        destroyStoryRuntime(runtime)
        preloadedModels = []
      } else {
        destroyPreloadedModels()
      }
      if (app && appInitialized) app.destroy(true, { children: true })
    }

    function disposeEngine(): void {
      if (disposed) return
      disposed = true
      sessionRef.current?.dispose()
      sessionRef.current = null
      onActiveSnippetIdsChange(new Set())
      const destructionTask: Promise<void> = initializationTask
        .catch((): void => undefined)
        .then((): Promise<void> => playbackQueueRef.current.catch((): void => undefined))
        .then(destroyResources)
      engineLifecycleRef.current = destructionTask
    }

    async function initialize(): Promise<void> {
      if (disposed) return
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
        if (disposed) return
        stageElement.replaceChildren(previewApp.canvas)
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
        setEngine({ app: previewApp, runtime })
        logger.info('editor.preview_engine_ready', {
          projectName: input.projectName,
          durationMs: Math.round(performance.now() - startedAt)
        })
      } catch (error: unknown) {
        if (disposed) return
        console.error('Editor preview failed', error)
        logger.error('editor.preview_engine_failed', {
          projectName: input.projectName,
          durationMs: Math.round(performance.now() - startedAt),
          error: describeLogError(error)
        })
        setStatus('error')
        setMessage(describePreviewError(error))
        disposeEngine()
      }
    }

    const previousLifecycle: Promise<void> = engineLifecycleRef.current
    initializationTask = previousLifecycle.catch((): void => undefined).then(initialize)
    engineLifecycleRef.current = initializationTask
    void initializationTask

    return (): void => {
      disposeEngine()
    }
  }, [input, onActiveSnippetIdsChange, t])

  useEffect((): (() => void) | undefined => {
    if (!engine) return undefined
    const previewEngine: PreviewEngine = engine
    let disposed = false
    let dispatcher: StoryDispatcher | null = null
    const activeSnippetIds = new Set<string>()
    const targetPausedRef: { current: boolean } = { current: false }
    const startedAt: number = performance.now()
    const requestedFromToolbar: boolean = previousPreviewRequestRef.current !== previewRequest
    const useImmediateStart: boolean = initialLoadRef.current || requestedFromToolbar
    previousPreviewRequestRef.current = previewRequest
    initialLoadRef.current = false
    prefixCacheRef.current.update(story as StoryData)
    setStatus('loading')
    setMessage(t('editor.initializingPreview'))

    function disposePlayback(): void {
      if (disposed) return
      disposed = true
      dispatcher?.cancel()
      if (sessionRef.current?.dispatcher === dispatcher) sessionRef.current = null
      if (pendingDisposeRef.current === disposePlayback) pendingDisposeRef.current = null
      activeSnippetIds.clear()
      onActiveSnippetIdsChange(new Set())
    }

    function handleStoryEvent(event: StoryDispatcherEvent): void {
      if (disposed) return
      if (event.type === 'snippet:start' && event.snippet.id) {
        activeSnippetIds.add(event.snippet.id)
        onActiveSnippetIdsChange(new Set(activeSnippetIds))
      }
      if (
        (event.type === 'snippet:complete' || event.type === 'snippet:error') &&
        event.snippet.id
      ) {
        activeSnippetIds.delete(event.snippet.id)
        onActiveSnippetIdsChange(new Set(activeSnippetIds))
        if (
          pauseAfterPreviewTarget &&
          event.type === 'snippet:complete' &&
          event.snippet.id === previewTargetNodeId
        )
          targetPausedRef.current = true
      }
      if (event.type === 'story:pause') {
        setStatus('paused')
        setMessage(t('editor.paused'))
        if (targetPausedRef.current && previewTargetNodeId) {
          activeSnippetIds.add(previewTargetNodeId)
          onActiveSnippetIdsChange(new Set(activeSnippetIds))
        }
      }
      if (event.type === 'story:resume') {
        setStatus('running')
        setMessage(t('editor.resume'))
      }
    }

    async function startPlayback(): Promise<void> {
      if (disposed) return
      dispatcher = new StoryDispatcher(previewEngine.runtime, { onEvent: handleStoryEvent })
      sessionRef.current = { dispatcher, dispose: disposePlayback }
      if (pendingDisposeRef.current === disposePlayback) pendingDisposeRef.current = null
      setStatus('running')
      setMessage(previewTargetNodeId ? t('editor.restoringSelectedState') : t('editor.playing'))
      try {
        if (previewTargetNodeId) {
          await dispatcher.runFrom(story as StoryData, previewTargetNodeId, {
            initialState: prefixCacheRef.current.before(previewTargetNodeId),
            ...(pauseAfterPreviewTarget ? { pauseAfterSnippetId: previewTargetNodeId } : {})
          })
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
        logger.error('editor.preview_failed', {
          projectName: input.projectName,
          error: describeLogError(error)
        })
        setStatus('error')
        setMessage(describePreviewError(error))
      }
    }

    pendingDisposeRef.current = disposePlayback
    const timeoutId: number = window.setTimeout(
      (): void => {
        const queuedPlayback: Promise<void> = playbackQueueRef.current
          .catch((): void => undefined)
          .then(startPlayback)
        playbackQueueRef.current = queuedPlayback
        void queuedPlayback.catch((error: unknown): void => {
          logger.error('editor.preview_queue_failed', {
            projectName: input.projectName,
            error: describeLogError(error)
          })
        })
      },
      useImmediateStart ? 0 : 500
    )
    return (): void => {
      window.clearTimeout(timeoutId)
      disposePlayback()
    }
  }, [
    engine,
    input.projectName,
    onActiveSnippetIdsChange,
    pauseAfterPreviewTarget,
    previewRequest,
    previewTargetNodeId,
    story,
    t
  ])

  function restart(): void {
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
    pendingDisposeRef.current?.()
    pendingDisposeRef.current = null
    sessionRef.current?.dispose()
    setStatus('stopped')
    setMessage(t('editor.stopped'))
  }

  const playing: boolean = status === 'running'
  const paused: boolean = status === 'paused'

  return (
    <section
      data-tour="editor-preview-stage"
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col overflow-hidden',
        compact ? 'bg-black' : 'bg-background'
      )}
    >
      <div
        className={cn(
          'flex shrink-0 items-center border-b',
          compact ? 'h-10 border-white/10 bg-black px-2 text-white' : 'h-12 bg-background/70 px-4'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium">{t('editor.previewPanel')}</span>
        </div>
        <div
          className={cn(
            'ml-auto flex min-w-0 items-center gap-1.5 text-xs',
            compact ? 'text-white/60' : 'text-muted-foreground'
          )}
        >
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

      <div
        className={cn(
          'flex min-h-0 flex-1 items-center justify-center',
          compact ? 'bg-black p-0' : 'bg-background p-5'
        )}
      >
        <div
          className={cn(
            'relative w-full max-w-[960px] overflow-hidden bg-black',
            compact ? 'rounded-none border-0 shadow-none' : 'rounded-md border shadow-sm'
          )}
        >
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

      <div
        className={cn(
          'flex shrink-0 items-center border-t',
          compact ? 'h-11 border-white/10 bg-black px-2 text-white' : 'h-12 bg-background px-4'
        )}
      >
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={compact ? 'size-9' : 'size-8'}
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
            className={compact ? 'size-9' : 'size-8'}
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
            className={compact ? 'size-9' : 'size-8'}
            aria-label={t('editor.stop')}
            title={t('editor.stop')}
            disabled={status === 'stopped' || status === 'idle'}
            onClick={stop}
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        </div>
        <div className={cn('mx-3 h-px flex-1', compact ? 'bg-white/15' : 'bg-border')} />
        <span
          className={cn(
            'font-mono text-[11px]',
            compact ? 'text-white/55' : 'text-muted-foreground'
          )}
        >
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
    return i18n.t('editor.modelLoadFailed', { model: error.modelName })
  }
  if (error instanceof StorySnippetError) {
    const reason: string = error.cause instanceof Error ? `：${error.cause.message}` : ''
    return i18n.t('editor.snippetExecutionFailed', {
      path: error.path.join('.'),
      type: error.snippet.type,
      reason
    })
  }
  return error instanceof Error ? error.message : i18n.t('editor.previewInitializationFailed')
}
