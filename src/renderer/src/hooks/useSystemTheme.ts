import { useEffect, useState } from 'react'
import type { SystemTheme } from '@common/types/Settings'

const getPreferredTheme = (): SystemTheme => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light'
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const useSystemTheme = (): SystemTheme => {
  const [theme, setTheme] = useState<SystemTheme>(() => getPreferredTheme())

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (event: MediaQueryList | MediaQueryListEvent): void => {
      setTheme(event.matches ? 'dark' : 'light')
    }

    handleChange(mediaQuery)

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange)
    } else {
      // Fallback for older browsers/electron versions: use onchange assignment
      mediaQuery.onchange = handleChange as (this: MediaQueryList, ev: MediaQueryListEvent) => void
    }

    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleChange)
      } else if ('onchange' in mediaQuery) {
        mediaQuery.onchange = null
      }
    }
  }, [])

  return theme
}
