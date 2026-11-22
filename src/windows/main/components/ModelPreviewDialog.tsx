import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import { useViewportMode, type ViewportMode } from '@/hooks/useViewportMode'
import { describeError, logger } from '@/lib/logger'
import { localAssetUrl } from '@/lib/projectAssetUrl'
import { cn } from '@/lib/style'
import { isStaticModelEntry } from '@/modelRegistry/isStaticModelEntry'
import type { ModelRegistryEntry } from '@/modelRegistry/schema'
import { useSettings } from '@/settings/useSettings'
import { ModelPreviewView } from '@/windows/editor/AssetPreviewPane'
import { resolveRenderPrecision } from '@/windows/editor/resolveRenderPrecision'
import { useModelPreview, type ModelPreviewSession } from '@/windows/editor/useModelPreviewSession'
import { getDataPath } from '@/workspace/api'

/** Previews one global model on a stage, with its motions and facials where it has any. */
export default function ModelPreviewDialog({
  open,
  modelId,
  name,
  entry,
  description,
  onClose
}: {
  /** Controlled so the dialog can fade out; the heavy preview only lives while it is open. */
  open: boolean
  modelId: string
  name: string
  entry: ModelRegistryEntry
  description: string
  onClose: () => void
}): JSX.Element {
  const [dataPath, setDataPath] = useState<string | null>(null)
  const [dataPathFailed, setDataPathFailed] = useState<boolean>(false)
  const viewportMode: ViewportMode = useViewportMode()
  const compact: boolean = viewportMode === 'phone'

  useEffect((): void => {
    getDataPath().then(setDataPath, (error: unknown): void => {
      logger.error('models.preview_data_path_failed', { error: describeError(error) })
      setDataPathFailed(true)
    })
  }, [])

  return (
    <Dialog
      open={open}
      onOpenChange={(open: boolean): void => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-3xl min-w-0 select-none">
        <DialogHeader className="min-w-0 pr-6 text-left">
          <DialogTitle className="truncate">{name}</DialogTitle>
          <DialogDescription className="truncate">{description}</DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            'flex min-w-0 flex-col overflow-hidden rounded-lg border bg-background',
            compact ? 'h-[min(62dvh,36rem)]' : 'h-[min(65vh,32rem)]'
          )}
        >
          {dataPath === null ? (
            <PreviewMessage failed={dataPathFailed} />
          ) : (
            <PreviewBody dataPath={dataPath} modelId={modelId} entry={entry} compact={compact} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PreviewBody({
  dataPath,
  modelId,
  entry,
  compact
}: {
  dataPath: string
  modelId: string
  entry: ModelRegistryEntry
  compact: boolean
}): JSX.Element {
  const { playback } = useSettings()
  const staticPortrait: boolean = isStaticModelEntry(entry.entry)
  const session: ModelPreviewSession = useModelPreview({
    modelUrl: localAssetUrl(dataPath, `models/${modelId}/${entry.entry}`),
    framing: { kind: 'fit' },
    staticPortrait,
    motions: entry.motions,
    facials: entry.facials,
    renderPrecision: resolveRenderPrecision(playback.renderPrecision),
    logContext: { modelId }
  })

  return <ModelPreviewView session={session} compact={compact} fill />
}

function PreviewMessage({ failed }: { failed: boolean }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
      {failed ? null : <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />}
      <span>{failed ? t('editor.modelPreviewFailed') : t('editor.modelPreviewLoading')}</span>
    </div>
  )
}
