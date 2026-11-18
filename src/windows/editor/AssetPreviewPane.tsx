import type { ChangeEvent, CSSProperties, JSX, ReactNode } from 'react'
import { useState } from 'react'
import { ChevronDown, ChevronLeft, Image as ImageIcon, LoaderCircle, Play, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { projectAssetUrl } from '@/lib/projectAssetUrl'
import { cn } from '@/lib/style'
import type { BackgroundAsset, ModelAsset } from '@/project/assets'
import type { EditorAssetSelection } from './editorCatalog'
import type { EditorPreviewInput } from './EditorPreview'
import { ModelOptionSheet } from './ModelOptionSheet'
import {
  MODEL_PIVOT_POSITION,
  useModelPreviewSession,
  type ModelPreviewControls,
  type ModelPreviewSession
} from './useModelPreviewSession'

// The story stage is always 16:9; on touch layouts the preview shows exactly that frame so models
// and backgrounds sit where they will in the story.
const STAGE_FRAME_STYLE: CSSProperties = {
  width: 'min(100cqw, calc(100cqh * 16 / 9))',
  aspectRatio: '16 / 9'
}

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

  return (
    <section
      data-slot="asset-preview-pane"
      className={cn(
        'absolute inset-0 z-20 flex min-h-0 min-w-0 flex-col overflow-hidden',
        compact ? 'bg-black text-white' : 'bg-background'
      )}
    >
      {compact ? (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-white/10 pr-3 pl-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0"
            aria-label={t('editor.backToStagePreview')}
            title={t('editor.backToStagePreview')}
            onClick={onClose}
          >
            <ChevronLeft className="size-5" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        </div>
      ) : (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{title}</span>
          </div>
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
      )}
      {backgroundAsset ? (
        <BackgroundImagePreview
          key={selection.key}
          projectPath={input.projectPath}
          asset={backgroundAsset}
          name={title}
          compact={compact}
        />
      ) : (
        <ModelPreview
          key={selection.key}
          modelKey={selection.key}
          input={input}
          compact={compact}
        />
      )}
    </section>
  )
}

function StageFrame({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black [container-type:size]">
      <div
        className="relative overflow-hidden bg-neutral-950 ring-1 ring-white/10"
        style={STAGE_FRAME_STYLE}
      >
        {children}
      </div>
    </div>
  )
}

function BackgroundImagePreview({
  projectPath,
  asset,
  name,
  compact
}: {
  projectPath: string
  asset: BackgroundAsset
  name: string
  compact: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const [loadError, setLoadError] = useState<boolean>(false)
  const url: string = projectAssetUrl(projectPath, asset.path)

  if (compact) {
    // The story crops backgrounds to cover the stage, so the frame shows the same crop.
    return (
      <StageFrame>
        {loadError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/55">
            <ImageIcon className="size-8 stroke-[1.5]" />
            <span className="text-xs">{t('editor.failedToLoadImage')}</span>
          </div>
        ) : (
          <img
            src={url}
            alt={name}
            className="size-full object-cover"
            onError={(): void => setLoadError(true)}
          />
        )}
      </StageFrame>
    )
  }

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
          src={url}
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
  input,
  compact
}: {
  modelKey: string
  input: EditorPreviewInput
  compact: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const { stageRef, controls }: ModelPreviewSession = useModelPreviewSession(modelKey, input)

  const stage: JSX.Element = <div ref={stageRef} className="absolute inset-0" />
  const statusLayer: JSX.Element | null =
    controls.status === 'ready' ? null : (
      <div
        className={cn(
          'pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs',
          compact ? 'text-white/55' : 'text-muted-foreground'
        )}
      >
        {controls.status === 'loading' ? <LoaderCircle className="size-5 animate-spin" /> : null}
        <span>
          {controls.status === 'loading'
            ? t('editor.modelPreviewLoading')
            : t('editor.modelPreviewFailed')}
        </span>
      </div>
    )

  if (compact) {
    return (
      <>
        <StageFrame>
          {stage}
          {controls.status === 'ready' ? <PivotMarker /> : null}
          {statusLayer}
        </StageFrame>
        <CompactModelControls controls={controls} />
      </>
    )
  }

  return (
    <>
      <div className="relative min-h-0 flex-1 bg-muted/40">
        {stage}
        {statusLayer}
      </div>
      <DesktopModelControls controls={controls} />
    </>
  )
}

/** Marks the model's anchor point, so the inspector's anchor and scale values read spatially. */
function PivotMarker(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2"
      style={{
        left: `${MODEL_PIVOT_POSITION.x * 100}%`,
        top: `${MODEL_PIVOT_POSITION.y * 100}%`
      }}
    >
      <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-amber-400/80" />
      <span className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-amber-400/80" />
    </span>
  )
}

type OpenSheet = 'motion' | 'facial' | null

function CompactModelControls({ controls }: { controls: ModelPreviewControls }): JSX.Element {
  const { t } = useTranslation()
  const [openSheet, setOpenSheet] = useState<OpenSheet>(null)
  const ready: boolean = controls.status === 'ready'

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-t border-white/10 px-2">
      <PickerChip
        label={t('snippetFields.motion')}
        value={controls.motion}
        disabled={!ready}
        onClick={(): void => setOpenSheet('motion')}
      />
      <PickerChip
        label={t('snippetFields.facial')}
        value={controls.facial}
        disabled={!ready}
        onClick={(): void => setOpenSheet('facial')}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-9 shrink-0"
        aria-label={t('common.play')}
        title={t('common.play')}
        disabled={!ready || (!controls.motion && !controls.facial)}
        onClick={controls.replay}
      >
        <Play className="size-4 fill-current" />
      </Button>
      <ModelOptionSheet
        open={openSheet === 'motion'}
        onOpenChange={(open: boolean): void => setOpenSheet(open ? 'motion' : null)}
        title={t('snippetFields.motion')}
        options={controls.motions}
        value={controls.motion}
        noneLabel={t('editor.modelPreviewNone')}
        onSelect={controls.selectMotion}
      />
      <ModelOptionSheet
        open={openSheet === 'facial'}
        onOpenChange={(open: boolean): void => setOpenSheet(open ? 'facial' : null)}
        title={t('snippetFields.facial')}
        options={controls.facials}
        value={controls.facial}
        noneLabel={t('editor.modelPreviewNone')}
        onSelect={controls.selectFacial}
      />
    </div>
  )
}

function PickerChip({
  label,
  value,
  disabled,
  onClick
}: {
  label: string
  value: string
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={value ? `${label}: ${value}` : label}
      disabled={disabled}
      className={cn(
        'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border px-3 text-left text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40',
        value
          ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
          : 'border-white/15 text-white/70 active:bg-white/10'
      )}
      onClick={onClick}
    >
      <span className={cn('min-w-0 flex-1 truncate', value && 'font-mono')}>{value || label}</span>
      <ChevronDown className="size-3.5 shrink-0 opacity-60" />
    </button>
  )
}

function DesktopModelControls({ controls }: { controls: ModelPreviewControls }): JSX.Element {
  const { t } = useTranslation()
  const ready: boolean = controls.status === 'ready'

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t px-3 py-2 text-xs">
      <DesktopSelect
        label={t('snippetFields.motion')}
        noneLabel={t('editor.modelPreviewNone')}
        value={controls.motion}
        options={controls.motions}
        disabled={!ready}
        onChange={controls.selectMotion}
      />
      <DesktopSelect
        label={t('snippetFields.facial')}
        noneLabel={t('editor.modelPreviewNone')}
        value={controls.facial}
        options={controls.facials}
        disabled={!ready}
        onChange={controls.selectFacial}
      />
      <Button
        type="button"
        size="sm"
        className="shrink-0 gap-1.5 text-xs"
        disabled={!ready || (!controls.motion && !controls.facial)}
        onClick={controls.replay}
      >
        <Play className="size-3.5" />
        {t('common.play')}
      </Button>
    </div>
  )
}

function DesktopSelect({
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
        aria-label={label}
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
