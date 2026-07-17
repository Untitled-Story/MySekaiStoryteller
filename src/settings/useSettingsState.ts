import { useEffect, useMemo, useState } from 'react'
import { getSettings, saveSettings } from './api'
import { useSystemTheme } from './useSystemTheme'
import type {
  AppSettings,
  AppLanguage,
  AppearanceSettings,
  PlaybackFontSettings,
  PlaybackSettings,
  RenderPrecision,
  ShortcutSettings,
  SystemTheme
} from './types'
import type { OnboardingSettings } from '@/onboarding/types'
import { DEFAULT_ONBOARDING, normalizeOnboardingSettings } from '@/onboarding/types'
import { defaultPlaybackFont, normalizePlaybackFont } from './fonts'
import { defaultShortcutSettings, normalizeShortcutSettings } from './shortcuts'
import { describeError, logger } from '@/lib/logger'
import { listen, type Event as TauriEvent } from '@tauri-apps/api/event'
import { applyAppLanguage, normalizeAppLanguage } from '@/i18n'

export type SettingsHook = {
  loaded: boolean
  language: AppLanguage
  appearance: AppearanceSettings & { activeTheme: SystemTheme }
  playback: PlaybackSettings
  shortcuts: ShortcutSettings
  onboarding: OnboardingSettings
  workspaceDir: string | null
  setLanguage: (language: AppLanguage) => void
  setFollowSystem: (follow: boolean) => void
  setManualTheme: (theme: SystemTheme) => void
  setMemorySizeMb: (value: number) => void
  setRenderPrecision: (value: RenderPrecision) => void
  setPlaybackFont: (value: PlaybackFontSettings) => void
  setShortcuts: (value: ShortcutSettings) => void
  setOnboarding: (value: OnboardingSettings) => void
  setWorkspaceDir: (dir: string) => void
}

const DEFAULT_PLAYBACK: PlaybackSettings = {
  memorySizeMb: 128,
  renderPrecision: 'Auto',
  font: defaultPlaybackFont()
}

export function useSettingsState(): SettingsHook {
  const systemTheme = useSystemTheme()
  const [language, setLanguage] = useState<AppLanguage>('system')

  const [appearance, setAppearance] = useState<AppearanceSettings>(() => ({
    followSystem: true,
    manualTheme: systemTheme
  }))
  const [playback, setPlayback] = useState<PlaybackSettings>(() => ({
    memorySizeMb: DEFAULT_PLAYBACK.memorySizeMb,
    renderPrecision: DEFAULT_PLAYBACK.renderPrecision,
    font: DEFAULT_PLAYBACK.font
  }))
  const [workspaceDir, setWorkspaceDirState] = useState<string | null>(null)
  const [shortcuts, setShortcuts] = useState<ShortcutSettings>(defaultShortcutSettings)
  const [onboarding, setOnboarding] = useState<OnboardingSettings>(DEFAULT_ONBOARDING)
  const [loaded, setLoaded] = useState(false)
  const [persistenceReady, setPersistenceReady] = useState(false)

  const activeTheme = useMemo<SystemTheme>(
    () => (appearance.followSystem ? systemTheme : appearance.manualTheme),
    [appearance.followSystem, appearance.manualTheme, systemTheme]
  )

  // Load settings from backend on mount
  useEffect(() => {
    let cancelled = false
    const startedAt: number = performance.now()
    logger.info('settings.load_started')

    getSettings()
      .then((stored: AppSettings | null): void => {
        if (cancelled) return

        if (!stored) {
          logger.info('settings.load_completed', {
            durationMs: Math.round(performance.now() - startedAt),
            found: false
          })
          setPersistenceReady(true)
          setLoaded(true)
          return
        }
        setAppearance({
          followSystem: stored.appearance?.followSystem ?? true,
          manualTheme: stored.appearance?.manualTheme ?? systemTheme
        })
        setLanguage(normalizeAppLanguage(stored.language))
        setPlayback({
          memorySizeMb: stored.playback?.memorySizeMb ?? DEFAULT_PLAYBACK.memorySizeMb,
          renderPrecision: normalizeRenderPrecision(stored.playback?.renderPrecision),
          font: normalizePlaybackFont(stored.playback?.font)
        })
        setShortcuts(normalizeShortcutSettings(stored.shortcuts))
        setOnboarding(normalizeOnboardingSettings(stored.onboarding))
        setWorkspaceDirState(stored.workspaceDir ?? null)
        setPersistenceReady(true)
        setLoaded(true)
        logger.info('settings.load_completed', {
          durationMs: Math.round(performance.now() - startedAt),
          found: true,
          hasWorkspace: Boolean(stored.workspaceDir)
        })
      })
      .catch((error: unknown): void => {
        if (cancelled) return
        logger.error('settings.load_failed', {
          durationMs: Math.round(performance.now() - startedAt),
          error: describeError(error)
        })
        setLoaded(true)
      })

    return () => {
      cancelled = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect((): (() => void) => {
    let disposed: boolean = false
    let unlisten: (() => void) | null = null

    void listen<AppSettings>('settings-changed', (event: TauriEvent<AppSettings>): void => {
      if (disposed) return
      const nextOnboarding: OnboardingSettings = normalizeOnboardingSettings(
        event.payload.onboarding
      )
      setLanguage(normalizeAppLanguage(event.payload.language))
      setOnboarding((current: OnboardingSettings): OnboardingSettings => {
        if (
          current.mainTourVersion === nextOnboarding.mainTourVersion &&
          current.editorTourVersion === nextOnboarding.editorTourVersion
        ) {
          return current
        }
        return nextOnboarding
      })
    }).then((dispose: () => void): void => {
      if (disposed) dispose()
      else unlisten = dispose
    })

    return (): void => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect((): void => {
    applyAppLanguage(language)
  }, [language])

  // Save settings when they change
  useEffect(() => {
    if (!loaded || !persistenceReady) return

    const payload: AppSettings = {
      language,
      appearance: {
        followSystem: appearance.followSystem,
        manualTheme: appearance.manualTheme
      },
      playback,
      shortcuts,
      onboarding,
      workspaceDir: workspaceDir ?? undefined
    }

    saveSettings(payload).catch((error: unknown): void => {
      logger.error('settings.save_failed', { error: describeError(error) })
    })
  }, [
    appearance.followSystem,
    appearance.manualTheme,
    playback,
    shortcuts,
    onboarding,
    workspaceDir,
    loaded,
    persistenceReady,
    language
  ])

  return {
    loaded,
    language,
    appearance: { ...appearance, activeTheme },
    playback,
    shortcuts,
    onboarding,
    workspaceDir,
    setLanguage,
    setFollowSystem: (follow) =>
      setAppearance((prev) => ({
        ...prev,
        followSystem: follow
      })),
    setManualTheme: (theme) =>
      setAppearance((prev) => ({
        ...prev,
        manualTheme: theme
      })),
    setMemorySizeMb: (value) =>
      setPlayback((prev) => ({
        ...prev,
        memorySizeMb: value
      })),
    setRenderPrecision: (value) =>
      setPlayback((prev) => ({
        ...prev,
        renderPrecision: value
      })),
    setPlaybackFont: (value) =>
      setPlayback((prev) => ({
        ...prev,
        font: normalizePlaybackFont(value)
      })),
    setShortcuts: (value) => setShortcuts(normalizeShortcutSettings(value)),
    setOnboarding: (value) => setOnboarding(normalizeOnboardingSettings(value)),
    setWorkspaceDir: (dir) => setWorkspaceDirState(dir)
  }
}

function normalizeRenderPrecision(value: RenderPrecision | undefined): RenderPrecision {
  if (value === 'Auto') return value
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  return DEFAULT_PLAYBACK.renderPrecision
}
