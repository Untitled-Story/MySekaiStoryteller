import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import {
  captureFatalDiagnostic,
  exportPreparedDiagnosticBundle,
  type DiagnosticExportResult
} from '@/lib/diagnostics'
import { describeError, logger } from '@/lib/logger'
import { i18n } from '@/i18n'

type FrontendErrorBoundaryProps = {
  children: ReactNode
}

type FrontendErrorBoundaryState = {
  failed: boolean
  exportStatus: 'idle' | 'exporting' | 'saved' | 'error'
}

export class FrontendErrorBoundary extends Component<
  FrontendErrorBoundaryProps,
  FrontendErrorBoundaryState
> {
  public state: FrontendErrorBoundaryState = { failed: false, exportStatus: 'idle' }

  public static getDerivedStateFromError(): FrontendErrorBoundaryState {
    return { failed: true, exportStatus: 'idle' }
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error('react.error_boundary', {
      error: describeError(error),
      componentStack: info.componentStack
    })
    captureFatalDiagnostic({
      event: 'react.error_boundary',
      error: describeError(error),
      componentStack: info.componentStack
    })
  }

  private exportDiagnostics = (): void => {
    this.setState({ exportStatus: 'exporting' })
    void exportPreparedDiagnosticBundle()
      .then((result: DiagnosticExportResult): void => {
        this.setState({ exportStatus: result === 'saved' ? 'saved' : 'idle' })
      })
      .catch((error: unknown): void => {
        console.error('Failed to export diagnostics', error)
        this.setState({ exportStatus: 'error' })
      })
  }

  public render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="flex h-screen w-screen items-center justify-center bg-background p-8 text-foreground">
          <div className="max-w-lg space-y-4 text-center">
            <h1 className="text-lg font-semibold">{i18n.t('errorBoundary.title')}</h1>
            <p className="text-sm text-muted-foreground">{i18n.t('errorBoundary.description')}</p>
            <p className="text-xs text-muted-foreground">{i18n.t('diagnostics.privacyNotice')}</p>
            <div className="flex flex-col items-center gap-2">
              <Button
                type="button"
                onClick={this.exportDiagnostics}
                disabled={this.state.exportStatus === 'exporting'}
              >
                {this.state.exportStatus === 'exporting'
                  ? i18n.t('diagnostics.exporting')
                  : i18n.t('diagnostics.export')}
              </Button>
              {this.state.exportStatus === 'saved' ? (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                  {i18n.t('diagnostics.exportComplete')}
                </p>
              ) : null}
              {this.state.exportStatus === 'error' ? (
                <p className="text-xs text-destructive">{i18n.t('diagnostics.exportFailed')}</p>
              ) : null}
            </div>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}
