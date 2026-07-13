import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Application } from 'pixi.js'
import { CircleDot, LoaderCircle, Pause, Play, RotateCcw, Square } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/style'
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
  selectedNodeId,
  previewRequest,
  previewTargetNodeId,
  onPreviewFromBeginning
}: {
  input: EditorPreviewInput
  story: EditorStory
  selectedNodeId: string | null
  previewRequest: number
  previewTargetNodeId: string | null
  onPreviewFromBeginning: () => void
}): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<PreviewSession | null>(null)
  const previousPreviewRequestRef = useRef<number>(previewRequest)
  const initialLoadRef = useRef<boolean>(true)
  const [status, setStatus] = useState<PreviewStatus>('idle')
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null)
  const [message, setMessage] = useState<string>('等待预览')

  useEffect((): (() => void) | undefined => {
    const currentStageElement: HTMLDivElement | null = stageRef.current
    if (!currentStageElement) return undefined
    const stageElement: HTMLDivElement = currentStageElement

    let disposed = false
    let app: Application | null = null
    let dispatcher: StoryDispatcher | null = null
    let runtime: StoryRuntime | null = null
    let preloadedModels: StoryModelInstance[] = []
    let started = false
    const requestedFromToolbar: boolean = previousPreviewRequestRef.current !== previewRequest
    const useImmediateStart: boolean = initialLoadRef.current || requestedFromToolbar
    previousPreviewRequestRef.current = previewRequest
    initialLoadRef.current = false

    function dispose(): void {
      if (disposed) return
      disposed = true
      dispatcher?.cancel()
      if (runtime) {
        destroyStoryRuntime(runtime)
      } else {
        for (const { model } of preloadedModels) {
          model.destroy({ children: true })
        }
      }
      const canvas: HTMLCanvasElement | null = app?.canvas ?? null
      app?.destroy(true, { children: true })
      if (canvas && stageElement.contains(canvas)) {
        stageElement.replaceChildren()
      }
      if (sessionRef.current?.dispatcher === dispatcher) {
        sessionRef.current = null
      }
    }

    async function start(): Promise<void> {
      if (disposed) return
      started = true
      setStatus('loading')
      setMessage('初始化 Pixi 预览')
      setActiveNodeId(null)

      try {
        await ensureSekaiLive2DReady()
        if (disposed) return

        app = new Application()
        await app.init({
          resizeTo: stageElement,
          preference: 'webgl',
          autoDensity: true,
          resolution: resolveRenderPrecision(input.settings),
          backgroundAlpha: 0
        })
        if (disposed) return
        stageElement.replaceChildren(app.canvas)

        setMessage('加载字体和模型')
        const fontFamily: string = await loadPlaybackFontFamily(input.settings, input.dataPath)
        if (disposed) return
        preloadedModels = await preloadStoryModels({
          app,
          dataPath: input.dataPath,
          assets: input.assets,
          modelRegistry: input.modelRegistry
        })
        if (disposed) return

        runtime = createStoryRuntime({
          app,
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
              : '播放中'
        )
        if (previewTargetNodeId) {
          await dispatcher.runFrom(story as StoryData, previewTargetNodeId)
        } else {
          await dispatcher.run(story as StoryData)
        }
        if (!disposed) {
          setStatus('completed')
          setMessage('预览完成')
        }
      } catch (error: unknown) {
        if (disposed) return
        console.error('Editor preview failed', error)
        setStatus('error')
        setMessage(describePreviewError(error))
      }
    }

    function handleStoryEvent(event: StoryDispatcherEvent): void {
      if (disposed) return
      if (event.type === 'snippet:start') {
        setActiveNodeId(event.snippet.id ?? null)
        setMessage('播放中')
      }
      if (event.type === 'story:pause') {
        setStatus('paused')
        setMessage('已暂停')
      }
      if (event.type === 'story:resume') {
        setStatus('running')
        setMessage('继续播放')
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
  }, [input, previewRequest, previewTargetNodeId, story])

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
    setMessage('预览已停止')
    setActiveNodeId(null)
  }

  const playing: boolean = status === 'running'
  const paused: boolean = status === 'paused'
  const isSelectedActive: boolean = Boolean(selectedNodeId && selectedNodeId === activeNodeId)

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-muted/15">
      <div className="flex h-12 shrink-0 items-center border-b bg-background/70 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium">画面预览</span>
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
            <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-sm bg-black/55 px-2 py-1 text-[10px] text-white/85">
              <CircleDot className={cn('size-3', playing ? 'text-emerald-300' : 'text-white/50')} />
              <span>
                {activeNodeId
                  ? `运行节点 ${activeNodeId.slice(0, 8)}`
                  : previewTargetNodeId
                    ? '正在定位选中片段'
                    : '从头实时预览'}
              </span>
            </div>
            {selectedNodeId && (
              <div
                className={cn(
                  'pointer-events-none absolute right-3 top-3 rounded-sm px-2 py-1 font-mono text-[10px] transition-colors',
                  isSelectedActive ? 'bg-emerald-500 text-white' : 'bg-black/50 text-white/65'
                )}
              >
                {isSelectedActive ? '已到达选中片段' : '等待选中片段'}
              </div>
            )}
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
            aria-label="从头重播"
            title="从头重播"
            onClick={restart}
          >
            <RotateCcw className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={paused ? '继续预览' : '暂停预览'}
            title={paused ? '继续预览' : '暂停预览'}
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
            aria-label="停止预览"
            title="停止预览"
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
