import type { JSX } from 'react'
import { useParams } from 'react-router'
import PlayerApp from '@/windows/player/App'

export function MobilePlayerPage(): JSX.Element {
  const params = useParams()
  const projectName: string | undefined = params.projectName
  const decoded: string | null = projectName ? safeDecode(projectName) : null

  if (!decoded) {
    return (
      <main className="flex h-full items-center justify-center bg-black p-6 text-center text-sm text-white/70">
        缺少项目名称
      </main>
    )
  }

  return <PlayerApp preferredProjectName={decoded} />
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
