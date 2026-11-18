import type { JSX } from 'react'
import { LoaderCircle, Package, Save } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ActionSheet } from './ActionSheet'

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

  return (
    <ActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('common.moreActions')}
      description={error ? <span className="text-destructive">{error}</span> : undefined}
      groups={[
        [
          {
            key: 'save',
            icon: <Save />,
            label: saveLabel,
            destructive: saveFailed,
            disabled: !canSave,
            onSelect: onSave
          },
          {
            key: 'export',
            icon: exporting ? <LoaderCircle className="animate-spin" /> : <Package />,
            label: t('projectArchive.export'),
            disabled: !canExport,
            onSelect: onExport
          }
        ]
      ]}
    />
  )
}
