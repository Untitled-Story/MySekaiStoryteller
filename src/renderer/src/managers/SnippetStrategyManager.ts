import { Snippet } from '../snippets/Snippet'
import { App } from '../app/App'
import ChangeBackgroundImageSnippet from '../snippets/ChangeBackgroundImageSnippet'
import { SnippetData } from '../../../common/types/Story'
import ChangeLayoutModeSnippet from '../snippets/ChangeLayoutModeSnippet'
import LayoutAppearSnippet from '../snippets/LayoutAppearSnippet'
import { ILogObj, Logger } from 'tslog'
import getSubLogger from '../utils/Logger'
import LayoutClearSnippet from '../snippets/LayoutClearSnippet'
import TalkSnippet from '../snippets/TalkSnippet'
import HideTalkSnippet from '../snippets/HideTalkSnippet'
import MoveSnippet from '../snippets/MoveSnippet'

export default class SnippetStrategyManager {
  private readonly app: App
  private readonly logger: Logger<ILogObj> = getSubLogger('SnippetStrategyManager')
  private readonly snippets!: { [key: string]: new (app: App, data: SnippetData) => Snippet }

  constructor(app: App) {
    this.app = app
    this.snippets = {
      ChangeBackgroundImage: ChangeBackgroundImageSnippet,
      ChangeLayoutMode: ChangeLayoutModeSnippet,
      LayoutAppear: LayoutAppearSnippet,
      LayoutClear: LayoutClearSnippet,
      Talk: TalkSnippet,
      HideTalk: HideTalkSnippet,
      Move: MoveSnippet
    }
  }

  async handleSnippet(data: SnippetData): Promise<void> {
    const snippetConstructor = this.snippets[data.type]
    if (snippetConstructor) {
      const snippet = new snippetConstructor(this.app, data)

      if (data.wait) {
        await snippet.runSnippet()
      } else {
        snippet.runSnippet().catch(this.logger.error)
      }
    } else {
      throw new TypeError(`Not implemented ${data.type}`)
    }
  }
}
