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
    const showDuration = 70
    await Promise.all([
      this.textBackgroundSprite.show(showDuration),
      this.textUnderlineSprite.show(showDuration),
      this.textSprite.show(showDuration),
      this.textSpeakerSprite.show(showDuration)
    ])
  }

  public async startDisplayContent(): Promise<void> {
    await this.textSprite.startDisplayContent()
  }

  public async hideTextBackground(): Promise<void> {
    this._UITalkShowed = true
    const hideDuration = 100
    await Promise.all([
      this.textBackgroundSprite.hide(hideDuration),
      this.textUnderlineSprite.hide(hideDuration),
      this.textSprite.hide(hideDuration),
      this.textSpeakerSprite.hide(hideDuration)
    ])
  }

  get UITalkShowed(): boolean {
    return this._UITalkShowed
  }
}
