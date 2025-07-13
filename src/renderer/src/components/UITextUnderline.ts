import FadableSprite from './FadableSprite'
import { Texture } from 'pixi.js'

export default class UITextUnderline extends FadableSprite {
  constructor(texture: Texture, screen_width: number, screen_height: number) {
    super(texture)

    this.width = screen_width / 2
    this.x = screen_width / 10
    this.y = screen_height / 1.3
  }
}
