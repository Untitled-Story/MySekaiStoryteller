import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/Button'
import { FolderOpen } from 'lucide-react'
import logo from '@/assets/logo.png'

interface WorkspaceSetupProps {
  onConfirm: (dir: string) => void
}

export function WorkspaceSetup({ onConfirm }: WorkspaceSetupProps): JSX.Element {
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [defaultDir, setDefaultDir] = useState<string | null>(null)

  useEffect(() => {
    invoke<string>('get_default_workspace_dir')
      .then(setDefaultDir)
      .catch(() => {})
  }, [])

  const handleSelectDir = async () => {
    const selected = await open({
      title: '选择数据保存路径',
      directory: true,
      multiple: false
    })

    if (typeof selected === 'string') {
      setSelectedDir(selected)
    }
  }

  const displayDir = selectedDir ?? defaultDir

  return (
    <div className="fixed inset-0 bg-background flex flex-col items-center justify-center select-none z-50">
      <img src={logo} draggable={false} alt="Logo" className="w-16 h-16 object-contain mb-6" />
      <h1 className="text-2xl font-semibold mb-2">欢迎使用 MySekaiStoryteller</h1>
      <p className="text-sm text-muted-foreground mb-8 text-center max-w-lg">
        请选择一个文件夹来保存项目数据（模型、音频、剧情文件等）
        <br />
        建议选择空间充足的磁盘
      </p>

      <div className="flex flex-col items-center gap-3 w-full max-w-md">
        {displayDir && (
          <p className="text-xs text-muted-foreground bg-muted px-3 py-2 rounded-md w-full truncate text-center">
            {displayDir}
          </p>
        )}

        <div className="flex gap-2 w-full">
          <Button variant="outline" className="flex-1 h-10 text-sm" onClick={handleSelectDir}>
            <FolderOpen className="w-4 h-4 mr-1.5" />
            自定义路径
          </Button>
          <Button
            className="flex-1 h-10 text-sm"
            disabled={!displayDir}
            onClick={() => displayDir && onConfirm(displayDir)}
          >
            {selectedDir ? '确认并开始' : '使用默认路径'}
          </Button>
        </div>
      </div>
    </div>
  )
}
