import { z } from 'zod'

export const ModelRegistryEntrySchema = z.object({
  name: z.string().optional(),
  entry: z.string().min(1),
  motions: z.array(z.string()).default([]),
  facials: z.array(z.string()).default([])
})

export const ModelRegistrySchema = z.object({
  version: z.literal(1).default(1),
  models: z.record(z.string(), ModelRegistryEntrySchema).default({})
})

export const ImportedModelResultSchema = z.object({
  modelId: z.string().min(1),
  registry: ModelRegistrySchema
})

export type ModelRegistryEntry = z.infer<typeof ModelRegistryEntrySchema>
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>
export type ImportedModelResult = z.infer<typeof ImportedModelResultSchema>
