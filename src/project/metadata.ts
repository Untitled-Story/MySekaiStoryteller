import { z } from 'zod'

export const AssetsSummarySchema = z.object({
  models: z.number().int().nonnegative(),
  backgrounds: z.number().int().nonnegative(),
  voices: z.number().int().nonnegative()
})

export const ProjectMetadataSchema = z.object({
  title: z.string(),
  lastModified: z.number(),
  assetsSummary: AssetsSummarySchema.optional()
})

export type AssetsSummary = z.infer<typeof AssetsSummarySchema>

export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>

export type ProjectMetadataInput = {
  title: string
  lastModified: number
  assetsSummary?: AssetsSummary
}
