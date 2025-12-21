import { useContext } from 'react'
import { SettingsContext } from '@renderer/context/SettingsContext'
import type { SettingsHook } from '@renderer/hooks/useSettingsState'

export function useSettings(): SettingsHook {
  const ctx = useContext(SettingsContext)
  if (!ctx) {
    throw new Error('useSettings must be used within SettingsProvider')
  }
  return ctx
}
