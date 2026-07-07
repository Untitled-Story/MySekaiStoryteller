import { createContext } from 'react'
import type { SettingsHook } from './useSettingsState'

export const SettingsContext = createContext<SettingsHook | null>(null)
