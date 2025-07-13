import BaseSnippet from './BaseSnippet'

export default class HideTalkSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'HideTalk') return

    await this.app.layerUI.hideTextBackground()
  }
}
