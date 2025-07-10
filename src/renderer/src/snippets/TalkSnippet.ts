import AnimatedSnippet from './AnimatedSnippet'

export default class TalkSnippet extends AnimatedSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Talk') return

    await this.app.layerUI.showTextBackground()
  }
}
