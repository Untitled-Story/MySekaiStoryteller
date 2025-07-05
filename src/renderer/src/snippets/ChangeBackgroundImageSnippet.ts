import { SnippetData } from '../../../common/types/Story'
import BaseSnippet from './BaseSnippet'

export default class ChangeBackgroundImageSnippet extends BaseSnippet {
  async handleSnippet(snippet: SnippetData): Promise<void> {
    if (snippet.type !== 'ChangeBackgroundImage') {
      return
    }

    this.app.layerBackground.setBackground(this.app.getTextureById(snippet.data))
  }
}
