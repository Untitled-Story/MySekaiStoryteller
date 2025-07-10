import BaseLayer from './BaseLayer'
import { Application, Texture } from 'pixi.js'
import ui_text_background from '../../assets/ui/ui_text_background.svg'
import UITextBackground from '../components/UITextBackground'

export default class UILayer extends BaseLayer {
  private readonly textBackgroundSprite!: UITextBackground

  constructor(app: Application) {
    super(app)
    const textBackgroundTexture = Texture.from(ui_text_background)

    this.textBackgroundSprite = new UITextBackground(
      textBackgroundTexture,
      this.app.screen.width,
      this.app.screen.height
    )
  }

  public async showTextBackground(): Promise<void> {
    this.stage.addChild(this.textBackgroundSprite)
    await this.textBackgroundSprite.show(100)
  }
}
