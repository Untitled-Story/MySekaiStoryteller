import type { JSX } from 'react'
import { useState } from 'react'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { FileArchive, FileJson } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import { errorMessage } from '@/lib/errorMessage'
import { isMobileRuntime } from '@/lib/platform'
import { cn } from '@/lib/style'
import { inspectModelArchive } from '@/modelRegistry/api'
import { isStaticModelEntry } from '@/modelRegistry/isStaticModelEntry'
import type { ModelArchiveCandidate } from '@/modelRegistry/schema'

export type ModelSource = {
  sourcePath: string
  archiveEntry: string | undefined
}

/**
 * Picks the file a global model is imported from: a Live2D entry JSON, a ZIP holding a model
 * directory, or a static portrait image. A ZIP without exactly one recognized entry asks which
 * entry to use.
 */
export function ModelSourcePicker({
  value,
  disabled,
  onChange,
  onError
}: {
  value: ModelSource | null
  disabled: boolean
  onChange: (value: ModelSource | null) => void
  onError: (message: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const mobileRuntime: boolean = isMobileRuntime()
  const [pendingArchivePath, setPendingArchivePath] = useState<string>('')
  const [archiveCandidates, setArchiveCandidates] = useState<readonly ModelArchiveCandidate[]>([])
  const [selectedArchiveEntry, setSelectedArchiveEntry] = useState<string>('')
  const [archiveSelectionOpen, setArchiveSelectionOpen] = useState<boolean>(false)
  const [inspectingArchive, setInspectingArchive] = useState<boolean>(false)

  async function chooseModelEntry(): Promise<void> {
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      title: t('editor.chooseLive2dEntry'),
      filters: [
        {
          name: t('editor.live2dModel'),
          extensions: mobileRuntime ? ['zip'] : ['json', 'zip']
        },
        {
          name: t('editor.staticPortrait'),
          extensions: ['png', 'jpg', 'jpeg', 'webp']
        }
      ]
    })
    if (typeof selected !== 'string') return

    onError('')
    const isZip: boolean = selected.toLocaleLowerCase().endsWith('.zip')
    if (isStaticModelEntry(selected) || (!mobileRuntime && !isZip)) {
      onChange({ sourcePath: selected, archiveEntry: undefined })
      return
    }

    onChange(null)
    setInspectingArchive(true)
    try {
      const inspection = await inspectModelArchive(selected)
      const recognized: ModelArchiveCandidate[] = inspection.candidates.filter(
        (candidate: ModelArchiveCandidate): boolean => candidate.recognized
      )
      if (recognized.length === 1) {
        onChange({ sourcePath: selected, archiveEntry: recognized[0].path })
        return
      }

      const firstCandidate: ModelArchiveCandidate | undefined =
        recognized[0] ?? inspection.candidates[0]
      if (!firstCandidate) {
        onError(t('editor.noJsonEntry'))
        return
      }

      setPendingArchivePath(selected)
      setArchiveCandidates(recognized.length > 1 ? recognized : inspection.candidates)
      setSelectedArchiveEntry(firstCandidate.path)
      setArchiveSelectionOpen(true)
    } catch (inspectionError: unknown) {
      if (mobileRuntime && !isZip) {
        // A picked content URI carries no file extension, so it may be an image rather than a ZIP.
        // The import command identifies the file by content and reports a precise error otherwise.
        onChange({ sourcePath: selected, archiveEntry: undefined })
        return
      }
      onError(errorMessage(inspectionError, t('editor.inspectModelZipFailed')))
    } finally {
      setInspectingArchive(false)
    }
  }

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-dashed p-4">
      <p className="text-sm font-medium">{t('editor.chooseModelSource')}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {mobileRuntime ? t('editor.mobileModelZipHint') : t('editor.desktopModelHint')}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        disabled={disabled || inspectingArchive}
        onClick={(): void => void chooseModelEntry()}
      >
        {inspectingArchive ? t('editor.inspectingZip') : t('common.chooseFile')}
      </Button>
      {value && (
        <p
          className="mt-3 block w-full min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-muted-foreground"
          title={value.sourcePath}
        >
          {fileNameFromPath(value.sourcePath)}
          {value.archiveEntry ? ` · ${value.archiveEntry}` : ''}
        </p>
      )}

      <Dialog open={archiveSelectionOpen} onOpenChange={setArchiveSelectionOpen}>
        <DialogContent className="max-w-xl min-w-0 overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t('editor.chooseZipEntry')}</DialogTitle>
            <DialogDescription>
              {archiveCandidates.some(
                (candidate: ModelArchiveCandidate): boolean => candidate.recognized
              )
                ? t('editor.chooseRecognizedEntry')
                : t('editor.chooseJsonEntry')}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-1 overflow-y-auto rounded-md border bg-muted/15 p-1.5 scrollbar-thin scrollbar-thumb-muted-foreground/25 scrollbar-track-transparent">
            {archiveCandidates.map(
              (candidate: ModelArchiveCandidate): JSX.Element => (
                <button
                  key={candidate.path}
                  type="button"
                  className={cn(
                    'flex w-full min-w-0 items-center gap-3 rounded-sm px-3 py-2 text-left transition-colors',
                    selectedArchiveEntry === candidate.path
                      ? 'bg-emerald-500/10 ring-1 ring-emerald-500/40'
                      : 'hover:bg-accent'
                  )}
                  onClick={(): void => setSelectedArchiveEntry(candidate.path)}
                >
                  {candidate.recognized ? (
                    <FileArchive className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <FileJson className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  )}
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs"
                    title={candidate.path}
                  >
                    {candidate.path}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded-sm px-1.5 py-0.5 text-[10px]',
                      candidate.recognized
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                    )}
                  >
                    {candidate.recognized ? t('editor.recognized') : t('editor.plainJson')}
                  </span>
                </button>
              )
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={(): void => setArchiveSelectionOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={!selectedArchiveEntry}
              onClick={(): void => {
                onChange({ sourcePath: pendingArchivePath, archiveEntry: selectedArchiveEntry })
                setArchiveSelectionOpen(false)
              }}
            >
              {t('editor.useEntry')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
