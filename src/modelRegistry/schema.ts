import { z } from 'zod'

export const ModelRegistryEntrySchema = z.object({
  name: z.string().optional(),
  entry: z.string().min(1)
})

export const ModelRegistrySchema = z.object({
  version: z.literal(1).default(1),
  models: z.record(z.string(), ModelRegistryEntrySchema).default({})
})

export type ModelRegistryEntry = z.infer<typeof ModelRegistryEntrySchema>
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>
