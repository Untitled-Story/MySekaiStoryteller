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

const LayoutModeEnum = z.enum(LayoutModes)
const SideEnum = z.enum(Sides)
const MoveSpeedEnum = z.enum(MoveSpeed)
const CurvesEnum = z.enum(Curves)

const SnippetBase = {
  wait: z.boolean(),
  delay: z.number()
}
