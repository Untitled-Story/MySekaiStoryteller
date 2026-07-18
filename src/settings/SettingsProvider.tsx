import type { ReactNode, JSX } from 'react'
import { SettingsContext } from './SettingsContext'
import { useSettingsState, type UseSettingsStateOptions } from './useSettingsState'

export type SettingsProviderProps = {
  children: ReactNode
} & UseSettingsStateOptions

export function SettingsProvider({
  children,
  persist = true
}: SettingsProviderProps): JSX.Element {
  const value = useSettingsState({ persist })
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}
