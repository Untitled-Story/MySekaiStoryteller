import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/Dialog'
import { Input } from '@renderer/components/ui/Input'
import { Button } from '@renderer/components/ui/Button'

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

export function CreateProjectDialog({ open, onOpenChange, onSuccess }: CreateProjectDialogProps) {
  const [projectName, setProjectName] = useState('')
  const [error, setError] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const handleCreate = async () => {
    if (!projectName.trim()) {
      setError('请输入项目名称')
      return
    }

    setIsCreating(true)
    setError('')

    try {
      const result = await window.projectAPI.createProject(projectName.trim())

      if (result.success) {
        setProjectName('')
        setError('')
        onOpenChange(false)
        onSuccess()
      } else {
        setError(result.error || '创建项目失败')
      }
    } catch (err) {
      setError('创建项目时发生错误')
      console.error('Failed to create project:', err)
    } finally {
      setIsCreating(false)
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!isCreating) {
      if (!newOpen) {
        setProjectName('')
        setError('')
      }
      onOpenChange(newOpen)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="select-none">
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
          <DialogDescription>为您的新项目输入一个名称</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!isCreating) setTimeout(() => handleCreate())
          }}
        >
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Input
                placeholder="项目名称"
                value={projectName}
                onChange={(e) => {
                  setProjectName(e.target.value)
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
