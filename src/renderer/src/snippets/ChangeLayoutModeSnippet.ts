import BaseSnippet from './BaseSnippet'
import { LayoutModes } from '../../../common/types/Story'

export default class ChangeLayoutModeSnippet extends BaseSnippet {
  async handleSnippet(): Promise<void> {
    if (this.data.type !== 'ChangeLayoutMode') return

    this.app.layerModel.layoutMode = LayoutModes[this.data.data]
  }
}
