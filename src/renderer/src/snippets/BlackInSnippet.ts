import BaseSnippet from './BaseSnippet'

export default class BlackInSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'BlackIn') return

    await this.app.layerSpecialEffect.blackIn(this.data.data.duration)
  }
}
