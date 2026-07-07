export type SystemTheme = 'light' | 'dark'

export type AppearanceSettings = {
  followSystem: boolean
  manualTheme: SystemTheme
}

export type PlaybackSettings = {
  memorySizeMb: number
  renderPrecision: RenderPrecision
}

export type RenderPrecision = number | 'Auto'

export type AppSettings = {
  appearance: AppearanceSettings
  playback: PlaybackSettings
  workspaceDir?: string
}
