import AnimatedSnippet from './AnimatedSnippet'

export default class TalkSnippet extends AnimatedSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Talk') return

    this.app.layerUI.resetTalkData()
    this.app.layerUI.setTalkData(this.data.data.speaker, this.data.data.content)

    if (!this.app.layerUI.UITalkShowed) {
      await this.app.layerUI.showTextBackground()
      await this.app.layerUI.startDisplayContent()
    } else {
      await this.app.layerUI.startDisplayContent()
    }
  }
}
