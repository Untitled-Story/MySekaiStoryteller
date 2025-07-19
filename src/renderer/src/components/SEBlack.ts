import FadableSprite from './FadableSprite'
import { Texture } from 'pixi.js'

export default class SEBlack extends FadableSprite {
  constructor(texture: Texture, screen_width: number, screen_height: number) {
    super(texture)

    this.anchor.set(0.5)
    this.x = screen_width / 2
    this.y = screen_height / 2
    this.width = screen_width * 1.1
    this.height = screen_height
  }
}
