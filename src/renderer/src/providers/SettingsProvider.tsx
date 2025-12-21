import type { ReactNode, JSX } from 'react'
import { SettingsContext } from '@renderer/context/SettingsContext'
import { useSettingsState } from '@renderer/hooks/useSettingsState'

export function SettingsProvider({ children }: { children: ReactNode }): JSX.Element {
  const value = useSettingsState()
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}
