import '@pixi/unsafe-eval'
import * as PIXI from 'pixi.js'
import getSubLogger from '../utils/logger'
import { ILogObj, Logger } from 'tslog'
import { SelectStoryResponse } from '../../../common/types/ipc_response'
import StoryManager from '../managers/story_manager'
import { Live2DModelMap, TextureMap } from '../types/asset_map'
import BackgroundLayer from '../layers/background'

class App {
  private readonly logger: Logger<ILogObj> = getSubLogger('App')
  private applicationWrapper!: HTMLDivElement
  private pixiApplication!: PIXI.Application
  private storyManager!: StoryManager

  private models: Live2DModelMap[] = []
  private textures: TextureMap[] = []

  private layerBackground!: BackgroundLayer

  private async selectStoryFile(): Promise<SelectStoryResponse> {
    const selectResult: SelectStoryResponse = await window.electron.ipcRenderer.invoke(
      'electron:select-story-file-until-selected'
    )

    if (!selectResult.success) {
      if (selectResult.zodIssueMessage) {
        throw new Error(selectResult.zodIssueMessage)
      } else {
        throw selectResult.error
      }
    }

    return selectResult
  }

  private async selectStoryFileUntilSuccess(): Promise<SelectStoryResponse> {
    let selectResult: SelectStoryResponse

    let selectFileValid = false
    while (!selectFileValid) {
      try {
        selectResult = await this.selectStoryFile()
        selectFileValid = true
      } catch (error) {
        this.logger.error(error)
      }
    }

    return selectResult!
  }

  private async initializeStoryManager(): Promise<void> {
    const story: SelectStoryResponse = await this.selectStoryFileUntilSuccess()
    this.storyManager = new StoryManager(story)

    this.logger.info(`StoryManager initialized, root path: ${this.storyManager.storyFolder}`)
  }

  private initializeRenderer(): void {
    const selectFileTipsElement = document.getElementById('select-file-tips')! as HTMLHeadingElement
    this.applicationWrapper = document.getElementById('app')! as HTMLDivElement

    this.pixiApplication = new PIXI.Application({
      background: 0xffffff,
      resizeTo: this.applicationWrapper,
      autoDensity: true,
      antialias: true,
      resolution: window.devicePixelRatio || 1
    })

    selectFileTipsElement.remove()
    this.applicationWrapper.appendChild(this.pixiApplication.view as HTMLCanvasElement)

    this.pixiApplication.stage.sortableChildren = true

    this.logger.info('Render initialized')
  }

  private async preloadStoryAssets(): Promise<void> {
    this.models = await this.storyManager.preloadModels()
    this.logger.info(`Loaded ${this.models.length} models`)

    this.textures = await this.storyManager.preloadImages()
    this.logger.info(`Loaded ${this.textures.length} textures`)

    this.logger.info('Preloaded story assets')
  }

  private prepareStory(): void {
    this.layerBackground = new BackgroundLayer(this.pixiApplication)
  }

  private getTextureById(id: number): PIXI.Texture {
    const data = this.textures

    return data.find((image) => image.id === id)!.image
  }

  private async readUntilFinish(): Promise<void> {
    const snippets = this.storyManager.snippets

    for (const snippet of snippets) {
      this.logger.info(`Snippet: ${snippet.type}`)
      switch (snippet.type) {
        case 'ChangeBackgroundImage': {
          this.layerBackground.setBackground(this.getTextureById(snippet.data))
          break
        }
      }
    }
  }

  public async run(): Promise<void> {
    await this.initializeStoryManager()
    this.initializeRenderer()
    await this.preloadStoryAssets()
    this.prepareStory()
    await this.readUntilFinish()
  }
}

async function main(): Promise<void> {
  const app = new App()
  await app.run()
}

export default main
