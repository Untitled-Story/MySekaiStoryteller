import BaseLayer from './BaseLayer'
import { Application, Texture } from 'pixi.js'
import ui_text_background from '../../assets/ui/ui_text_background.svg'
import ui_text_underline from '../../assets/ui/ui_text_underline.svg'
import ui_telop from '../../assets/ui/ui_telop.svg'
import UITextBackground from '../components/UITextBackground'
import UITextUnderline from '../components/UITextUnderline'
import UIText from '../components/UIText'
import UISpeakerText from '../components/UISpeakerText'
import UITelop from '../components/UITelop'
import AnimationManager from '../managers/AnimationManager'

export default class UILayer extends BaseLayer {
  private readonly textBackgroundSprite!: UITextBackground
  private readonly textUnderlineSprite!: UITextUnderline
  private readonly textSprite!: UIText
  private readonly textSpeakerSprite!: UISpeakerText
  private readonly telopContainer!: UITelop

  private _UITalkShowed: boolean = false

  constructor(app: Application) {
    super(app, 2)
    const textBackgroundTexture = Texture.from(ui_text_background)
    const textUnderlineTexture = Texture.from(ui_text_underline)
    const telopTexture = Texture.from(ui_telop)

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
    this.telopContainer = new UITelop(telopTexture, this.app.screen.width, this.app.screen.height)

    this.layerContainer.addChild(this.textBackgroundSprite)
    this.layerContainer.addChild(this.textUnderlineSprite)
    this.layerContainer.addChild(this.textSprite)
    this.layerContainer.addChild(this.textSpeakerSprite)
    this.layerContainer.addChild(this.telopContainer)
  }

  public async telop(text: string): Promise<void> {
    this.telopContainer.text = text
    await this.telopContainer.show(200)
    await AnimationManager.delay(2000)
    await this.telopContainer.hide(200)
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
