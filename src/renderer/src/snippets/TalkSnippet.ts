import BaseSnippet from './BaseSnippet'

export default class TalkSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Talk') return

    this.app.layerUI.resetTalkData()
    this.app.layerUI.setTalkData(this.data.data.speaker, this.data.data.content)

    const lipSyncEnable = this.data.data.modelId !== -1 && this.data.data.voice !== ''

    if (!this.app.layerUI.UITalkShowed) {
      await this.app.layerUI.showTextBackground()
    }

    const waits: Promise<unknown>[] = []

    if (lipSyncEnable) {
      const model = this.app.getModelById(this.data.data.modelId)

      const speak_task = new Promise<void>((resolve) => {
        if (this.data.type !== 'Talk') return

        model.speak(this.app.getVoiceByName(this.data.data.voice), {
          volume: 0.5,
          onFinish: resolve
        })
      })

      waits.push(speak_task)
    }

    waits.push(this.app.layerUI.startDisplayContent())

    await Promise.all(waits)
  }
}
