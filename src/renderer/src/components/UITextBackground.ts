import { AlphaFilter, Sprite, Texture } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

export default class UITextBackground extends Sprite {
  constructor(texture: Texture, screen_width: number, screen_height: number) {
    super(texture)
    this.anchor.set(0.5)
    this.width = screen_width
    this.height = screen_height
    this.x = screen_width / 2
    this.y = screen_height
    this.zIndex = 2
    const alpha_filter = new AlphaFilter(0)
    alpha_filter.resolution = 2
    this.filters = [alpha_filter]
  }

  public async show(time: number): Promise<void> {
    await AnimationManager.run((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = progress
    }, time)
  }
}
