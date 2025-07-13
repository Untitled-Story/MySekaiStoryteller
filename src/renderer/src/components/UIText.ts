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
      fontSize: screen_height / 24,
      stroke: '#4A49688C',
      strokeThickness: screen_height / 105,
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
    await AnimationManager.run((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = progress
    }, time)
    this.visible = true
  }

  public async hide(time: number): Promise<void> {
    await AnimationManager.run((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = 1 - progress
    }, time)
    this.visible = false
  }

  public async startDisplayContent(): Promise<void> {
    const contentLength = this.data.length
    const timeMS = contentLength * 70
    await AnimationManager.run((progress) => {
      const charsToShow = Math.min(Math.floor(progress * contentLength), contentLength)
      this.text = this.data.substring(0, charsToShow)
    }, timeMS)
  }
}
