import BaseSnippet from '@/story/snippets/BaseSnippet'
import type { SnippetByType } from '@/story/types'

export default class TalkSnippet extends BaseSnippet<SnippetByType<'Talk'>> {
  protected async handle(): Promise<void> {
    const { speaker, content, model, voice } = this.snippet.data

    await this.runtime.scene.showDialogue({
      speaker,
      content,
      modelKey: model,
      voiceKey: voice
    })
  }
}
