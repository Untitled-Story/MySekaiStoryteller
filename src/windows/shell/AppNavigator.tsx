import type { JSX } from 'react'
import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { registerAppNavigator } from '@/windows/api'

export function AppNavigator(): JSX.Element | null {
  const navigate = useNavigate()

  useEffect((): (() => void) => {
    registerAppNavigator((path: string): void => {
      void navigate(path)
    })
    return (): void => {
      registerAppNavigator(null)
    }
  }, [navigate])

  return null
}
