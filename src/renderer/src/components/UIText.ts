import { AlphaFilter, HTMLText, HTMLTextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

export default class UIText extends HTMLText {
  private _data: string = ''

  public get data(): string {
    return this._data
  }

  public set data(value: string) {
    this._data = this.replaceColorTags(value)
  }

  private replaceColorTags(text: string): string {
    return text.replace(
      /<color:#([0-9A-Fa-f]{3,6})>(.*?)<\/color>/g,
      '<span style="color: #$1">$2</span>'
    )
  }

  constructor(screen_width: number, screen_height: number) {
    const x = screen_width / 8

    const style = new HTMLTextStyle({
      align: 'left',
      fill: '#FFFFFFF5',
      fontFamily: 'Source Han Sans SC',
      fontWeight: '500',
      fontSize: screen_height / 26,
      lineHeight: screen_height / 19,
      stroke: '#4A4968D9',
      strokeThickness: screen_height / 120,
      wordWrap: true,
      wordWrapWidth: screen_width - x * 2
    })
    style.stylesheet =
      'red    { color: #FF6584; }\n' +
      'blue   { color: #7CA9FF; }\n' +
      'green  { color: #6EE8A0; }\n' +
      'yellow { color: #FFD88A; }\n' +
      'purple { color: #B49BFF; }\n'
    super('', style)

    this.x = x
    this.y = screen_height / 1.27

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

  private getTagRanges(text: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = []
    let i = 0
    const total = text.length
    while (i < total) {
      if (text.startsWith('<', i)) {
        const nextCharIndex = i + 1
        if (nextCharIndex >= total) {
          i++
          continue
        }
        const nextChar = text[nextCharIndex]
        if (nextChar === ' ' || !/[a-zA-Z/]/.test(nextChar)) {
          i++
          continue
        }
        const end = text.indexOf('>', i)
        if (end === -1) break
        ranges.push([i, end])
        i = end + 1
      } else {
        i++
      }
    }
    return ranges
  }

  private getValidLength(text: string, tagRanges: Array<[number, number]>): number {
    let length = 0
    let pos = 0
    let tagIndex = 0
    const total = text.length
    while (pos < total) {
      if (tagIndex < tagRanges.length && pos === tagRanges[tagIndex][0]) {
        length++
        pos = tagRanges[tagIndex][1] + 1
        tagIndex++
      } else {
        length++
        pos++
      }
    }
    return length
  }

  private getCurrentCount(
    validCount: number,
    text: string,
    tagRanges: Array<[number, number]>
  ): number {
    if (validCount === 0) return 0
    let count = 0
    let currentValid = 0
    let pos = 0
    let tagIndex = 0
    const total = text.length
    while (currentValid < validCount && pos < total) {
      if (tagIndex < tagRanges.length && pos === tagRanges[tagIndex][0]) {
        currentValid++
        count = tagRanges[tagIndex][1] + 1
        pos = count
        tagIndex++
      } else {
        currentValid++
        pos++
        count = pos
      }
    }
    return validCount === this.getValidLength(text, tagRanges) ? total : count
  }

  public async startDisplayContent(): Promise<void> {
    const text = this.data
    const tagRanges = this.getTagRanges(text)
    const validLength = this.getValidLength(text, tagRanges)
    let lastCount = -1

    await AnimationManager.run((progress) => {
      const validCount = progress >= 1 ? validLength : Math.floor(progress * validLength)
      const count = this.getCurrentCount(validCount, text, tagRanges)

      if (count !== lastCount) {
        this.text = text.substring(0, count)
        lastCount = count
      }
    }, validLength * 70)
  }
}
