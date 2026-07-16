import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Agentation } from 'agentation'
import { HashRouter } from 'react-router'
import { listen, type Event as TauriEvent } from '@tauri-apps/api/event'
import { describeError, logger } from '@/lib/logger'
import { getSettings, saveSettings } from '@/settings/api'
import type { AppSettings, SystemTheme } from '@/settings/types'
import { useSystemTheme } from '@/settings/useSystemTheme'
import App from './App'
import { EDITOR_TOUR_VERSION, normalizeOnboardingSettings } from '@/onboarding/types'

export function EditorRoot(): JSX.Element {
  const systemTheme: SystemTheme = useSystemTheme()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const activeTheme: SystemTheme =
    settings?.appearance.followSystem === false ? settings.appearance.manualTheme : systemTheme

  useEffect((): (() => void) => {
    let cancelled = false
    let unlisten: (() => void) | null = null

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
    void listen<AppSettings>('settings-changed', (event: TauriEvent<AppSettings>): void => {
      if (!cancelled) setSettings(event.payload)
    }).then((dispose: () => void): void => {
      if (cancelled) dispose()
      else unlisten = dispose
    })

    return (): void => {
      cancelled = true
      unlisten?.()
      window.removeEventListener('focus', refreshSettings)
    }
  }, [])

  useEffect((): void => {
    const root: HTMLElement = document.documentElement
    root.classList.toggle('dark', activeTheme === 'dark')
    root.style.colorScheme = activeTheme
  }, [activeTheme])

  const completeEditorTour = useCallback((): void => {
    void getSettings()
      .then(async (stored: AppSettings | null): Promise<void> => {
        if (!stored) return
        const nextSettings: AppSettings = {
          ...stored,
          onboarding: {
            ...normalizeOnboardingSettings(stored.onboarding),
            editorTourVersion: EDITOR_TOUR_VERSION
          }
        }
        setSettings(nextSettings)
        await saveSettings(nextSettings)
      })
      .catch((error: unknown): void => {
        logger.warn('editor.tour_completion_save_failed', { error: describeError(error) })
      })
  }, [])

  return (
    <HashRouter>
      <App settings={settings} onCompleteEditorTour={completeEditorTour} />
      {import.meta.env.DEV && <Agentation />}
    </HashRouter>
  )
}
