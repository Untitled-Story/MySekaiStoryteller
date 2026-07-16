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
export const SnippetIdSchema = z.string().uuid().optional()
export const EffectIdSchema = z.string().trim().min(1)

export const SnippetBaseSchema = z.object({
  // `id` is editor-only metadata. The runtime intentionally has no behavior attached to it.
  id: SnippetIdSchema,
  delay: SecondsSchema.default(0)
})

export const PositionSchema = z.object({
  side: SideSchema,
  offset: FiniteNumberSchema.default(0)
})

export const EffectTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Model'), model: AssetKeySchema }),
  z.object({ type: z.literal('Stage') }),
  z.object({ type: z.literal('Screen') })
])

export const GrayscaleEffectSchema = z.object({
  type: z.literal('Grayscale'),
  intensity: FiniteNumberSchema.min(0).max(1).default(1)
})

export const BlurEffectSchema = z.object({
  type: z.literal('Blur'),
  strength: FiniteNumberSchema.nonnegative().default(8),
  quality: FiniteNumberSchema.int().min(1).max(4).default(2),
  kernelSize: z
    .union([z.literal(5), z.literal(7), z.literal(9), z.literal(11), z.literal(13), z.literal(15)])
    .default(5)
})

export const OldFilmEffectSchema = z.object({
  type: z.literal('OldFilm'),
  sepia: FiniteNumberSchema.min(0).max(1).default(0.3),
  noise: FiniteNumberSchema.min(0).max(1).default(0.3),
  noiseSize: FiniteNumberSchema.nonnegative().default(1),
  scratch: FiniteNumberSchema.min(0).max(1).default(0.5),
  scratchDensity: FiniteNumberSchema.min(0).max(1).default(0.3),
  scratchWidth: FiniteNumberSchema.nonnegative().default(1),
  vignetting: FiniteNumberSchema.min(0).max(1).default(0.3),
  vignettingAlpha: FiniteNumberSchema.min(0).max(1).default(1),
  vignettingBlur: FiniteNumberSchema.min(0).max(1).default(0.3)
})

export const CrtEffectSchema = z.object({
  type: z.literal('CRT'),
  curvature: FiniteNumberSchema.nonnegative().default(1),
  lineWidth: FiniteNumberSchema.nonnegative().default(1),
  lineContrast: FiniteNumberSchema.min(0).max(1).default(0.25),
  verticalLine: z.boolean().default(false),
  noise: FiniteNumberSchema.min(0).max(1).default(0.3),
  noiseSize: FiniteNumberSchema.nonnegative().default(1),
  vignetting: FiniteNumberSchema.min(0).max(1).default(0.3),
  vignettingAlpha: FiniteNumberSchema.min(0).max(1).default(1),
  vignettingBlur: FiniteNumberSchema.min(0).max(1).default(0.3)
})

export const ColorOverlayEffectSchema = z.object({
  type: z.literal('ColorOverlay'),
  color: HexColorSchema.default('#000000'),
  alpha: FiniteNumberSchema.min(0).max(1).default(0.5)
})

export const VisualEffectSchema = z.discriminatedUnion('type', [
  GrayscaleEffectSchema,
  BlurEffectSchema,
  OldFilmEffectSchema,
  CrtEffectSchema,
  ColorOverlayEffectSchema
])

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

export const ApplyEffectSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('ApplyEffect'),
  data: z.object({
    effectId: EffectIdSchema,
    target: EffectTargetSchema,
    effect: VisualEffectSchema,
    duration: SecondsSchema.default(0.3)
  })
})

export const RemoveEffectSnippetSchema = SnippetBaseSchema.extend({
  type: z.literal('RemoveEffect'),
  data: z.object({
    effectId: EffectIdSchema,
    duration: SecondsSchema.default(0.3)
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
  ScreenFadeInSnippetSchema,
  ApplyEffectSnippetSchema,
  RemoveEffectSnippetSchema
] as const

export const LeafSnippetSchema = z.discriminatedUnion('type', LeafSnippetSchemas)

export type LayoutModeData = z.output<typeof LayoutModeSchema>
export type SideData = z.output<typeof SideSchema>
export type MoveSpeedData = z.output<typeof MoveSpeedSchema>
export type CurveData = z.output<typeof CurveSchema>
export type HexColorData = z.output<typeof HexColorSchema>
export type AssetKeyData = z.output<typeof AssetKeySchema>
export type PositionData = z.output<typeof PositionSchema>
export type EffectTargetData = z.output<typeof EffectTargetSchema>
export type VisualEffectData = z.output<typeof VisualEffectSchema>
export type GrayscaleEffectData = z.output<typeof GrayscaleEffectSchema>
export type BlurEffectData = z.output<typeof BlurEffectSchema>
export type OldFilmEffectData = z.output<typeof OldFilmEffectSchema>
export type CrtEffectData = z.output<typeof CrtEffectSchema>
export type ColorOverlayEffectData = z.output<typeof ColorOverlayEffectSchema>
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
