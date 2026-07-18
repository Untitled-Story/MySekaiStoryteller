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
import { applyAppLanguage } from '@/i18n'

export function EditorRoot({
  preferredProjectName = null,
  embedInShell = false
}: {
  preferredProjectName?: string | null
  embedInShell?: boolean
} = {}): JSX.Element {
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

  useEffect((): void => {
    applyAppLanguage(settings?.language ?? 'system')
  }, [settings?.language])

  const completeEditorTour = useCallback((): void => {
    void getSettings()
      .then(async (stored: AppSettings | null): Promise<void> => {
        if (!stored) return
        const nextSettings: AppSettings = {
          ...stored,
          onboarding: {
            ...normalizeOnboardingSettings(stored.onboarding),
            editorTourVersion: EDITOR_TOUR_VERSION
          },
          interaction: {
            touchMode: stored.interaction?.touchMode ?? false,
            touchModePromptSeen: stored.interaction?.touchModePromptSeen ?? false
          }
        }
        setSettings(nextSettings)
        await saveSettings(nextSettings)
      })
      .catch((error: unknown): void => {
        logger.warn('editor.tour_completion_save_failed', { error: describeError(error) })
      })
  }, [])

  const editorApp: JSX.Element = (
    <>
      <App
        settings={settings}
        onCompleteEditorTour={completeEditorTour}
        preferredProjectName={preferredProjectName}
        embedInShell={embedInShell}
      />
      {import.meta.env.DEV && !embedInShell && <Agentation />}
    </>
  )

  if (embedInShell) {
    return editorApp
  }

  return <HashRouter>{editorApp}</HashRouter>
}
