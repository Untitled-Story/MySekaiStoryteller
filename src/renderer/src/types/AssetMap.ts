import { Texture } from 'pixi.js'
import AdvancedModel from '../model/AdvancedModel'

export interface Live2DModelMap {
  id: number
  model: AdvancedModel
}

export interface TextureMap {
  id: number
  image: Texture
}
