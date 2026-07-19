import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { z } from 'zod'
import { i18n } from '@/i18n'
import { isMobileRuntime } from '@/lib/platform'

const DiagnosticBundleSchema = z.object({
  id: z.string().min(1),
  fileName: z.string().min(1)
})

type DiagnosticBundle = z.infer<typeof DiagnosticBundleSchema>
export type DiagnosticExportResult = 'saved' | 'cancelled'

let lastReport: Readonly<Record<string, unknown>> = {}
let preparedBundlePromise: Promise<DiagnosticBundle> | null = null
let exportPromise: Promise<DiagnosticExportResult> | null = null
let androidAutoExportStarted = false

export function captureFatalDiagnostic(report: Readonly<Record<string, unknown>>): void {
  lastReport = report
  void prepareDiagnosticBundle(report).catch((error: unknown): void => {
    console.error('Failed to prepare diagnostic bundle', error)
  })

  if (!isMobileRuntime() || androidAutoExportStarted) return
  androidAutoExportStarted = true
  void exportPreparedDiagnosticBundle().catch((error: unknown): void => {
    console.error('Failed to export diagnostic bundle', error)
  })
}

export function exportPreparedDiagnosticBundle(): Promise<DiagnosticExportResult> {
  exportPromise ??= runDiagnosticExport().finally((): void => {
    exportPromise = null
  })
  return exportPromise
}

function prepareDiagnosticBundle(
  report: Readonly<Record<string, unknown>>
): Promise<DiagnosticBundle> {
  preparedBundlePromise ??= waitForLogWrite()
    .then((): Promise<unknown> => invoke<unknown>('prepare_diagnostic_bundle', { report }))
    .then((raw: unknown): DiagnosticBundle => DiagnosticBundleSchema.parse(raw))
  return preparedBundlePromise
}

async function runDiagnosticExport(): Promise<DiagnosticExportResult> {
  const bundle: DiagnosticBundle = await prepareDiagnosticBundle(lastReport)
  const destination: string | null = await save({
    title: i18n.t('diagnostics.saveTitle'),
    defaultPath: bundle.fileName,
    filters: [{ name: i18n.t('diagnostics.fileType'), extensions: ['zip'] }]
  })
  if (!destination) return 'cancelled'

  await invoke('export_diagnostic_bundle', {
    bundleId: bundle.id,
    destinationPath: destination
  })
  preparedBundlePromise = null
  return 'saved'
}

function waitForLogWrite(): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    window.setTimeout(resolve, 250)
  })
}
