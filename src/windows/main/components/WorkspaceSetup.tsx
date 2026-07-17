import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Button } from '@/components/ui/Button'
import { getDefaultWorkspaceDir } from '@/workspace/api'
import { FolderOpen } from 'lucide-react'
import logo from '@/assets/logo.png'
import { useTranslation } from 'react-i18next'
import { isMobileRuntime } from '@/lib/platform'


interface WorkspaceSetupProps {
  onConfirm: (dir: string) => void
}

export function WorkspaceSetup({ onConfirm }: WorkspaceSetupProps): JSX.Element {
  const { t } = useTranslation()
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [defaultDir, setDefaultDir] = useState<string | null>(null)
  const mobileRuntime: boolean = isMobileRuntime()

  useEffect(() => {
    getDefaultWorkspaceDir()
      .then(setDefaultDir)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!mobileRuntime || !defaultDir || selectedDir) return
    // Mobile first-run: auto-accept app private storage for a stable default workspace.
    onConfirm(defaultDir)
  }, [defaultDir, mobileRuntime, onConfirm, selectedDir])

  const handleSelectDir = async (): Promise<void> => {

    const selected = await open({
      title: t('workspace.choose'),
      directory: true,
      multiple: false
    })

    if (typeof selected === 'string') {
      setSelectedDir(selected)
    }
  }

  const displayDir = selectedDir ?? defaultDir

  if (mobileRuntime && !selectedDir) {
    return (
      <div className="fixed inset-0 z-50 flex select-none flex-col items-center justify-center bg-background px-6">
        <img src={logo} draggable={false} alt="Logo" className="mb-6 h-16 w-16 object-contain" />
        <h1 className="mb-2 text-center text-2xl font-semibold">正在准备工作区</h1>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          移动端默认使用应用私有目录保存项目数据
        </p>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex select-none flex-col items-center justify-center bg-background px-4">
      <img src={logo} draggable={false} alt="Logo" className="mb-6 h-16 w-16 object-contain" />
      <h1 className="mb-2 text-center text-2xl font-semibold">{t('workspace.welcome')}</h1>
      <p className="mb-8 max-w-lg text-center text-sm text-muted-foreground">
        {t('workspace.description')}

        <br />
        {t('workspace.recommendation')}
      </p>

      <div className="flex w-full max-w-md flex-col items-center gap-3">
        {displayDir && (
          <p className="w-full truncate rounded-md bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
            {displayDir}
          </p>
        )}

        <div className="flex w-full flex-col gap-2 sm:flex-row">
          <Button variant="outline" className="h-11 flex-1 text-sm" onClick={handleSelectDir}>
            <FolderOpen className="mr-1.5 h-4 w-4" />
            {t('workspace.custom')}

          </Button>
          <Button
            className="h-11 flex-1 text-sm"
            disabled={!displayDir}
            onClick={() => displayDir && onConfirm(displayDir)}
          >
            {selectedDir ? t('workspace.confirm') : t('workspace.default')}
          </Button>
        </div>
      </div>
    </div>
  )
}
