import type { JSX } from 'react'
import { useParams } from 'react-router'
import PlayerApp from '@/windows/player/App'
import { useTranslation } from 'react-i18next'

export function MobilePlayerPage(): JSX.Element {
  const { t } = useTranslation()
  const params = useParams()
  const projectName: string | undefined = params.projectName

  if (!projectName) {
    return (
      <main className="flex h-full items-center justify-center bg-black p-6 text-center text-sm text-white/70">
        {t('mobile.missingProjectName')}
      </main>
    )
  }

  return <PlayerApp preferredProjectName={projectName} />
}
