import { invoke } from '@tauri-apps/api/core'
import type { AppSettings } from './types'

export function getSettings(): Promise<AppSettings | null> {
  return invoke<AppSettings | null>('get_settings')
}

export function saveSettings(settings: AppSettings): Promise<void> {
  return invoke('save_settings', { settings })
}
