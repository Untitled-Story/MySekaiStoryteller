import { AlphaFilter, Container, Sprite, Text, TextStyle, Texture } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

export default class UITelop extends Container {
  private readonly telopSprite!: Sprite
  private readonly telopText: Text

  constructor(telopTexture: Texture, screen_width: number, screen_height: number) {
    super()

    const alpha_filter = new AlphaFilter(0)
    alpha_filter.resolution = 2
    this.filters = [alpha_filter]

    this.telopSprite = new Sprite(telopTexture)
    this.telopSprite.anchor.set(0.5)
    this.telopSprite.x = screen_width / 2
    this.telopSprite.y = screen_height / 2
    this.telopSprite.scale.x = screen_width / 1920
    this.telopSprite.height = screen_height / 8

    const style = new TextStyle({
      align: 'center',
      fill: '#FFFFFF',
      fontFamily: 'Source Han Sans SC',
      fontSize: screen_height / 23,
      textBaseline: 'bottom'
    })
    this.telopText = new Text('', style)
    this.telopText.anchor.set(0.5)
    this.telopText.x = screen_width / 2 - 11
    this.telopText.y = screen_height / 2 + screen_height / 141

    this.addChild(this.telopSprite)
    this.addChild(this.telopText)
  }

  set text(text: string) {
    this.telopText.text = text
  }

  public async show(time: number): Promise<void> {
    const startX = this.x - 10
    const originalX = this.x

    this.visible = true
    await AnimationManager.run((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = progress

      this.x = startX + (originalX - startX) * progress
    }, time)
  }

  public async hide(time: number): Promise<void> {
    const startX = this.x
    const originalX = this.x + 10

    await AnimationManager.run((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = 1 - progress

      this.x = startX + (originalX - startX) * progress
    }, time)
    this.visible = false
  }
}
