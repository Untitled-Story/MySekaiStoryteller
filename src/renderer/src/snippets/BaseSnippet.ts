import { Snippet } from './Snippet'
import { App } from '../app/App'
import { SnippetData } from '../../../common/types/Story'

export default abstract class BaseSnippet implements Snippet {
  protected readonly app: App

  constructor(app: App) {
    this.app = app
  }

  abstract handleSnippet(data: SnippetData): Promise<void>
}
