import { createContext } from 'react'
import type { SettingsHook } from '@renderer/hooks/useSettingsState'

export const SettingsContext = createContext<SettingsHook | null>(null)
