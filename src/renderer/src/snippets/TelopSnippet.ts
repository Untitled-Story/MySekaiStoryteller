import BaseSnippet from './BaseSnippet'

export default class TelopSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Telop') return

    await this.app.layerUI.telop(this.data.data.content)
  }
}
