import BaseSnippet from './BaseSnippet'

export default class BlackOutSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'BlackOut') return

    await this.app.layerSpecialEffect.blackOut(this.data.data.time)
  }
}
