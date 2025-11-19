import { AlphaFilter, Text, TextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

export default class UIText extends Text {
  public data: string = ''

  constructor(screen_width: number, screen_height: number) {
    const x = screen_width / 8

    const style = new TextStyle({
      align: 'left',
      fill: '#FFFFFFF5',
      fontFamily: 'Source Han Sans SC',
      fontSize: screen_height / 26,
      lineHeight: screen_height / 19,
      stroke: '#4A4968D9',
      strokeThickness: screen_height / 120,
      wordWrap: true,
      wordWrapWidth: screen_width - x * 2
    })
    super('', style)

    this.x = x
    this.y = screen_height / 1.27

    const alpha_filter = new AlphaFilter(0)
    alpha_filter.resolution = 2
    this.filters = [alpha_filter]
  }

  public async show(time: number): Promise<void> {
    this.visible = true
    await AnimationManager.linear((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = progress
    }, time)
  }

  public async hide(time: number): Promise<void> {
    await AnimationManager.linear((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = 1 - progress
    }, time)
    this.visible = false
  }

  public async startDisplayContent(): Promise<void> {
    const contentLength = this.data.length
    const timeMS = contentLength * 70
    await AnimationManager.linear((progress) => {
      const charsToShow = Math.min(Math.floor(progress * contentLength), contentLength)
      this.text = this.data.substring(0, charsToShow)
    }, timeMS)
  }
}
