import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import { runLoggedOperation } from '@/lib/logger'

const ProjectArchiveInspectionSchema = z.object({
  title: z.string().min(1),
  suggestedTitle: z.string().min(1),
  projectExists: z.boolean(),
  modelCount: z.number().int().nonnegative()
})

const ImportedProjectResultSchema = z.object({
  projectName: z.string().min(1),
  renamedModels: z.number().int().nonnegative()
})

export type ProjectArchiveInspection = z.infer<typeof ProjectArchiveInspectionSchema>
export type ImportedProjectResult = z.infer<typeof ImportedProjectResultSchema>
export type ProjectImportConflict = 'rename' | 'replace'

export const PROJECT_IMPORT_BROWSER_EVENT = 'mss:project-import-requested'
export const PROJECTS_CHANGED_BROWSER_EVENT = 'mss:projects-changed'

export async function inspectProjectArchive(sourcePath: string): Promise<ProjectArchiveInspection> {
  return runLoggedOperation(
    'project.archive_inspect',
    { sourceKind: pickedPathKind(sourcePath) },
    async (): Promise<ProjectArchiveInspection> => {
      const raw: unknown = await invoke<unknown>('inspect_project_archive', { sourcePath })
      return ProjectArchiveInspectionSchema.parse(raw)
    }
  )
}

export function exportProjectArchive(projectName: string, destinationPath: string): Promise<void> {
  return runLoggedOperation(
    'project.archive_export',
    { projectName, destinationKind: pickedPathKind(destinationPath) },
    (): Promise<void> => invoke('export_project_archive', { projectName, destinationPath })
  )
}

export async function importProjectArchive(
  sourcePath: string,
  conflict: ProjectImportConflict
): Promise<ImportedProjectResult> {
  return runLoggedOperation(
    'project.archive_import',
    { sourceKind: pickedPathKind(sourcePath), conflict },
    async (): Promise<ImportedProjectResult> => {
      const raw: unknown = await invoke<unknown>('import_project_archive', {
        sourcePath,
        conflict
      })
      return ImportedProjectResultSchema.parse(raw)
    }
  )
}

export function getPendingProjectImports(): Promise<string[]> {
  return invoke<string[]>('get_pending_project_imports')
}

export function requestProjectImport(sourcePath: string): void {
  window.dispatchEvent(
    new CustomEvent<string>(PROJECT_IMPORT_BROWSER_EVENT, { detail: sourcePath })
  )
}

function pickedPathKind(path: string): 'content-uri' | 'file-uri' | 'local-path' {
  const normalized: string = path.toLowerCase()
  if (normalized.startsWith('content://')) return 'content-uri'
  if (normalized.startsWith('file://')) return 'file-uri'
  return 'local-path'
}
