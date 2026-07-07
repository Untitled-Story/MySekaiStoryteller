import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class MoveSnippet extends BaseSnippet<SnippetByType<'Move'>> {
  protected async handle(): Promise<void> {
    const { model, from, to, moveSpeed } = this.snippet.data

    await this.runtime.scene.moveModel({
      modelKey: model,
      from,
      to,
      moveSpeed
    })
  }
}
