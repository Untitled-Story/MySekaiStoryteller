export type SystemTheme = 'light' | 'dark'

export type AppearanceSettings = {
  followSystem: boolean
  manualTheme: SystemTheme
}

export type PlaybackSettings = {
  memorySizeMb: number
  renderPrecision: number
}

export type AppSettings = {
  appearance: AppearanceSettings
  playback: PlaybackSettings
}
