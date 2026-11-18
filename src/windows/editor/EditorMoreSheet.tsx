import type { JSX, ReactNode } from 'react'
import { LoaderCircle, Package, Save } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/Dialog'
import { cn } from '@/lib/style'

/** Phone header overflow: the low-frequency save and export actions, plus the save error. */
export function EditorMoreSheet({
  open,
  onOpenChange,
  saveLabel,
  saveFailed,
  canSave,
  onSave,
  exporting,
  canExport,
  onExport,
  error
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  saveLabel: string
  saveFailed: boolean
  canSave: boolean
  onSave: () => void
  exporting: boolean
  canExport: boolean
  onExport: () => void
  error: string | null
}): JSX.Element {
  const { t } = useTranslation()

  function run(action: () => void): void {
    onOpenChange(false)
    action()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="gap-2 p-3">
        <DialogTitle className="px-3 pt-1 text-sm">{t('common.moreActions')}</DialogTitle>
        {error ? (
          <DialogDescription className="px-3 text-xs text-destructive">{error}</DialogDescription>
        ) : (
          <DialogDescription className="sr-only">{t('common.moreActions')}</DialogDescription>
        )}
        <SheetAction
          icon={<Save className="size-4" />}
          label={saveLabel}
          destructive={saveFailed}
          disabled={!canSave}
          onClick={(): void => run(onSave)}
        />
        <SheetAction
          icon={
            exporting ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Package className="size-4" />
            )
          }
          label={t('projectArchive.export')}
          disabled={!canExport}
          onClick={(): void => run(onExport)}
        />
      </DialogContent>
    </Dialog>
  )
}

function SheetAction({
  icon,
  label,
  destructive = false,
  disabled,
  onClick
}: {
  icon: ReactNode
  label: string
  destructive?: boolean
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-accent disabled:opacity-50',
        destructive && 'text-destructive'
      )}
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}
