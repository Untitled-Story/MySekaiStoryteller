export interface NewModelImportFailure {
  readonly sourcePath: string
  readonly stage: 'import' | 'register'
  readonly modelId?: string
  readonly error: unknown
}

export interface NewModelImportRequest {
  readonly sourcePath: string
  readonly archiveEntry?: string
  readonly key?: string
  readonly name?: string
}

export interface NewModelImportResult {
  readonly successCount: number
  readonly importedCount: number
  readonly failures: readonly NewModelImportFailure[]
}

export async function importNewModelsSequentially<
  TImported extends { readonly modelId: string },
  TRegistered
>(
  requests: readonly NewModelImportRequest[],
  importOne: (
    sourcePath: string,
    name: string | undefined,
    archiveEntry: string | undefined
  ) => Promise<TImported>,
  registerOne: (
    modelId: string,
    key: string | undefined,
    name: string | undefined
  ) => Promise<TRegistered>,
  onImported: (result: TImported, request: NewModelImportRequest) => void,
  onRegistered: (result: TRegistered, request: NewModelImportRequest) => void
): Promise<NewModelImportResult> {
  let successCount: number = 0
  let importedCount: number = 0
  const failures: NewModelImportFailure[] = []

  for (const request of requests) {
    let imported: TImported
    try {
      imported = await importOne(request.sourcePath, request.name, request.archiveEntry)
      importedCount += 1
      onImported(imported, request)
    } catch (error: unknown) {
      failures.push({ sourcePath: request.sourcePath, stage: 'import', error })
      continue
    }

    try {
      const registered: TRegistered = await registerOne(imported.modelId, request.key, request.name)
      onRegistered(registered, request)
      successCount += 1
    } catch (error: unknown) {
      failures.push({
        sourcePath: request.sourcePath,
        stage: 'register',
        modelId: imported.modelId,
        error
      })
    }
  }

  return { successCount, importedCount, failures }
}
