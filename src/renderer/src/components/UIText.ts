import { AlphaFilter, HTMLText, HTMLTextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

export default class UIText extends HTMLText {
  private units: string[] = []
  private visibleIndexMap: number[] = []
  private totalVisibleChars = 0

  public set data(value: string) {
    const formatted = this.formatRichText(value)
    const { units, visibleIndexMap, totalVisibleChars } = this.computeUnits(formatted)
    this.units = units
    this.visibleIndexMap = visibleIndexMap
    this.totalVisibleChars = totalVisibleChars
    this.text = ''
  }

  private formatRichText(text: string): string {
    return text
      .replace(/<color:#([0-9A-Fa-f]{3,6})>(.*?)<\/color>/g, '<span style="color: #$1">$2</span>')
      .replace(/\r?\n/g, '<br>')
  }

  private computeUnits(text: string): {
    units: string[]
    visibleIndexMap: number[]
    totalVisibleChars: number
  } {
    const units: string[] = []
    let i = 0
    const len = text.length

    while (i < len) {
      if (text[i] === '<') {
        const end = text.indexOf('>', i)
        if (end === -1) break
        units.push(text.slice(i, end + 1))
        i = end + 1
      } else {
        units.push(text[i])
        i++
      }
    }

    const visibleIndexMap: number[] = []
    let visibleCount = 0

    for (let j = 0; j < units.length; j++) {
      if (!units[j].startsWith('<')) visibleCount++
      visibleIndexMap[visibleCount] = j
    }

    return { units, visibleIndexMap, totalVisibleChars: visibleCount }
  }

  constructor(screenWidth: number, screenHeight: number) {
    const x = screenWidth / 8
    const style = new HTMLTextStyle({
      align: 'left',
      fill: '#FFFFFFF5',
      fontFamily: 'Source Han Sans SC',
      fontWeight: '500',
      fontSize: screenHeight / 26,
      lineHeight: screenHeight / 19,
      stroke: '#4A4968D9',
      strokeThickness: screenHeight / 120,
      wordWrap: true,
      wordWrapWidth: screenWidth - x * 2
    })

    style.stylesheet =
      'red    { color: #FF6584; }\n' +
      'blue   { color: #7CA9FF; }\n' +
      'green  { color: #6EE8A0; }\n' +
      'yellow { color: #FFD88A; }\n' +
      'purple { color: #B49BFF; }\n'

    super('', style)

    this.x = x
    this.y = screenHeight / 1.27

    const alphaFilter = new AlphaFilter(0)
    alphaFilter.resolution = 2
    this.filters = [alphaFilter]
  }

  public async show(time: number): Promise<void> {
    this.visible = true
    await AnimationManager.linear((progress) => {
      const alphaFilter = this.filters![0] as AlphaFilter
      alphaFilter.alpha = progress
    }, time)
  }

  public async hide(time: number): Promise<void> {
    await AnimationManager.linear((progress) => {
      const alphaFilter = this.filters![0] as AlphaFilter
      alphaFilter.alpha = 1 - progress
    }, time)
    this.visible = false
  }

  public async startDisplayContent(): Promise<void> {
    const units = this.units
    const visibleIndexMap = this.visibleIndexMap
    const totalVisible = this.totalVisibleChars

    let currentText = ''
    let lastUnitIndex = 0
    let lastVisibleCount = 0
    const duration = totalVisible * 70

    await AnimationManager.linear(
      (progress) => {
        const visibleCount = progress >= 1 ? totalVisible : Math.floor(progress * totalVisible)
        if (visibleCount > lastVisibleCount) {
          const targetUnitIndex = visibleIndexMap[visibleCount]
          for (let i = lastUnitIndex; i <= targetUnitIndex; i++) {
            currentText += units[i]
          }
          this.text = currentText
          lastUnitIndex = targetUnitIndex + 1
          lastVisibleCount = visibleCount
        }
      },
      duration,
      true
    )

    this.text = units.join('')
  }
}
