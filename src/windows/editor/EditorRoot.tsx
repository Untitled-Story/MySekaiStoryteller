import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Agentation } from 'agentation'
import { HashRouter } from 'react-router'
import { describeError, logger } from '@/lib/logger'
import { getSettings } from '@/settings/api'
import type { AppSettings, SystemTheme } from '@/settings/types'
import { useSystemTheme } from '@/settings/useSystemTheme'
import App from './App'

export function EditorRoot(): JSX.Element {
  const systemTheme: SystemTheme = useSystemTheme()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const activeTheme: SystemTheme =
    settings?.appearance.followSystem === false ? settings.appearance.manualTheme : systemTheme

  useEffect((): (() => void) => {
    let cancelled = false

    function refreshSettings(): void {
      void getSettings()
        .then((nextSettings: AppSettings | null): void => {
          if (!cancelled) setSettings(nextSettings)
        })
        .catch((error: unknown): void => {
          logger.warn('editor.theme_load_failed', { error: describeError(error) })
        })
    }

    refreshSettings()
    window.addEventListener('focus', refreshSettings)

    return (): void => {
      cancelled = true
      window.removeEventListener('focus', refreshSettings)
    }
  }, [])

  useEffect((): void => {
    const root: HTMLElement = document.documentElement
    root.classList.toggle('dark', activeTheme === 'dark')
    root.style.colorScheme = activeTheme
  }, [activeTheme])

  return (
    <HashRouter>
      <App />
      {import.meta.env.DEV && <Agentation />}
    </HashRouter>
  )
}
