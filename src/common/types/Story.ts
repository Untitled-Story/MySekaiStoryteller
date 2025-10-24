import { z } from 'zod'

export enum LayoutModes {
  Normal = 'Normal',
  Three = 'Three'
}

export enum Sides {
  Center = 'Center',
  Left = 'Left',
  Right = 'Right'
}

export enum MoveSpeed {
  Slow = 'Slow',
  Normal = 'Normal',
  Fast = 'Fast',
  Immediate = 'Immediate'
}

const ModelSchema = z.object({
  id: z.number(),
  model: z.string(),
  normal_scale: z.number().default(2.1),
  small_scale: z.number().default(1.8),
  anchor: z.number().default(0.5)
})

const ImageSchema = z.object({
  id: z.number(),
  image: z.string()
})

const LayoutModeEnum = z.nativeEnum(LayoutModes)
const SideEnum = z.nativeEnum(Sides)
const MoveSpeedEnum = z.nativeEnum(MoveSpeed)

const SnippetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ChangeLayoutMode'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      mode: LayoutModeEnum
    })
  }),
  z.object({
    type: z.literal('ChangeBackgroundImage'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      imageId: z.number()
    })
  }),
  z.object({
    type: z.literal('LayoutAppear'),
    wait: z.boolean(),
    delay: z.number(),
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
    type: z.literal('LayoutClear'),
    wait: z.boolean(),
    delay: z.number(),
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
      moveSpeed: MoveSpeedEnum
    })
  }),
  z.object({
    type: z.literal('Talk'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      speaker: z.string(),
      content: z.string(),
      modelId: z.number(),
      voice: z.string()
    })
  }),
  z.object({
    type: z.literal('HideTalk'),
    wait: z.boolean(),
    delay: z.number()
  }),
  z.object({
    type: z.literal('Move'),
    wait: z.boolean(),
    delay: z.number(),
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
      moveSpeed: MoveSpeedEnum
    })
  }),
  z.object({
    type: z.literal('Motion'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      modelId: z.number(),
      motion: z.string(),
      facial: z.string()
    })
  }),
  z.object({
    type: z.literal('Telop'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      content: z.string()
    })
  }),
  z.object({
    type: z.literal('BlackOut'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      duration: z.number()
    })
  }),
  z.object({
    type: z.literal('BlackIn'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      duration: z.number()
    })
  })
])

export const StorySchema = z.object({
  title: z.string(),
  models: z.array(ModelSchema),
  images: z.array(ImageSchema),
  snippets: z.array(SnippetSchema)
})

export type SnippetData = z.infer<typeof SnippetSchema>
export type StoryData = z.infer<typeof StorySchema>
