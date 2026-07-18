import type { JSX } from 'react'
import { useParams } from 'react-router'
import { EditorRoot } from '@/windows/editor/EditorRoot'
import { useTranslation } from 'react-i18next'

export function MobileEditorPage(): JSX.Element {
  const { t } = useTranslation()
  const params = useParams()
  const projectName: string | undefined = params.projectName

  if (!projectName) {
    return (
      <main className="flex h-full items-center justify-center bg-background p-6 text-center text-sm text-muted-foreground">
        {t('mobile.missingProjectName')}
      </main>
    )
  }

  return <EditorRoot preferredProjectName={projectName} embedInShell />
}
