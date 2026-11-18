import type { RefObject } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Application } from 'pixi.js'
import { describeError, logger } from '@/lib/logger'
import { ensureSekaiLive2DReady, loadSekaiLive2DModel, type SekaiLive2DModel } from '@/lib/live2d'
import type { ModelRegistry } from '@/modelRegistry/schema'
import {
  applyAndWaitModelFacial,
  applyAndWaitModelMotion,
  resolveModelUrl,
  stopModelMotions
} from '@/story'
import type { EditorPreviewInput } from './EditorPreview'
import { resolveRenderPrecision } from './resolveRenderPrecision'

// Mirrors the stage's Normal layout / Center placement (see layoutModel in story/scene.ts).
const CENTER_POSITION_X: number = 0.5
const CENTER_POSITION_Y: number = 0.5
const MODEL_POSITION_Y_OFFSET: number = 0.3
const MOTION_POLL_INTERVAL_MS: number = 50

/** Where the model's anchor point sits in the stage frame, as fractions of its width and height. */
export const MODEL_PIVOT_POSITION: { readonly x: number; readonly y: number } = {
  x: CENTER_POSITION_X,
  y: CENTER_POSITION_Y + MODEL_POSITION_Y_OFFSET
}

export type ModelPreviewStatus = 'loading' | 'ready' | 'error'

type ModelLayout = {
  anchor: number
  normalScale: number
}

export type ModelPreviewControls = {
  status: ModelPreviewStatus
  motions: readonly string[]
  facials: readonly string[]
  motion: string
  facial: string
  selectMotion: (value: string) => void
  selectFacial: (value: string) => void
  replay: () => void
}

export type ModelPreviewSession = {
  /** Attach to the element the Pixi canvas should fill. */
  stageRef: RefObject<HTMLDivElement | null>
  controls: ModelPreviewControls
}

export function useModelPreviewSession(
  modelKey: string,
  input: EditorPreviewInput
): ModelPreviewSession {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const modelRef = useRef<SekaiLive2DModel | null>(null)
  const playbackTokenRef = useRef<number>(0)
  const facialTokenRef = useRef<number>(0)
  const layoutRef = useRef<ModelLayout>({ anchor: 0.5, normalScale: 1 })
  const fitRef = useRef<(() => void) | null>(null)
  const [status, setStatus] = useState<ModelPreviewStatus>('loading')
  const [motion, setMotion] = useState<string>('')
  const [facial, setFacial] = useState<string>('')

  const modelId: string | undefined = input.assets.models[modelKey]?.modelId
  const anchor: number = input.assets.models[modelKey]?.anchor ?? 0.5
  const normalScale: number = input.assets.models[modelKey]?.normalScale ?? 1
  const registryEntry: ModelRegistry['models'][string] | undefined = modelId
    ? input.modelRegistry.models[modelId]
    : undefined
  const motions: readonly string[] = registryEntry?.motions ?? []
  const facials: readonly string[] = registryEntry?.facials ?? []
  const renderPrecision: number = resolveRenderPrecision(input.settings)
  // Keyed on the resolved URL so unrelated asset edits do not reload the model.
  const modelUrl: string | null = useMemo((): string | null => {
    try {
      return resolveModelUrl(input.dataPath, input.assets, input.modelRegistry, modelKey).url
    } catch {
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.dataPath, modelId, registryEntry?.entry, modelKey])

  useEffect((): void => {
    layoutRef.current = { anchor, normalScale }
    fitRef.current?.()
  }, [anchor, normalScale])

  useEffect((): (() => void) | undefined => {
    const stageElement: HTMLDivElement | null = stageRef.current
    if (!stageElement) return undefined
    if (!modelUrl) {
      setStatus('error')
      return undefined
    }

    let disposed: boolean = false
    let app: Application | null = null
    let appInitialized: boolean = false
    let model: SekaiLive2DModel | null = null
    setStatus('loading')

    function fit(): void {
      if (!app || !model) return
      const { anchor: modelAnchor, normalScale: modelScale }: ModelLayout = layoutRef.current
      const { width, height } = app.screen
      model.anchor.set(0.5, modelAnchor)
      model.scale.set((height / model.internalModel.originalHeight) * modelScale)
      model.position.set(width * MODEL_PIVOT_POSITION.x, height * MODEL_PIVOT_POSITION.y)
    }
    fitRef.current = fit

    async function initialize(url: string, element: HTMLDivElement): Promise<void> {
      try {
        await ensureSekaiLive2DReady()
        if (disposed) return

        const previewApp: Application = new Application()
        app = previewApp
        await previewApp.init({
          resizeTo: element,
          preference: 'webgl',
          autoDensity: true,
          resolution: renderPrecision,
          backgroundAlpha: 0
        })
        appInitialized = true
        if (disposed) {
          previewApp.destroy(true, { children: true })
          return
        }
        element.replaceChildren(previewApp.canvas)

        const loaded: SekaiLive2DModel = await loadSekaiLive2DModel(url, {
          ticker: previewApp.ticker
        })
        if (disposed) {
          try {
            loaded.destroy({ children: true })
          } catch {
            // The app (and its ticker) may already be destroyed by cleanup.
          }
          return
        }
        model = loaded
        modelRef.current = loaded
        previewApp.stage.addChild(loaded)
        fit()
        previewApp.renderer.on('resize', fit)
        setStatus('ready')
      } catch (error: unknown) {
        if (disposed) return
        logger.error('editor.asset_model_preview_failed', {
          projectName: input.projectName,
          modelKey,
          error: describeError(error)
        })
        setStatus('error')
      }
    }

    void initialize(modelUrl, stageElement)

    return (): void => {
      disposed = true
      playbackTokenRef.current += 1
      facialTokenRef.current += 1
      modelRef.current = null
      fitRef.current = null
      // The model unregisters itself from the app ticker, so it must be destroyed before the app.
      model?.destroy({ children: true })
      model = null
      if (app && appInitialized) {
        app.renderer.off('resize', fit)
        app.destroy(true, { children: true })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl, renderPrecision, modelKey])

  const logPlaybackFailure = (error: unknown): void => {
    logger.warn('editor.asset_model_preview_motion_failed', {
      projectName: input.projectName,
      modelKey,
      error: describeError(error)
    })
  }

  // Resolves once `whenFinish` holds, or when the playback it belongs to is superseded or disposed.
  const createWaitUntil =
    (tokenRef: RefObject<number>, token: number) =>
    (whenFinish: () => boolean): Promise<void> =>
      new Promise<void>((resolve): void => {
        const check = (): void => {
          if (tokenRef.current !== token || !modelRef.current || whenFinish()) {
            resolve()
            return
          }
          window.setTimeout(check, MOTION_POLL_INTERVAL_MS)
        }
        check()
      })

  const playPreview = (nextMotion: string, nextFacial: string): void => {
    const model: SekaiLive2DModel | null = modelRef.current
    if (!model) return

    const token: number = ++playbackTokenRef.current
    facialTokenRef.current += 1
    if (!nextMotion && !nextFacial) {
      stopModelMotions(model)
      return
    }

    void applyAndWaitModelMotion(
      model,
      createWaitUntil(playbackTokenRef, token),
      nextMotion || undefined,
      nextFacial || undefined
    ).catch(logPlaybackFailure)
  }

  // Changing the facial must not restart a body motion that is already playing.
  const playFacialOnly = (nextFacial: string): void => {
    const model: SekaiLive2DModel | null = modelRef.current
    if (!model || !nextFacial) return

    const token: number = ++facialTokenRef.current
    void applyAndWaitModelFacial(model, createWaitUntil(facialTokenRef, token), nextFacial).catch(
      logPlaybackFailure
    )
  }

  return {
    stageRef,
    controls: {
      status,
      motions,
      facials,
      motion,
      facial,
      selectMotion: (value: string): void => {
        setMotion(value)
        playPreview(value, facial)
      },
      selectFacial: (value: string): void => {
        setFacial(value)
        playFacialOnly(value)
      },
      replay: (): void => playPreview(motion, facial)
    }
  }
}
