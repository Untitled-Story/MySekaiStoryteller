export type SystemTheme = 'light' | 'dark'

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

export type AppSettings = {
  appearance: AppearanceSettings
  playback: PlaybackSettings
  workspaceDir?: string
}
