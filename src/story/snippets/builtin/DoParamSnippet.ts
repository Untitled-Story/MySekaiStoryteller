import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class DoParamSnippet extends BaseSnippet<SnippetByType<'DoParam'>> {
  protected async handle(): Promise<void> {
    const { model, params } = this.snippet.data

    await this.runtime.scene.setModelParameters({
      modelKey: model,
      params
    })
  }
}
