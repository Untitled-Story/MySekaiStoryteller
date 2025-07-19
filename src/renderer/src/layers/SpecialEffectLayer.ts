import BaseLayer from './BaseLayer'
import { Application, Texture } from 'pixi.js'
import ui_se_black from '../../assets/ui/ui_se_black.svg'
import SEBlack from '../components/SEBlack'

export default class SpecialEffectLayer extends BaseLayer {
  private readonly seBlackSprite!: SEBlack

  constructor(app: Application) {
    super(app, 3)

    const sfBlackTexture = Texture.from(ui_se_black)
    this.seBlackSprite = new SEBlack(sfBlackTexture, this.app.screen.width, this.app.screen.height)

    this.layerContainer.addChild(this.seBlackSprite)
  }

  public async blackOut(time: number): Promise<void> {
    await this.seBlackSprite.show(time)
  }

  public async blackIn(time: number): Promise<void> {
    await this.seBlackSprite.hide(time)
  }
}
