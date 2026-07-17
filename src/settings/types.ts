import type { OnboardingSettings } from '@/onboarding/types'

export type SystemTheme = 'light' | 'dark'

export type AppLanguage = 'system' | 'zh-CN' | 'zh-HK' | 'en' | 'ja'

export type AppearanceSettings = {
  followSystem: boolean
  manualTheme: SystemTheme
}

export type PlaybackSettings = {
  memorySizeMb: number
  renderPrecision: RenderPrecision
  font: PlaybackFontSettings
}

export type RenderPrecision = number | 'Auto'

export type PlaybackFontSettings =
  | {
      source: 'default'
    }
  | {
      source: 'data'
      family: string
      path: string
    }

export type ShortcutBinding = {
  key: string
  primary: boolean
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

export type ShortcutSettings = {
  editor: {
    save: ShortcutBinding
  }
  player: {
    reload: ShortcutBinding
    enterFullscreen: ShortcutBinding
    exitFullscreen: ShortcutBinding
    close: ShortcutBinding
  }
}

export type AppSettings = {
  language: AppLanguage
  appearance: AppearanceSettings
  playback: PlaybackSettings
  shortcuts: ShortcutSettings
  onboarding: OnboardingSettings
  workspaceDir?: string
}
