import { Snippet } from './Snippet'
import { App } from '../app/App'
import { SnippetData } from '../../../common/types/Story'
import AnimationManager from '../managers/AnimationManager'

export default abstract class BaseSnippet implements Snippet {
  protected readonly app: App
  protected data!: SnippetData

  constructor(app: App, data: SnippetData) {
    this.app = app
    this.data = data
  }

  async runSnippet(): Promise<void> {
    await this.runDelay()
    await this.handleSnippet()
  }

  async runDelay(): Promise<void> {
    await AnimationManager.delay(this.data.delay)
  }

  protected abstract handleSnippet(): Promise<void>
}
