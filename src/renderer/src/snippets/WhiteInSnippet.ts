import BaseSnippet from './BaseSnippet'

export default class WhiteInSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'WhiteIn') return

    await this.app.layerSpecialEffect.whiteIn(this.data.data.duration)
  }
}