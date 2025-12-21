/// <reference types="vite/client" />

import type { AppSettings } from '@common/types/Settings'

declare global {
  interface Window {
    settingsAPI?: {
      initialSettings: AppSettings | null
      getSettings: () => Promise<AppSettings | null>
      saveSettings: (settings: AppSettings) => Promise<void>
      onSettingsChanged: (callback: (settings: AppSettings) => void) => () => void
    }
  }
}
