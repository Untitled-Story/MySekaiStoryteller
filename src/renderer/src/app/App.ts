import '@pixi/unsafe-eval'
import getSubLogger from '../utils/Logger'
import { ILogObj, Logger } from 'tslog'
import { SelectStoryResponse } from '../../../common/types/IpcResponse'
import StoryManager from '../managers/StoryManager'
import { Live2DModelMap, TextureMap } from '../types/AssetMap'
import BackgroundLayer from '../layers/BackgroundLayer'
import ModelLayer from '../layers/ModelLayer'
import AdvancedModel from '../model/AdvancedModel'
import SnippetStrategyManager from '../managers/SnippetStrategyManager'
import UILayer from '../layers/UILayer'
import FontFaceObserver from 'fontfaceobserver'
import { Application, Texture } from 'pixi.js'

export class App {
  public readonly logger: Logger<ILogObj> = getSubLogger('App')
  public pixiApplication!: Application
  public storyManager!: StoryManager
  public snippetStrategyManager!: SnippetStrategyManager
  private applicationWrapper!: HTMLDivElement

  public layerBackground!: BackgroundLayer
  public layerModel!: ModelLayer
  public layerUI!: UILayer

  public stage_size!: [number, number]

  private models: Live2DModelMap[] = []
  private textures: TextureMap[] = []

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

  private async initializeManagers(): Promise<void> {
    const story: SelectStoryResponse = await this.selectStoryFileUntilSuccess()
    this.storyManager = new StoryManager(story)

    this.logger.info(`StoryManager initialized, root path: ${this.storyManager.storyFolder}`)

    this.snippetStrategyManager = new SnippetStrategyManager(this)
  }

  private initializeRenderer(): void {
    const selectFileTipsElement = document.getElementById('select-file-tips')! as HTMLHeadingElement
    this.applicationWrapper = document.getElementById('app')! as HTMLDivElement

    this.pixiApplication = new Application({
      background: 0xffffff,
      resizeTo: this.applicationWrapper,
      autoDensity: true,
      antialias: true,
      resolution: window.devicePixelRatio || 1
    })

    selectFileTipsElement.remove()
    this.applicationWrapper.appendChild(this.pixiApplication.view as HTMLCanvasElement)

    this.pixiApplication.stage.sortableChildren = true

    this.stage_size = [this.pixiApplication.screen.width, this.pixiApplication.screen.height]

    this.logger.info('Render initialized')
  }

  private async preloadStoryAssets(): Promise<void> {
    this.models = await this.storyManager.preloadModels()
    this.logger.info(`Loaded ${this.models.length} models`)

    this.textures = await this.storyManager.preloadImages()
    this.logger.info(`Loaded ${this.textures.length} textures`)

    await new FontFaceObserver('Source Han Sans SC', {}).load()
    this.logger.info(`Loaded fonts.`)

    this.logger.info('Preloaded story assets')
  }

  private initializeLayers(): void {
    this.layerBackground = new BackgroundLayer(this.pixiApplication)
    this.layerModel = new ModelLayer(this.pixiApplication)
    this.layerUI = new UILayer(this.pixiApplication)
  }

  private async readUntilFinish(): Promise<void> {
    const snippets = this.storyManager.snippets

    for (const snippet of snippets) {
      this.logger.info(`Snippet: ${snippet.type}`)

      await this.snippetStrategyManager.handleSnippet(snippet)
    }
  }

  public getTextureById(id: number): Texture {
    const data = this.textures

    return data.find((image) => image.id === id)!.image
  }

  public getModelById(id: number): AdvancedModel {
    const data = this.models

    return data.find((model) => model.id === id)!.model
  }

  public async run(): Promise<void> {
    await this.initializeManagers()
    this.initializeRenderer()
    await this.preloadStoryAssets()
    this.initializeLayers()
    await this.readUntilFinish()
  }
}

async function main(): Promise<void> {
  const app = new App()
  await app.run()
}

export default main
