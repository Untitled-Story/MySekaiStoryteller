import { Texture } from 'pixi.js'
import FadableSprite from './FadableSprite'

export default class UITextBackground extends FadableSprite {
  constructor(texture: Texture, screen_width: number, screen_height: number) {
    super(texture)
    this.anchor.set(0.5)
    this.width = screen_width
    this.height = screen_height
    this.x = screen_width / 2
    this.y = screen_height / 2
  }
}
