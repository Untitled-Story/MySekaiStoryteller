import { z } from 'zod'

export const ModelAssetSchema = z.object({
  name: z.string().optional(),
  modelId: z.string().min(1),
  normalScale: z.number().default(2.1),
  smallScale: z.number().default(1.8),
  anchor: z.number().default(0.5)
})

export const BackgroundAssetSchema = z.object({
  name: z.string().default('未命名背景'),
  path: z.string()
})

export const VoiceAssetSchema = z.object({
  name: z.string().default('未命名语音'),
  path: z.string()
})

export const ProjectAssetsSchema = z.object({
  models: z.record(z.string(), ModelAssetSchema).default({}),
  backgrounds: z.record(z.string(), BackgroundAssetSchema).default({}),
  voices: z.record(z.string(), VoiceAssetSchema).default({})
})

export const ProjectAssetKindSchema = z.enum(['models', 'backgrounds', 'voices'])

export const ProjectAssetMutationResultSchema = z.object({
  key: z.string().min(1),
  assets: ProjectAssetsSchema
})

export const ProjectAssetReferenceSchema = z.object({
  snippetId: z.string().uuid().nullable(),
  snippetType: z.string().min(1),
  path: z.string().min(1)
})

export type ModelAsset = z.infer<typeof ModelAssetSchema>
export type BackgroundAsset = z.infer<typeof BackgroundAssetSchema>
export type VoiceAsset = z.infer<typeof VoiceAssetSchema>
export type ProjectAssets = z.infer<typeof ProjectAssetsSchema>
export type ProjectAssetKind = z.infer<typeof ProjectAssetKindSchema>
export type ProjectAssetMutationResult = z.infer<typeof ProjectAssetMutationResultSchema>
export type ProjectAssetReference = z.infer<typeof ProjectAssetReferenceSchema>
