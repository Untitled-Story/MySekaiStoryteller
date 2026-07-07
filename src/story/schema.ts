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

export enum Curves {
  Linear = 'Linear',
  Sine = 'Sine',
  Cosine = 'Cosine'
}

export const LayoutModeSchema = z.enum(LayoutModes)
export const SideSchema = z.enum(Sides)
export const MoveSpeedSchema = z.enum(MoveSpeed)
export const CurveSchema = z.enum(Curves)
export const FiniteNumberSchema = z.number()
export const SecondsSchema = FiniteNumberSchema.nonnegative()
export const AssetKeySchema = z.string().min(1)
export const OptionalAssetKeySchema = AssetKeySchema.optional()
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)

export const SnippetBaseSchema = z.object({
  delay: SecondsSchema.default(0)
})

export const PositionSchema = z.object({
  side: SideSchema,
  offset: FiniteNumberSchema.default(0)
})

export const ChangeLayoutModeSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('ChangeLayoutMode'),
  data: z.object({
    mode: LayoutModeSchema
  })
})

export const ChangeBackgroundImageSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('ChangeBackgroundImage'),
  data: z.object({
    background: AssetKeySchema
  })
})

export const LayoutAppearSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('LayoutAppear'),
  data: z.object({
    model: AssetKeySchema,
    from: PositionSchema,
    to: PositionSchema,
    motion: OptionalAssetKeySchema,
    facial: OptionalAssetKeySchema,
    moveSpeed: MoveSpeedSchema,
    hologram: z.boolean().default(false)
  })
})

export const LayoutClearSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('LayoutClear'),
  data: z.object({
    model: AssetKeySchema,
    from: PositionSchema,
    to: PositionSchema,
    moveSpeed: MoveSpeedSchema
  })
})

export const TalkSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('Talk'),
  data: z.object({
    speaker: z.string(),
    content: z.string(),
    model: OptionalAssetKeySchema,
    voice: OptionalAssetKeySchema
  })
})

export const HideTalkSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('HideTalk')
})

export const MoveSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('Move'),
  data: z.object({
    model: AssetKeySchema,
    from: PositionSchema,
    to: PositionSchema,
    moveSpeed: MoveSpeedSchema
  })
})

export const MotionSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('Motion'),
  data: z.object({
    model: AssetKeySchema,
    motion: OptionalAssetKeySchema,
    facial: OptionalAssetKeySchema
  })
})

export const TelopSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('Telop'),
  data: z.object({
    content: z.string()
  })
})

export const DoParamSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('DoParam'),
  data: z.object({
    model: AssetKeySchema,
    params: z
      .array(
        z.object({
          paramId: AssetKeySchema,
          start: FiniteNumberSchema,
          end: FiniteNumberSchema,
          curve: CurveSchema,
          duration: SecondsSchema
        })
      )
      .min(1)
  })
})

export const ScreenFadeOutSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('ScreenFadeOut'),
  data: z.object({
    color: HexColorSchema,
    duration: SecondsSchema
  })
})

export const ScreenFadeInSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('ScreenFadeIn'),
  data: z.object({
    duration: SecondsSchema
  })
})

export const LeafSnippetSchemas = [
  ChangeLayoutModeSnippetSchema,
  ChangeBackgroundImageSnippetSchema,
  LayoutAppearSnippetSchema,
  LayoutClearSnippetSchema,
  TalkSnippetSchema,
  HideTalkSnippetSchema,
  MoveSnippetSchema,
  MotionSnippetSchema,
  TelopSnippetSchema,
  DoParamSnippetSchema,
  ScreenFadeOutSnippetSchema,
  ScreenFadeInSnippetSchema
] as const

export const LeafSnippetSchema = z.discriminatedUnion('type', LeafSnippetSchemas)

export type LayoutModeData = z.output<typeof LayoutModeSchema>
export type SideData = z.output<typeof SideSchema>
export type MoveSpeedData = z.output<typeof MoveSpeedSchema>
export type CurveData = z.output<typeof CurveSchema>
export type HexColorData = z.output<typeof HexColorSchema>
export type AssetKeyData = z.output<typeof AssetKeySchema>
export type PositionData = z.output<typeof PositionSchema>
export type SnippetBaseData = z.output<typeof SnippetBaseSchema>
export type LeafSnippetData = z.output<typeof LeafSnippetSchema>
export type LeafSnippetInput = z.input<typeof LeafSnippetSchema>

export type ParallelSnippetData = SnippetBaseData & {
  type: 'Parallel'
  snippets: SnippetData[]
}

export type ParallelSnippetInput = z.input<typeof SnippetBaseSchema> & {
  type: 'Parallel'
  snippets?: SnippetInput[]
}

export type SnippetData = LeafSnippetData | ParallelSnippetData
export type SnippetInput = LeafSnippetInput | ParallelSnippetInput

export const SnippetSchema: z.ZodType<SnippetData, SnippetInput> = z.lazy(() => {
  const ParallelSnippetSchema = SnippetBaseSchema.extend({
    type: z.literal('Parallel'),
    snippets: z.array(SnippetSchema).default([])
  })

  return z.discriminatedUnion('type', [...LeafSnippetSchemas, ParallelSnippetSchema])
})

export const StorySchema = z.object({
  version: z.literal(1).default(1),
  snippets: z.array(SnippetSchema).default([])
})

export type StoryInput = z.input<typeof StorySchema>
export type StoryData = z.output<typeof StorySchema>
