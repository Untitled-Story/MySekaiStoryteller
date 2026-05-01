import BaseSnippet from './BaseSnippet'

export default class WhiteOutSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'WhiteOut') return

    await this.app.layerSpecialEffect.whiteOut(this.data.data.duration)
  }
}
