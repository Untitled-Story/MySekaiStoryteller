import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Button } from '@/components/ui/Button'
import { getDefaultWorkspaceDir } from '@/workspace/api'
import { FolderOpen } from 'lucide-react'
import logo from '@/assets/logo.png'
import { useTranslation } from 'react-i18next'

interface WorkspaceSetupProps {
  onConfirm: (dir: string) => void
}

export function WorkspaceSetup({ onConfirm }: WorkspaceSetupProps): JSX.Element {
  const { t } = useTranslation()
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [defaultDir, setDefaultDir] = useState<string | null>(null)

  useEffect(() => {
    getDefaultWorkspaceDir()
      .then(setDefaultDir)
      .catch(() => {})
  }, [])

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

  return (
    <div className="fixed inset-0 bg-background flex flex-col items-center justify-center select-none z-50">
      <img src={logo} draggable={false} alt="Logo" className="w-16 h-16 object-contain mb-6" />
      <h1 className="text-2xl font-semibold mb-2">{t('workspace.welcome')}</h1>
      <p className="text-sm text-muted-foreground mb-8 text-center max-w-lg">
        {t('workspace.description')}
        <br />
        {t('workspace.recommendation')}
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
            {t('workspace.custom')}
          </Button>
          <Button
            className="flex-1 h-10 text-sm"
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
