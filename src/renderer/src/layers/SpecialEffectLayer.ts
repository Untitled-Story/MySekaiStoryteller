import BaseLayer from './BaseLayer'
import { Application, Texture } from 'pixi.js'
import ui_se_black from '../../assets/ui/ui_se_black.svg'
import ui_se_white from '../../assets/ui/ui_se_white.svg'
import SEBlack from '../components/SEBlack'
import SEWhite from '../components/SEWhite'

export default class SpecialEffectLayer extends BaseLayer {
  private readonly seBlackSprite!: SEBlack
  private readonly seWhiteSprite!: SEWhite

  constructor(app: Application) {
    super(app, 3)

    const sfBlackTexture = Texture.from(ui_se_black)
    this.seBlackSprite = new SEBlack(sfBlackTexture, this.app.screen.width, this.app.screen.height)

    const sfWhiteTexture = Texture.from(ui_se_white)
    this.seWhiteSprite = new SEWhite(sfWhiteTexture, this.app.screen.width, this.app.screen.height)

    this.layerContainer.addChild(this.seBlackSprite)
    this.layerContainer.addChild(this.seWhiteSprite)
  }

  public async blackOut(duration: number): Promise<void> {
    await this.seBlackSprite.show(duration)
  }

  public async blackIn(duration: number): Promise<void> {
    await this.seBlackSprite.hide(duration)
  }

  public async whiteOut(duration: number): Promise<void> {
    await this.seWhiteSprite.show(duration)
  }

  public async whiteIn(duration: number): Promise<void> {
    await this.seWhiteSprite.hide(duration)
  }
}
