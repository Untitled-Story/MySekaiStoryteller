import type { ChangeEvent, JSX } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ModelSourcePicker, type ModelSource } from '@/components/ModelSourcePicker'
import { Button } from '@/components/ui/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { errorMessage } from '@/lib/errorMessage'
import { importGlobalModel } from '@/modelRegistry/api'
import type { ImportedModelResult } from '@/modelRegistry/schema'

export function ModelImportDialog({
  open,
  onOpenChange,
  onImported
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (result: ImportedModelResult) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [source, setSource] = useState<ModelSource | null>(null)
  const [name, setName] = useState<string>('')
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [error, setError] = useState<string>('')

  useEffect((): void => {
    if (!open) return
    setSource(null)
    setName('')
    setSubmitting(false)
    setError('')
  }, [open])

  async function submit(): Promise<void> {
    if (!source || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const result: ImportedModelResult = await importGlobalModel(
        source.sourcePath,
        name.trim() || undefined,
        source.archiveEntry
      )
      onImported(result)
      onOpenChange(false)
    } catch (submitError: unknown) {
      setError(errorMessage(submitError, t('models.importFailed')))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg min-w-0 select-none overflow-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle>{t('models.importTitle')}</DialogTitle>
          <DialogDescription>{t('models.importDescription')}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <ModelSourcePicker
            value={source}
            disabled={submitting}
            onChange={setSource}
            onError={setError}
          />
          <label className="block min-w-0 text-xs font-medium text-muted-foreground">
            {t('editor.optionalDisplayName')}
            <Input
              value={name}
              disabled={submitting}
              className="mt-2 h-9"
              onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                setName(event.currentTarget.value)
              }
            />
          </label>
          {error && <p className="min-w-0 break-all text-xs leading-5 text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={(): void => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={submitting || !source}
            onClick={(): void => void submit()}
          >
            {submitting ? t('common.processing') : t('models.import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
