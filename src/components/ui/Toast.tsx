import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { CheckCircle2, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/style'

type ToastVariant = 'success' | 'error'

type ToastProps = {
  message: string
  variant: ToastVariant
  onDismiss: () => void
  closeLabel: string
  duration?: number
}

export function Toast({
  message,
  variant,
  onDismiss,
  closeLabel,
  duration = 3200
}: ToastProps): JSX.Element {
  const [closing, setClosing] = useState<boolean>(false)

  useEffect((): (() => void) => {
    const closeTimer = window.setTimeout((): void => setClosing(true), duration)
    return (): void => window.clearTimeout(closeTimer)
  }, [duration])

  useEffect((): (() => void) | void => {
    if (!closing) return
    const dismissTimer = window.setTimeout(onDismiss, 180)
    return (): void => window.clearTimeout(dismissTimer)
  }, [closing, onDismiss])

  const Icon = variant === 'success' ? CheckCircle2 : XCircle

  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={cn(
        'fixed right-6 bottom-6 z-[100] flex w-[min(24rem,calc(100vw-3rem))] items-start gap-3 rounded-md border bg-popover px-4 py-3 text-popover-foreground shadow-lg transition-all duration-200',
        variant === 'success' ? 'border-emerald-500/35' : 'border-destructive/35',
        closing ? 'translate-y-2 opacity-0' : 'translate-y-0 opacity-100'
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          variant === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
        )}
      />
      <p className="min-w-0 flex-1 text-sm leading-5 break-words">{message}</p>
      <button
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        onClick={(): void => setClosing(true)}
        className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

export type { ToastVariant }
