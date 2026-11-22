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
import { localAssetUrl } from '@/lib/projectAssetUrl'
import { cn } from '@/lib/style'
import { defaultModelLayout, type ModelLayout } from '@/modelRegistry/defaultModelLayout'
import { isStaticModelEntry } from '@/modelRegistry/isStaticModelEntry'
import type { ModelRegistryEntry } from '@/modelRegistry/schema'
import { useSettings } from '@/settings/useSettings'
import { ModelPreviewView } from '@/windows/editor/AssetPreviewPane'
import { resolveRenderPrecision } from '@/windows/editor/resolveRenderPrecision'
import { useModelPreview, type ModelPreviewSession } from '@/windows/editor/useModelPreviewSession'
import { getDataPath } from '@/workspace/api'

/** Previews one global model on a stage, with its motions and facials where it has any. */
export default function ModelPreviewDialog({
  modelId,
  name,
  entry,
  description,
  onClose
}: {
  modelId: string
  name: string
  entry: ModelRegistryEntry
  description: string
  onClose: () => void
}): JSX.Element {
  const [dataPath, setDataPath] = useState<string | null>(null)
  const viewportMode: ViewportMode = useViewportMode()
  const compact: boolean = viewportMode === 'phone'

  useEffect((): void => {
    void getDataPath().then(setDataPath)
  }, [])

  return (
    <Dialog
      open
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
            <LoadingMessage />
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
  const layout: ModelLayout = defaultModelLayout(staticPortrait)
  const session: ModelPreviewSession = useModelPreview({
    modelUrl: localAssetUrl(dataPath, `models/${modelId}/${entry.entry}`),
    framing: 'fit',
    staticPortrait,
    anchor: layout.anchor,
    normalScale: layout.normalScale,
    motions: entry.motions,
    facials: entry.facials,
    renderPrecision: resolveRenderPrecision(playback.renderPrecision),
    logContext: { modelId }
  })

  return <ModelPreviewView session={session} compact={compact} fill />
}

function LoadingMessage(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />
      <span>{t('editor.modelPreviewLoading')}</span>
    </div>
  )
}
