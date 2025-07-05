import { Snippet } from './Snippet'
import { App } from '../app/App'
import { SnippetData } from '../../../common/types/Story'

export default abstract class BaseSnippet implements Snippet {
  protected readonly app: App
  protected data!: SnippetData

  constructor(app: App) {
    this.app = app
  }

  initializeData(data: SnippetData): void {
    this.data = data
  }

  async runSnippet(data: SnippetData): Promise<void> {
    this.initializeData(data)

    await this.handleSnippet()
  }

  abstract handleSnippet(): Promise<void>
}
