import type { ReactNode, JSX } from 'react'
import { SettingsContext } from './SettingsContext'
import { useSettingsState } from './useSettingsState'

export function SettingsProvider({ children }: { children: ReactNode }): JSX.Element {
  const value = useSettingsState()
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}
