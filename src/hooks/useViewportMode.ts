import { useEffect, useState } from 'react'
import { isDesktopRuntime } from '@/lib/platform'

export type ViewportMode = 'phone' | 'tablet' | 'desktop'

export const VIEWPORT_PHONE_MAX_PX: number = 767
export const VIEWPORT_TABLET_MAX_PX: number = 1023

export function resolveViewportMode(width: number): ViewportMode {
  if (width <= VIEWPORT_PHONE_MAX_PX) return 'phone'
  if (width <= VIEWPORT_TABLET_MAX_PX) return 'tablet'
  return 'desktop'
}

export function useViewportMode(): ViewportMode {
  const [mode, setMode] = useState<ViewportMode>((): ViewportMode => {
    if (typeof window === 'undefined' || isDesktopRuntime()) return 'desktop'
    return resolveViewportMode(window.innerWidth)
  })

  useEffect((): (() => void) => {
    function updateMode(): void {
      setMode(isDesktopRuntime() ? 'desktop' : resolveViewportMode(window.innerWidth))
    }

    updateMode()
    window.addEventListener('resize', updateMode)
    return (): void => window.removeEventListener('resize', updateMode)
  }, [])

  return mode
}

export function useIsPhoneViewport(): boolean {
  return useViewportMode() === 'phone'
}

export function useIsTouchViewport(): boolean {
  const mode: ViewportMode = useViewportMode()
  return mode === 'phone' || mode === 'tablet'
}
