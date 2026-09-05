import type { JSX, RefObject } from 'react'
import { useRef, useState } from 'react'
import { FolderOpen, Image as ImageIcon } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import type { BackgroundAsset } from '@/project/assets'
import { projectAssetUrl } from '@/lib/projectAssetUrl'
import { isDesktopRuntime } from '@/lib/platform'
import { describeError, logger } from '@/lib/logger'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useTranslation } from 'react-i18next'

export function BackgroundPreviewDialog({
  open,
  assetKey,
  asset,
  projectPath,
  onOpenChange
}: {
  open: boolean
  assetKey: string | null
  asset: BackgroundAsset | null
  projectPath: string
  onOpenChange: (open: boolean) => void
}): JSX.Element | null {
  const { t } = useTranslation()
  const [loadError, setLoadError] = useState<boolean>(false)
  const returnFocusRef: RefObject<HTMLElement | null> = useRef<HTMLElement | null>(null)

  if (!open || !assetKey || !asset) {
    return null
  }

  const backgroundUrl: string = projectAssetUrl(projectPath, asset.path)
  const displayName: string = asset.name || assetKey

  const handleRevealInDir = async (): Promise<void> => {
    try {
      const normalizedRoot: string = projectPath.replace(/[\\/]+$/, '')
      const normalizedRelative: string = asset.path.replace(/^[\\/]+/, '')
      if (normalizedRelative.split(/[\\/]+/).includes('..')) {
        throw new Error(`资源路径不能包含上级目录: ${asset.path}`)
      }
      const fullPath: string = `${normalizedRoot}/${normalizedRelative}`
      await revealItemInDir(fullPath)
      logger.info('editor.background_revealed_in_dir', { path: fullPath })
    } catch (error: unknown) {
      logger.error('editor.background_reveal_failed', { error: describeError(error) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex flex-col p-4 sm:w-[calc(100%-2rem)] sm:max-w-4xl sm:p-6"
        data-slot="background-preview-dialog"
        onOpenAutoFocus={(): void => {
          const activeElement: Element | null = document.activeElement
          returnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null
        }}
        onCloseAutoFocus={(event: Event): void => {
          event.preventDefault()
          returnFocusRef.current?.focus({ preventScroll: true })
        }}
      >
        <DialogHeader className="mb-2 shrink-0">
          <div className="flex items-center justify-between gap-4 pr-6">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-base font-semibold">{displayName}</DialogTitle>
              <DialogDescription className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {asset.path}
              </DialogDescription>
            </div>
            {isDesktopRuntime() ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5 text-xs"
                onClick={(): void => {
                  void handleRevealInDir()
                }}
              >
                <FolderOpen className="size-3.5" />
                {t('editor.revealInExplorer')}
              </Button>
            ) : null}
          </div>
        </DialogHeader>

        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md border bg-muted/40 p-2">
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
            <div className="relative z-10 flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <ImageIcon className="size-10 stroke-[1.5]" />
              <span className="text-xs">{t('editor.failedToLoadImage')}</span>
            </div>
          ) : (
            <img
              src={backgroundUrl}
              alt={displayName}
              className="relative z-10 max-h-[calc(85dvh-8rem)] max-w-full rounded object-contain shadow-sm"
              onError={(): void => setLoadError(true)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
