import type { ChangeEvent, JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Application } from 'pixi.js'
import { FolderOpen, Image as ImageIcon, LoaderCircle, Play, X } from 'lucide-react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { describeError, logger } from '@/lib/logger'
import { ensureSekaiLive2DReady, loadSekaiLive2DModel, type SekaiLive2DModel } from '@/lib/live2d'
import { isDesktopRuntime } from '@/lib/platform'
import { projectAssetUrl } from '@/lib/projectAssetUrl'
import { cn } from '@/lib/style'
import type { BackgroundAsset, ModelAsset } from '@/project/assets'
import { applyAndWaitModelMotion, resolveModelUrl, stopModelMotions } from '@/story'
import type { EditorAssetSelection } from './editorCatalog'
import type { EditorPreviewInput } from './EditorPreview'
import { resolveRenderPrecision } from './resolveRenderPrecision'

const MODEL_FIT_RATIO: number = 0.92
const MOTION_POLL_INTERVAL_MS: number = 50

type ModelPreviewStatus = 'loading' | 'ready' | 'error'

export function AssetPreviewPane({
  selection,
  input,
  compact = false,
  onClose
}: {
  selection: EditorAssetSelection
  input: EditorPreviewInput
  compact?: boolean
  onClose: () => void
}): JSX.Element | null {
  const { t } = useTranslation()
  const backgroundAsset: BackgroundAsset | undefined =
    selection.kind === 'backgrounds' ? input.assets.backgrounds[selection.key] : undefined
  const modelAsset: ModelAsset | undefined =
    selection.kind === 'models' ? input.assets.models[selection.key] : undefined
  if (!backgroundAsset && !modelAsset) return null

  const title: string = backgroundAsset
    ? backgroundAsset.name || selection.key
    : (modelAsset?.name ?? modelAsset?.modelId ?? selection.key)

  const handleRevealInDir = async (asset: BackgroundAsset): Promise<void> => {
    try {
      const normalizedRoot: string = input.projectPath.replace(/[\\/]+$/, '')
      const normalizedRelative: string = asset.path.replace(/^[\\/]+/, '')
      if (normalizedRelative.split(/[\\/]+/).includes('..')) {
        throw new Error(`Asset path must not contain parent directory segments: ${asset.path}`)
      }
      const fullPath: string = `${normalizedRoot}/${normalizedRelative}`
      await revealItemInDir(fullPath)
      logger.info('editor.background_revealed_in_dir', { path: fullPath })
    } catch (error: unknown) {
      logger.error('editor.background_reveal_failed', { error: describeError(error) })
    }
  }

  return (
    <section
      data-slot="asset-preview-pane"
      className={cn(
        'absolute inset-0 z-20 flex min-h-0 min-w-0 flex-col overflow-hidden',
        compact ? 'bg-black text-white' : 'bg-background'
      )}
    >
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 border-b',
          compact ? 'h-10 border-white/10 px-2' : 'h-12 px-4'
        )}
      >
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
        </div>
        {backgroundAsset && isDesktopRuntime() ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5 text-xs"
            onClick={(): void => {
              void handleRevealInDir(backgroundAsset)
            }}
          >
            <FolderOpen className="size-3.5" />
            {t('editor.revealInExplorer')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5 text-xs"
          onClick={onClose}
        >
          <X className="size-3.5" />
          {t('editor.backToStagePreview')}
        </Button>
      </div>
      {backgroundAsset ? (
        <BackgroundImagePreview
          key={selection.key}
          projectPath={input.projectPath}
          asset={backgroundAsset}
          name={title}
        />
      ) : (
        <ModelPreview key={selection.key} modelKey={selection.key} input={input} />
      )}
    </section>
  )
}

function BackgroundImagePreview({
  projectPath,
  asset,
  name
}: {
  projectPath: string
  asset: BackgroundAsset
  name: string
}): JSX.Element {
  const { t } = useTranslation()
  const [loadError, setLoadError] = useState<boolean>(false)

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
      <div
        className="pointer-events-none absolute inset-0 opacity-25"
        style={{
          backgroundImage: `linear-gradient(45deg, #888 25%, transparent 25%),
            linear-gradient(-45deg, #888 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #888 75%),
            linear-gradient(-45deg, transparent 75%, #888 75%)`,
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0'
        }}
      />
      {loadError ? (
        <div className="relative z-10 flex flex-col items-center gap-2 text-muted-foreground">
          <ImageIcon className="size-10 stroke-[1.5]" />
          <span className="text-xs">{t('editor.failedToLoadImage')}</span>
        </div>
      ) : (
        <img
          src={projectAssetUrl(projectPath, asset.path)}
          alt={name}
          className="relative z-10 max-h-full max-w-full rounded object-contain shadow-sm"
          onError={(): void => setLoadError(true)}
        />
      )}
    </div>
  )
}

function ModelPreview({
  modelKey,
  input
}: {
  modelKey: string
  input: EditorPreviewInput
}): JSX.Element {
  const { t } = useTranslation()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const modelRef = useRef<SekaiLive2DModel | null>(null)
  const playbackTokenRef = useRef<number>(0)
  const [status, setStatus] = useState<ModelPreviewStatus>('loading')
  const [motion, setMotion] = useState<string>('')
  const [facial, setFacial] = useState<string>('')

  const modelId: string | undefined = input.assets.models[modelKey]?.modelId
  const registryEntry = modelId ? input.modelRegistry.models[modelId] : undefined
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
      const { width, height } = app.screen
      model.scale.set(1)
      const baseWidth: number = model.width
      const baseHeight: number = model.height
      if (baseWidth <= 0 || baseHeight <= 0) return
      model.scale.set(Math.min(width / baseWidth, height / baseHeight) * MODEL_FIT_RATIO)
      model.position.set(width / 2, height / 2)
    }

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
        loaded.anchor.set(0.5)
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
      modelRef.current = null
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

  const playPreview = (nextMotion: string, nextFacial: string): void => {
    const model: SekaiLive2DModel | null = modelRef.current
    if (!model) return

    const token: number = ++playbackTokenRef.current
    if (!nextMotion && !nextFacial) {
      stopModelMotions(model)
      return
    }

    const waitUntil = (whenFinish: () => boolean): Promise<void> =>
      new Promise<void>((resolve): void => {
        const check = (): void => {
          if (playbackTokenRef.current !== token || !modelRef.current || whenFinish()) {
            resolve()
            return
          }
          window.setTimeout(check, MOTION_POLL_INTERVAL_MS)
        }
        check()
      })

    void applyAndWaitModelMotion(
      model,
      waitUntil,
      nextMotion || undefined,
      nextFacial || undefined
    ).catch((error: unknown): void => {
      logger.warn('editor.asset_model_preview_motion_failed', {
        projectName: input.projectName,
        modelKey,
        error: describeError(error)
      })
    })
  }

  const ready: boolean = status === 'ready'

  return (
    <>
      <div className="relative min-h-0 flex-1 bg-muted/40">
        <div ref={stageRef} className="absolute inset-0" />
        {status !== 'ready' ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            {status === 'loading' ? <LoaderCircle className="size-5 animate-spin" /> : null}
            <span>
              {status === 'loading'
                ? t('editor.modelPreviewLoading')
                : t('editor.modelPreviewFailed')}
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t px-3 py-2 text-xs">
        <ModelPreviewSelect
          label={t('snippetFields.motion')}
          noneLabel={t('editor.modelPreviewNone')}
          value={motion}
          options={motions}
          disabled={!ready}
          onChange={(value: string): void => {
            setMotion(value)
            playPreview(value, facial)
          }}
        />
        <ModelPreviewSelect
          label={t('snippetFields.facial')}
          noneLabel={t('editor.modelPreviewNone')}
          value={facial}
          options={facials}
          disabled={!ready}
          onChange={(value: string): void => {
            setFacial(value)
            playPreview(motion, value)
          }}
        />
        <Button
          type="button"
          size="sm"
          className="gap-1.5 text-xs"
          disabled={!ready || (!motion && !facial)}
          onClick={(): void => playPreview(motion, facial)}
        >
          <Play className="size-3.5" />
          {t('common.play')}
        </Button>
      </div>
    </>
  )
}

function ModelPreviewSelect({
  label,
  noneLabel,
  value,
  options,
  disabled,
  onChange
}: {
  label: string
  noneLabel: string
  value: string
  options: readonly string[]
  disabled: boolean
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <label className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <select
        className="h-8 min-w-0 max-w-48 rounded-md border bg-background px-2 text-xs text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
          onChange(event.currentTarget.value)
        }
      >
        <option value="">{noneLabel}</option>
        {options.map(
          (name: string): JSX.Element => (
            <option key={name} value={name}>
              {name}
            </option>
          )
        )}
      </select>
    </label>
  )
}
