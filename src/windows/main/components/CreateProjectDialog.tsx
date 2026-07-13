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
      setError('请输入项目名称')
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
      setError('创建项目时发生错误')
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
          <DialogTitle>新建项目</DialogTitle>
          <DialogDescription>为您的新项目输入一个名称</DialogDescription>
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
                placeholder="项目名称"
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
            取消
          </Button>
          <Button onClick={handleCreate} disabled={isCreating}>
            {isCreating ? '创建中...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
