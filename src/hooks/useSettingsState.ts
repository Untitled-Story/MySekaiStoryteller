import { useEffect, useMemo, useState } from 'react'
import { useSystemTheme } from '@/hooks/useSystemTheme'
import { invoke } from '@tauri-apps/api/core'
import type {
  AppSettings,
  AppearanceSettings,
  PlaybackSettings,
  SystemTheme
} from '@/types/Settings'

export type SettingsHook = {
  loaded: boolean
  appearance: AppearanceSettings & { activeTheme: SystemTheme }
  playback: PlaybackSettings
  workspaceDir: string | null
  setFollowSystem: (follow: boolean) => void
  setManualTheme: (theme: SystemTheme) => void
  setMemorySizeMb: (value: number) => void
  setRenderPrecision: (value: number) => void
  setWorkspaceDir: (dir: string) => void
}

const DEFAULT_PLAYBACK: PlaybackSettings = {
  memorySizeMb: 128,
  renderPrecision: 1.0
}

export function useSettingsState(): SettingsHook {
  const systemTheme = useSystemTheme()

  const [appearance, setAppearance] = useState<AppearanceSettings>(() => ({
    followSystem: true,
    manualTheme: systemTheme
  }))
  const [playback, setPlayback] = useState<PlaybackSettings>(() => ({
    memorySizeMb: DEFAULT_PLAYBACK.memorySizeMb,
    renderPrecision: DEFAULT_PLAYBACK.renderPrecision
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

    invoke<AppSettings | null>('get_settings')
      .then((stored) => {
        if (cancelled || !stored) {
          setLoaded(true)
          return
        }
        setAppearance({
          followSystem: stored.appearance?.followSystem ?? true,
          manualTheme: stored.appearance?.manualTheme ?? systemTheme
        })
        setPlayback({
          memorySizeMb: stored.playback?.memorySizeMb ?? DEFAULT_PLAYBACK.memorySizeMb,
          renderPrecision: stored.playback?.renderPrecision ?? DEFAULT_PLAYBACK.renderPrecision
        })
        setWorkspaceDirState(stored.workspaceDir ?? null)
        setLoaded(true)
      })
      .catch(() => {
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

    invoke('save_settings', { settings: payload }).catch(console.error)
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
    setWorkspaceDir: (dir) => setWorkspaceDirState(dir)
  }
}
