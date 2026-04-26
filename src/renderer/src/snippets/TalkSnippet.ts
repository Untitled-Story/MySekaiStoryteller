import AnimationManager from '../managers/AnimationManager'
import BaseSnippet from './BaseSnippet'

export default class TalkSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Talk') return

    this.app.layerUI.resetTalkData()
    this.app.layerUI.setTalkData(this.data.data.speaker, this.data.data.content)

    const hasVoice = this.data.data.voice !== ''
    const lipSyncEnable =
      this.app.runMode === 'preview' && this.data.data.modelId !== -1 && hasVoice

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
    } else if (this.app.runMode === 'render' && hasVoice) {
      const durationMs = this.app.getRenderVoiceDurationMs(this.data.data.voice)
      const startTimeMs = AnimationManager.now()

      this.app.addRenderAudioEvent({
        voice: this.data.data.voice,
        startTimeMs,
        durationMs,
        speaker: this.data.data.speaker,
        content: this.data.data.content
      })

      waits.push(AnimationManager.delay(durationMs))
    }

    waits.push(this.app.layerUI.startDisplayContent())

    await Promise.all(waits)
  }
}
