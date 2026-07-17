import type { ChangeEvent, FormEvent, JSX } from 'react'
import { useEffect, useState } from 'react'
import { createProject } from '@/project/api'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useTranslation } from 'react-i18next'

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (projectName: string) => void
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onSuccess
}: CreateProjectDialogProps): JSX.Element | null {
  const { t } = useTranslation()
  const [projectName, setProjectName] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [isCreating, setIsCreating] = useState<boolean>(false)
  const [mounted, setMounted] = useState<boolean>(false)

  useEffect((): void => {
    setMounted(true)
  }, [])

  const handleCreate = async (): Promise<void> => {
    const normalizedProjectName: string = projectName.trim()
    if (!normalizedProjectName) {
      setError(t('project.nameRequired'))
      return
    }
    setIsCreating(true)
    setError('')
    try {
      await createProject(normalizedProjectName)
      setProjectName('')
      setError('')
      onOpenChange(false)
      onSuccess(normalizedProjectName)
    } catch (err: unknown) {
      setError(t('project.createFailed'))
      console.error('Failed to create project:', err)
    } finally {
      setIsCreating(false)
    }
  }

  const handleOpenChange = (newOpen: boolean): void => {
    if (!isCreating) {
      if (!newOpen) {
        setProjectName('')
        setError('')
      }
      onOpenChange(newOpen)
    }
  }

  if (!mounted) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="select-none">
        <DialogHeader>
          <DialogTitle>{t('project.new')}</DialogTitle>
          <DialogDescription>{t('project.namePrompt')}</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event: FormEvent<HTMLFormElement>): void => {
            event.preventDefault()
            if (!isCreating) window.setTimeout((): void => void handleCreate())
          }}
        >
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Input
                placeholder={t('project.namePlaceholder')}
                value={projectName}
                onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                  setProjectName(event.currentTarget.value)
                  setError('')
                }}
                disabled={isCreating}
                autoFocus
              />
              {error && <p className="text-sm text-red-500">{error}</p>}
            </div>
          </div>
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isCreating}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={isCreating}>
            {isCreating ? t('common.creating') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
