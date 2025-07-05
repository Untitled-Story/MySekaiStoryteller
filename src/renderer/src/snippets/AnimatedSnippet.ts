import BaseSnippet from './BaseSnippet'
import { SnippetData } from '../../../common/types/Story'
import AnimationManager from '../managers/AnimationManager'

export default abstract class AnimatedSnippet extends BaseSnippet {
  async runSnippet(data: SnippetData): Promise<void> {
    this.initializeData(data)

    await this.handleSnippet()
    await this.runDelay()
  }

  async runDelay(): Promise<void> {
    if (typeof this.data.data === 'object' && 'delay' in this.data.data) {
      await AnimationManager.delay(this.data.data.delay as number)
    } else {
      throw Error('No delay provided.')
    }
  }
}
