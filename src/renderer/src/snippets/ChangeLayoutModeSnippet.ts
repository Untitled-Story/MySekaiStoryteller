import { LayoutModes } from '../../../common/types/Story'
import BaseSnippet from './BaseSnippet'

export default class ChangeLayoutModeSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'ChangeLayoutMode') return

    this.app.layerModel.layoutMode = LayoutModes[this.data.data.mode]
  }
}
