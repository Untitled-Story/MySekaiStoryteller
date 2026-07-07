import { useContext } from 'react'
import { SettingsContext } from './SettingsContext'
import type { SettingsHook } from './useSettingsState'

export function useSettings(): SettingsHook {
  const ctx = useContext(SettingsContext)
  if (!ctx) {
    throw new Error('useSettings must be used within SettingsProvider')
  }
  return ctx
}
