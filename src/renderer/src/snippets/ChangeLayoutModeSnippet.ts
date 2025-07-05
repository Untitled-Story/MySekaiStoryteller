import BaseSnippet from './BaseSnippet'
import { LayoutModes, SnippetData } from '../../../common/types/Story'

export default class ChangeLayoutModeSnippet extends BaseSnippet {
  async handleSnippet(snippet: SnippetData): Promise<void> {
    if (snippet.type !== 'ChangeLayoutMode') {
      return
    }

    this.app.layerModel.layoutMode = LayoutModes[snippet.data]
  }
}
