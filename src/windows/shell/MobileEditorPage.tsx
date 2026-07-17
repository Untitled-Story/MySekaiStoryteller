import type { JSX } from 'react'
import { useParams } from 'react-router'
import { EditorRoot } from '@/windows/editor/EditorRoot'

export function MobileEditorPage(): JSX.Element {
  const params = useParams()
  const projectName: string | undefined = params.projectName
  const decoded: string | null = projectName ? safeDecode(projectName) : null

  if (!decoded) {
    return (
      <main className="flex h-full items-center justify-center bg-background p-6 text-center text-sm text-muted-foreground">
        缺少项目名称
      </main>
    )
  }

  return <EditorRoot preferredProjectName={decoded} embedInShell />
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
