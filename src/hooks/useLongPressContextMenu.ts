import type { PointerEvent as ReactPointerEvent } from 'react'
import { useRef } from 'react'

const DEFAULT_LONG_PRESS_MS: number = 480
const MOVE_CANCEL_PX: number = 10

type LongPressHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void
}

export function useLongPressContextMenu(options?: {
  delayMs?: number
  onOpen?: () => void
}): LongPressHandlers {
  const delayMs: number = options?.delayMs ?? DEFAULT_LONG_PRESS_MS
  const onOpen = options?.onOpen
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null)

  function clearTimer(): void {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  function reset(): void {
    clearTimer()
    startRef.current = null
  }

  function openContextMenu(target: HTMLElement, clientX: number, clientY: number): void {
    onOpen?.()
    const event: MouseEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 2,
      buttons: 2,
      view: window
    })
    target.dispatchEvent(event)
  }

  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>): void => {
      if (event.pointerType === 'mouse' || event.button !== 0) return
      clearTimer()
      startRef.current = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId
      }
      const target: HTMLElement = event.currentTarget
      const clientX: number = event.clientX
      const clientY: number = event.clientY
      timerRef.current = window.setTimeout((): void => {
        timerRef.current = null
        openContextMenu(target, clientX, clientY)
        startRef.current = null
      }, delayMs)
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>): void => {
      const start = startRef.current
      if (!start || start.pointerId !== event.pointerId) return
      const dx: number = Math.abs(event.clientX - start.x)
      const dy: number = Math.abs(event.clientY - start.y)
      if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) reset()
    },
    onPointerUp: (): void => {
      reset()
    },
    onPointerCancel: (): void => {
      reset()
    },
    onPointerLeave: (): void => {
      reset()
    }
  }
}
