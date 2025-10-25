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
import { Application, Texture, Ticker } from 'pixi.js'
import SpecialEffectLayer from '../layers/SpecialEffectLayer'
import { FIXED_FPS } from '../constants'
import { configureCubism4 } from 'pixi-live2d-display-advanced'

export class App {
  public readonly logger: Logger<ILogObj> = getSubLogger('App')
  public pixiApplication!: Application
  public storyManager!: StoryManager
  public snippetStrategyManager!: SnippetStrategyManager
  private applicationWrapper!: HTMLDivElement

  public layerBackground!: BackgroundLayer
  public layerModel!: ModelLayer
  public layerUI!: UILayer
  public layerSpecialEffect!: SpecialEffectLayer

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
        throw error
      }
    }

    return selectResult!
  }

  private async initializeManagers(story: SelectStoryResponse): Promise<void> {
    this.storyManager = new StoryManager(story)
    this.logger.info(`StoryManager initialized, root path: ${this.storyManager.storyFolder}`)

    this.snippetStrategyManager = new SnippetStrategyManager(this)
    this.logger.info('SnippetStrategyManager initialized')
  }

  private initializeRenderer(): void {
    this.applicationWrapper = document.getElementById('app')! as HTMLDivElement

    this.pixiApplication = new Application({
      backgroundColor: 0xffffff,
      resizeTo: this.applicationWrapper,
      autoDensity: true,
      antialias: true,
      resolution: window.devicePixelRatio || 1
    })

    // May it should be removed
    Ticker.shared.minFPS = FIXED_FPS
    Ticker.shared.maxFPS = FIXED_FPS

    this.applicationWrapper.appendChild(this.pixiApplication.view as HTMLCanvasElement)

    this.pixiApplication.stage.sortableChildren = true

    configureCubism4({
      memorySizeMB: 128
    })

    this.logger.info('Render initialized')
  }

  get stage_size(): [number, number] {
    return [this.pixiApplication.screen.width, this.pixiApplication.screen.height]
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
    this.layerSpecialEffect = new SpecialEffectLayer(this.pixiApplication)
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

  public getVoiceByName(name: string): string {
    return this.storyManager.geVoiceUrlByName(name)
  }

  private async runSnippets(story: SelectStoryResponse): Promise<void> {
    await this.initializeManagers(story)
    this.initializeRenderer()
    await this.preloadStoryAssets()
    this.initializeLayers()
    await this.readUntilFinish()
  }

  public async run(): Promise<void> {
    const selectFileTipsElement = document.getElementById('select-file-tips')! as HTMLHeadingElement
    const story: SelectStoryResponse = await this.selectStoryFileUntilSuccess()
    selectFileTipsElement.remove()

    const app_element = document.getElementById('app')! as HTMLDivElement
    const config_element = document.getElementById('config')! as HTMLDivElement
    const apply_btn = document.getElementById('apply')! as HTMLButtonElement
    const resolutionSelect = document.getElementById('resolution')! as HTMLSelectElement

    apply_btn.addEventListener('click', async () => {
      const value = resolutionSelect.value
      if (value) {
        const width = value.split('x')[0]
        const height = value.split('x')[1]
        window.electron.ipcRenderer.send('electron:resize', parseInt(width), parseInt(height))
        app_element.hidden = false

        config_element.remove()
        await this.runSnippets(story)
      }
    })
    config_element.hidden = false
  }
}

async function main(): Promise<void> {
  const app = new App()
  await app.run()
}

export default main
