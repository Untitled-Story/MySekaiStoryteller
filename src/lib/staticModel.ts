import { Assets, Sprite, type Texture } from 'pixi.js'

/** The slice of a Live2D internal model that layout and visual effects read. */
export type StaticModelBounds = {
  readonly width: number
  readonly height: number
  readonly originalHeight: number
}

/**
 * A single imported image shown as a model. It mirrors the geometry surface of a Live2D model
 * (`anchor`, `internalModel`) so positioning, fading and visual effects treat both alike; it has
 * no motions, facials or parameters.
 */
export class StaticModelSprite extends Sprite {
  readonly internalModel: StaticModelBounds

  constructor(texture: Texture) {
    super({ texture })
    this.internalModel = {
      width: texture.width,
      height: texture.height,
      originalHeight: texture.height
    }
  }
}

export async function loadStaticModel(imageUrl: string): Promise<StaticModelSprite> {
  const texture: Texture = await Assets.load<Texture>(imageUrl)
  return new StaticModelSprite(texture)
}
