import { Snippet } from '../snippets/Snippet'
import { App } from '../app/App'
import ChangeBackgroundImageSnippet from '../snippets/ChangeBackgroundImageSnippet'
import { SnippetData } from '../../../common/types/Story'
import ChangeLayoutModeSnippet from '../snippets/ChangeLayoutModeSnippet'
import LayoutAppearSnippet from '../snippets/LayoutAppearSnippet'

export default class SnippetStrategyManager {
  private readonly app: App
  private readonly snippets!: { [key: string]: Snippet }

  constructor(app: App) {
    this.app = app
    this.snippets = {
      ChangeBackgroundImage: new ChangeBackgroundImageSnippet(this.app),
      ChangeLayoutMode: new ChangeLayoutModeSnippet(this.app),
      LayoutAppear: new LayoutAppearSnippet(this.app)
    }
  }

  async handleSnippet(data: SnippetData): Promise<void> {
    const snippet = this.snippets[data.type]
    if (snippet) {
      await snippet.handleSnippet(data)
    } else {
      throw new TypeError(`Not implemented ${data.type}`)
    }
  }
}
