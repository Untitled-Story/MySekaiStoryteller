import { useEffect, useMemo, useState } from 'react'
import { getSettings, saveSettings } from './api'
import { useSystemTheme } from './useSystemTheme'
import type {
  AppSettings,
  AppearanceSettings,
  PlaybackFontSettings,
  PlaybackSettings,
  RenderPrecision,
  SystemTheme
} from './types'
import { defaultPlaybackFont, normalizePlaybackFont } from './fonts'
import { describeError, logger } from '@/lib/logger'

export type SettingsHook = {
  loaded: boolean
  appearance: AppearanceSettings & { activeTheme: SystemTheme }
  playback: PlaybackSettings
  workspaceDir: string | null
  setFollowSystem: (follow: boolean) => void
  setManualTheme: (theme: SystemTheme) => void
  setMemorySizeMb: (value: number) => void
  setRenderPrecision: (value: RenderPrecision) => void
  setPlaybackFont: (value: PlaybackFontSettings) => void
  setWorkspaceDir: (dir: string) => void
}

const DEFAULT_PLAYBACK: PlaybackSettings = {
  memorySizeMb: 128,
  renderPrecision: 'Auto',
  font: defaultPlaybackFont()
}

export function useSettingsState(): SettingsHook {
  const systemTheme = useSystemTheme()

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
  const [loaded, setLoaded] = useState(false)

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
        if (cancelled || !stored) {
          if (!cancelled) {
            logger.info('settings.load_completed', {
              durationMs: Math.round(performance.now() - startedAt),
              found: false
            })
          }
          setLoaded(true)
          return
        }
        setAppearance({
          followSystem: stored.appearance?.followSystem ?? true,
          manualTheme: stored.appearance?.manualTheme ?? systemTheme
        })
        setPlayback({
          memorySizeMb: stored.playback?.memorySizeMb ?? DEFAULT_PLAYBACK.memorySizeMb,
          renderPrecision: normalizeRenderPrecision(stored.playback?.renderPrecision),
          font: normalizePlaybackFont(stored.playback?.font)
        })
        setWorkspaceDirState(stored.workspaceDir ?? null)
        setLoaded(true)
        logger.info('settings.load_completed', {
          durationMs: Math.round(performance.now() - startedAt),
          found: true,
          hasWorkspace: Boolean(stored.workspaceDir)
        })
      })
      .catch((error: unknown): void => {
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

  // Save settings when they change
  useEffect(() => {
    if (!loaded) return

    const payload: AppSettings = {
      appearance: {
        followSystem: appearance.followSystem,
        manualTheme: appearance.manualTheme
      },
      playback,
      workspaceDir: workspaceDir ?? undefined
    }

    saveSettings(payload).catch((error: unknown): void => {
      logger.error('settings.save_failed', { error: describeError(error) })
    })
  }, [appearance.followSystem, appearance.manualTheme, playback, workspaceDir, loaded])

  return {
    loaded,
    appearance: { ...appearance, activeTheme },
    playback,
    workspaceDir,
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
    setWorkspaceDir: (dir) => setWorkspaceDirState(dir)
  }
}

function normalizeRenderPrecision(value: RenderPrecision | undefined): RenderPrecision {
  if (value === 'Auto') return value
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  return DEFAULT_PLAYBACK.renderPrecision
}
