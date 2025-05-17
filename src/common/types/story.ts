import { z } from 'zod'

export const ModelSchema = z.object({
  id: z.number(),
  model: z.string()
})

export const ImageSchema = z.object({
  id: z.number(),
  image: z.string()
})

export const LayoutModeEnum = z.enum(['Normal', 'Three'])
export const SideEnum = z.enum(['Center'])
export const MoveSpeedEnum = z.enum(['Slow'])

export const SnippetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ChangeLayoutMode'),
    data: LayoutModeEnum
  }),
  z.object({
    type: z.literal('LayoutAppear'),
    data: z.object({
      modelId: z.number(),
      from: z.object({
        side: SideEnum,
        offset: z.number()
      }),
      to: z.object({
        side: SideEnum,
        offset: z.number()
      }),
      motion: z.string(),
      facial: z.string(),
      moveSpeed: MoveSpeedEnum
    })
  }),
  z.object({
    type: z.literal('ChangeBackgroundImage'),
    data: z.number()
  })
])

export const StorySchema = z.object({
  title: z.string(),
  version: z.string().regex(/^v\d+\.\d+\.\d+$/),
  models: z.array(ModelSchema),
  images: z.array(ImageSchema),
  snippets: z.array(SnippetSchema)
})

export type Snippet = z.infer<typeof SnippetSchema>
export type Story = z.infer<typeof StorySchema>
