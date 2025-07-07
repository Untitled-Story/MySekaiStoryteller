import BaseSnippet from './BaseSnippet'
import AnimationManager from '../managers/AnimationManager'

export default abstract class AnimatedSnippet extends BaseSnippet {
  async runSnippet(): Promise<void> {
    await this.runDelay()
    await this.handleSnippet()
  }

  async runDelay(): Promise<void> {
    if (typeof this.data.data === 'object' && 'delay' in this.data.data) {
      await AnimationManager.delay(this.data.data.delay as number)
    } else {
      throw Error('No delay provided.')
    }
  }
}
