import { AlphaFilter, HTMLText, HTMLTextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

export default class UIText extends HTMLText {
  private _data: string = ''

  public get data(): string {
    return this._data
  }

  public set data(value: string) {
    this._data = this.formatRichText(value)
  }

  private formatRichText(text: string): string {
    return text
      .replace(/<color:#([0-9A-Fa-f]{3,6})>(.*?)<\/color>/g, '<span style="color: #$1">$2</span>')
      .replace(/\r?\n/g, '<br>')
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
    await AnimationManager.linear((progress: number) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = progress
    }, time)
  }

  public async hide(time: number): Promise<void> {
    await AnimationManager.linear((progress: number) => {
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

  public async startDisplayContent(): Promise<void> {
    const text: string = this.data
    const tagRanges: Array<[number, number]> = this.getTagRanges(text)
    const units: string[] = []
    let pos = 0
    let tagIndex = 0
    while (pos < text.length) {
      if (tagIndex < tagRanges.length && pos === tagRanges[tagIndex][0]) {
        const [start, end] = tagRanges[tagIndex]
        units.push(text.substring(start, end + 1))
        pos = end + 1
        tagIndex++
      } else {
        units.push(text[pos])
        pos++
      }
    }
    const totalUnits: number = units.length
    let lastCount: number = -1
    await AnimationManager.linear((progress: number) => {
      let count: number
      if (progress >= 1) {
        count = totalUnits
      } else {
        count = Math.min(Math.floor(progress * totalUnits), totalUnits - 1)
      }
      if (count !== lastCount) {
        this.text = units.slice(0, count).join('')
        lastCount = count
      }
    }, totalUnits * 70)
    this.text = units.join('')
  }
}
