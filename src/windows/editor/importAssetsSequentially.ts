export interface SequentialAssetImportFailure {
  readonly sourcePath: string
  readonly error: unknown
}

export interface SequentialAssetImportResult {
  readonly successCount: number
  readonly failures: readonly SequentialAssetImportFailure[]
}

export async function importAssetsSequentially<TResult>(
  sourcePaths: readonly string[],
  importOne: (sourcePath: string) => Promise<TResult>,
  onImported: (result: TResult, sourcePath: string) => void
): Promise<SequentialAssetImportResult> {
  let successCount: number = 0
  const failures: SequentialAssetImportFailure[] = []

  for (const sourcePath of sourcePaths) {
    try {
      const result: TResult = await importOne(sourcePath)
      onImported(result, sourcePath)
      successCount += 1
    } catch (error: unknown) {
      failures.push({ sourcePath, error })
    }
  }

  return { successCount, failures }
}
