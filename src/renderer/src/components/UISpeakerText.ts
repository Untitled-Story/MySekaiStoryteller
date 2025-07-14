import { AlphaFilter, Text, TextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

export default class UISpeakerText extends Text {
  constructor(screen_width: number, screen_height: number, y: number) {
    const x = screen_width / 9

    const style = new TextStyle({
      align: 'left',
      fill: '#FFFFFFF5',
      fontFamily: 'Source Han Sans SC',
      fontSize: screen_height / 20.5,
      fontWeight: '600',
      stroke: '#4A49688C',
      strokeThickness: screen_height / 105
    })
    super('', style)

    this.x = x
    this.y = y

    const alpha_filter = new AlphaFilter(0)
    alpha_filter.resolution = 2
    this.filters = [alpha_filter]
  }

  public async show(time: number): Promise<void> {
    this.visible = true
    await AnimationManager.run((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = progress
    }, time)
  }

  public async hide(time: number): Promise<void> {
    await AnimationManager.run((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = 1 - progress
    }, time)
    this.visible = false
  }
}
