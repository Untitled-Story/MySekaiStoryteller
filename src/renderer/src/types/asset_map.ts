import { Texture } from 'pixi.js'
import AdvancedModel from '../model/advanced_model'

export interface Live2DModelMap {
  id: number
  model: AdvancedModel
}

export interface TextureMap {
  id: number
  image: Texture
}
