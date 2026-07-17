import { Component, type ErrorInfo, type ReactNode } from 'react'
import { describeError, logger } from '@/lib/logger'
import { i18n } from '@/i18n'

type FrontendErrorBoundaryProps = {
  children: ReactNode
}

type FrontendErrorBoundaryState = {
  failed: boolean
}

export class FrontendErrorBoundary extends Component<
  FrontendErrorBoundaryProps,
  FrontendErrorBoundaryState
> {
  public state: FrontendErrorBoundaryState = { failed: false }

  public static getDerivedStateFromError(): FrontendErrorBoundaryState {
    return { failed: true }
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error('react.error_boundary', {
      error: describeError(error),
      componentStack: info.componentStack
    })
  }

  public render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="flex h-screen w-screen items-center justify-center bg-background p-8 text-foreground">
          <div className="max-w-lg space-y-2 text-center">
            <h1 className="text-lg font-semibold">{i18n.t('errorBoundary.title')}</h1>
            <p className="text-sm text-muted-foreground">{i18n.t('errorBoundary.description')}</p>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}
