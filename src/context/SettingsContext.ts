import { createContext } from 'react'
import type { SettingsHook } from '@/hooks/useSettingsState'

export const SettingsContext = createContext<SettingsHook | null>(null)
