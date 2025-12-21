import { useEffect, useMemo, useRef, useState } from 'react'
import { useSystemTheme } from '@renderer/hooks/useSystemTheme'
import type {
  AppSettings,
  AppearanceSettings,
  PlaybackSettings,
  SystemTheme
} from '@common/types/Settings'

export type SettingsHook = {
  appearance: AppearanceSettings & { activeTheme: SystemTheme }
  playback: PlaybackSettings
  setFollowSystem: (follow: boolean) => void
  setManualTheme: (theme: SystemTheme) => void
  setMemorySizeMb: (value: number) => void
  setRenderPrecision: (value: number) => void
}

const DEFAULT_PLAYBACK: PlaybackSettings = {
  memorySizeMb: 128,
  renderPrecision: 1.0
}

export function useSettingsState(): SettingsHook {
  const systemTheme = useSystemTheme()
  const initial =
    typeof window !== 'undefined' ? (window.settingsAPI?.initialSettings ?? null) : null

  const [appearance, setAppearance] = useState<AppearanceSettings>(() => ({
    followSystem: initial?.appearance?.followSystem ?? true,
    manualTheme: initial?.appearance?.manualTheme ?? systemTheme
  }))
  const [playback, setPlayback] = useState<PlaybackSettings>(() => ({
    memorySizeMb: initial?.playback?.memorySizeMb ?? DEFAULT_PLAYBACK.memorySizeMb,
    renderPrecision: initial?.playback?.renderPrecision ?? DEFAULT_PLAYBACK.renderPrecision
  }))
  const [loaded, setLoaded] = useState(false)

  const activeTheme = useMemo<SystemTheme>(
    () => (appearance.followSystem ? systemTheme : appearance.manualTheme),
    [appearance.followSystem, appearance.manualTheme, systemTheme]
  )

  const saveModeRef = useRef<'local' | 'external'>('local')

  useEffect(() => {
    if (typeof window === 'undefined') return
    const api = window.settingsAPI
    let cancelled = false

    const load = async (): Promise<void> => {
      if (!api) {
        setLoaded(true)
        return
      }
      try {
        const stored = await api.getSettings()
        if (cancelled || !stored) {
          setLoaded(true)
          return
        }
        saveModeRef.current = 'external'
        setAppearance((prev) => ({
          followSystem:
            typeof stored.appearance?.followSystem === 'boolean'
              ? stored.appearance.followSystem
              : prev.followSystem,
          manualTheme: stored.appearance?.manualTheme ?? prev.manualTheme
        }))
        setPlayback((prev) => ({
          memorySizeMb: stored.playback?.memorySizeMb ?? prev.memorySizeMb,
          renderPrecision: stored.playback?.renderPrecision ?? prev.renderPrecision
        }))
        setLoaded(true)
      } catch {
        setLoaded(true)
      }
    }

    const unsubscribe = api?.onSettingsChanged?.((next) => {
      saveModeRef.current = 'external'
      setAppearance((prev) => ({
        followSystem:
          typeof next.appearance?.followSystem === 'boolean'
            ? next.appearance.followSystem
            : prev.followSystem,
        manualTheme: next.appearance?.manualTheme ?? prev.manualTheme
      }))
      setPlayback((prev) => ({
        memorySizeMb: next.playback?.memorySizeMb ?? prev.memorySizeMb,
        renderPrecision: next.playback?.renderPrecision ?? prev.renderPrecision
      }))
    })

    void load()

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [systemTheme])

  useEffect(() => {
    if (!loaded || typeof window === 'undefined') return
    if (saveModeRef.current === 'external') {
      saveModeRef.current = 'local'
      return
    }
    const api = window.settingsAPI
    if (!api) return

    const payload: AppSettings = {
      appearance: {
        followSystem: appearance.followSystem,
        manualTheme: appearance.manualTheme
      },
      playback
    }

    void api.saveSettings(payload)
  }, [appearance.followSystem, appearance.manualTheme, playback, loaded])

  return {
    appearance: { ...appearance, activeTheme },
    playback,
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
      }))
  }
}
