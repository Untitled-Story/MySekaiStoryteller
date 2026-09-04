import {
  importAssetsSequentially,
  type SequentialAssetImportFailure,
  type SequentialAssetImportResult
} from './importAssetsSequentially'

export interface ExistingModelRegistrationFailure {
  readonly modelId: string
  readonly error: unknown
}

export interface ExistingModelRegistrationRequest {
  readonly modelId: string
  readonly key?: string
  readonly name?: string
}

export interface ExistingModelRegistrationResult {
  readonly successCount: number
  readonly failures: readonly ExistingModelRegistrationFailure[]
}

export async function registerExistingModelsSequentially<TResult>(
  requests: readonly ExistingModelRegistrationRequest[],
  registerOne: (
    modelId: string,
    key: string | undefined,
    name: string | undefined
  ) => Promise<TResult>,
  onRegistered: (result: TResult, modelId: string) => void
): Promise<ExistingModelRegistrationResult> {
  const requestsByModelId: ReadonlyMap<string, ExistingModelRegistrationRequest> = new Map(
    requests.map(
      (request: ExistingModelRegistrationRequest): [string, ExistingModelRegistrationRequest] => [
        request.modelId,
        request
      ]
    )
  )
  const batchResult: SequentialAssetImportResult = await importAssetsSequentially<TResult>(
    requests.map((request: ExistingModelRegistrationRequest): string => request.modelId),
    async (modelId: string): Promise<TResult> => {
      const request: ExistingModelRegistrationRequest | undefined = requestsByModelId.get(modelId)
      if (!request) throw new Error(`Missing model registration request: ${modelId}`)
      return registerOne(modelId, request.key, request.name)
    },
    (result: TResult, modelId: string): void => onRegistered(result, modelId)
  )

  return {
    successCount: batchResult.successCount,
    failures: batchResult.failures.map(
      (failure: SequentialAssetImportFailure): ExistingModelRegistrationFailure => ({
        modelId: failure.sourcePath,
        error: failure.error
      })
    )
  }
}
