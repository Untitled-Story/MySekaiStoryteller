import BaseSnippet from './BaseSnippet'

export default class ChangeBackgroundImageSnippet extends BaseSnippet {
  async handleSnippet(): Promise<void> {
    if (this.data.type !== 'ChangeBackgroundImage') return

    this.app.layerBackground.setBackground(this.app.getTextureById(this.data.data))
  }
}
