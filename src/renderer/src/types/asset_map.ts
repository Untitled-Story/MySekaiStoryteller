import { Live2DModel } from 'pixi-live2d-display-mulmotion'
import { Texture } from 'pixi.js'

export interface Live2DModelMap {
  id: number
  model: Live2DModel
}

export interface TextureMap {
  id: number
  image: Texture
}
