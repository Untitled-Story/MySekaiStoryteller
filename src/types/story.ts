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

export const ModelSchema = z.object({
  id: z.number(),
  model: z.string(),
  normal_scale: z.number().default(2.1),
  small_scale: z.number().default(1.8),
  anchor: z.number().default(0.5)
})

export const ImageSchema = z.object({
  id: z.number(),
  image: z.string()
})

export const LayoutModeEnum = z.enum(LayoutModes)
export const SideEnum = z.enum(Sides)
export const MoveSpeedEnum = z.enum(MoveSpeed)
export const CurvesEnum = z.enum(Curves)

export const SnippetBase = {
  wait: z.boolean(),
  delay: z.number()
}
