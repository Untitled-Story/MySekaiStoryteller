import BaseLayer from './BaseLayer'
import { Application, Texture } from 'pixi.js'
import ui_text_background from '../../assets/ui/ui_text_background.svg'
import ui_text_underline from '../../assets/ui/ui_text_underline.svg'
import UITextBackground from '../components/UITextBackground'
import UITextUnderline from '../components/UITextUnderline'
import UIText from '../components/UIText'
import UISpeakerText from '../components/UISpeakerText'

export default class UILayer extends BaseLayer {
  private readonly textBackgroundSprite!: UITextBackground
  private readonly textUnderlineSprite!: UITextUnderline
  private readonly textSprite!: UIText
  private readonly textSpeakerSprite!: UISpeakerText

  private _UITalkShowed: boolean = false

  constructor(app: Application) {
    super(app, 2)
    const textBackgroundTexture = Texture.from(ui_text_background)
    const textUnderlineTexture = Texture.from(ui_text_underline)

    this.textBackgroundSprite = new UITextBackground(
      textBackgroundTexture,
      this.app.screen.width,
      this.app.screen.height
    )
    this.textUnderlineSprite = new UITextUnderline(
      textUnderlineTexture,
      this.app.screen.width,
      this.app.screen.height
    )
    this.textSprite = new UIText(this.app.screen.width, this.app.screen.height)
    this.textSpeakerSprite = new UISpeakerText(
      this.app.screen.width,
      this.app.screen.height,
      this.textUnderlineSprite.y - this.app.screen.width / 34.5
    )

    this.layerContainer.addChild(this.textBackgroundSprite)
    this.layerContainer.addChild(this.textUnderlineSprite)
    this.layerContainer.addChild(this.textSprite)
    this.layerContainer.addChild(this.textSpeakerSprite)
  }

  public resetTalkData(): void {
    this.textSpeakerSprite.text = ''
    this.textSprite.text = ''
    this.textSprite.data = ''
  }

  public setTalkData(speaker: string, content: string): void {
    this.textSpeakerSprite.text = speaker
    this.textSprite.data = content
  }

  public async showTextBackground(): Promise<void> {
    this._UITalkShowed = true
    await Promise.all([
      this.textBackgroundSprite.show(70),
      this.textUnderlineSprite.show(70),
      this.textSprite.show(70),
      this.textSpeakerSprite.show(70)
    ])
  }

  public async startDisplayContent(): Promise<void> {
    await this.textSprite.startDisplayContent()
  }

  public async hideTextBackground(): Promise<void> {
    this._UITalkShowed = true
    await Promise.all([
      this.textBackgroundSprite.hide(70),
      this.textUnderlineSprite.hide(70),
      this.textSprite.hide(70),
      this.textSpeakerSprite.hide(70)
    ])
  }

  get UITalkShowed(): boolean {
    return this._UITalkShowed
  }
}
