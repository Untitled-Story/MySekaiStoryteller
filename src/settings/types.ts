import type { OnboardingSettings } from '@/onboarding/types'
import type { InteractionSettings } from '@/lib/touchMode'

export type { InteractionSettings }

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

/** Last-used video export preferences (path is not stored). */
export type ExportPreferences = {
  width: number
  height: number
  fps: number
  concurrency: number
}

export type AppSettings = {
  language: AppLanguage
  appearance: AppearanceSettings
  playback: PlaybackSettings
  shortcuts: ShortcutSettings
  onboarding: OnboardingSettings
  interaction: InteractionSettings
  /** Persisted export dialog defaults: width / height / fps / concurrency. */
  export?: ExportPreferences
  workspaceDir?: string
}

export type RenderConfig = {
  exportPath: string
  width: number
  height: number
  fps: number
  /** Parallel workers (1–4). Default 1 = single-path export. */
  concurrency?: number
  /** Coordinator/worker role when multi-worker export is active; debug opens technical dashboard. */
  role?: 'coordinator' | 'worker' | 'single' | 'debug'
  sessionId?: string
  /** Shared id for coordinating multi-worker progress events. */
  exportGroupId?: string
  workerIndex?: number
  workers?: number
  startFrame?: number
  endFrame?: number
  /** Per-worker temporary segment output path. */
  segmentPath?: string
  /** Optional final public path (e.g. Movies/...) after private encode. */
  publishPath?: string
  /** Queue job id when using multi-job worker pool. */
  jobId?: number
  /** If true, worker stays alive and waits for more job assigns. */
  multiJob?: boolean
  /**
   * Absolute data/workspace path from the launcher window.
   * Workers should prefer this over get_data_path() so concurrent settings
   * saves cannot leave them without a workspace.
   */
  dataPath?: string
}
