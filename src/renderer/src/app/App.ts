import '@pixi/unsafe-eval'
import * as PIXI from 'pixi.js'
import getSubLogger from '../utils/Logger'
import { ILogObj, Logger } from 'tslog'
import { SelectStoryResponse } from '../../../common/types/IpcResponse'
import StoryManager from '../managers/StoryManager'
import { Live2DModelMap, TextureMap } from '../types/AssetMap'
import BackgroundLayer from '../layers/BackgroundLayer'
import { LayoutModes } from '../../../common/types/Story'
import ModelLayer from '../layers/ModelLayer'
import AdvancedModel from '../model/AdvancedModel'
import PositionRel from '../types/PositionRel'
import StageUtils from '../utils/StageUtils'
import AnimationManager from '../managers/AnimationManager'

class App {
  private readonly logger: Logger<ILogObj> = getSubLogger('App')
  private applicationWrapper!: HTMLDivElement
  private pixiApplication!: PIXI.Application
  private storyManager!: StoryManager

  private models: Live2DModelMap[] = []
  private textures: TextureMap[] = []

  private layerBackground!: BackgroundLayer
  private layerModel!: ModelLayer

  private stage_size!: [number, number]

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

    this.stage_size = [this.pixiApplication.screen.width, this.pixiApplication.screen.height]

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
    this.layerModel = new ModelLayer(this.pixiApplication)
  }

  private getTextureById(id: number): PIXI.Texture {
    const data = this.textures

    return data.find((image) => image.id === id)!.image
  }

  private getModelById(id: number): AdvancedModel {
    const data = this.models

    return data.find((model) => model.id === id)!.model
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
        case 'ChangeLayoutMode': {
          this.layerModel.layoutMode = LayoutModes[snippet.data]
          break
        }
        case 'LayoutAppear': {
          const model = this.getModelById(snippet.data.modelId)
          this.layerModel.addModelAndInitialize(model)

          await model.playMotionLastFrame(snippet.data.motion, snippet.data.facial)
          this.logger.info(`Model: ${snippet.data.modelId}, pre-show motion finished`)

          const show_task = model.show(200)
          let move_task: Promise<void> | null = null
          const from: PositionRel = StageUtils.side_to_position(
            snippet.data.from.side,
            this.layerModel.layoutMode,
            snippet.data.from.offset
          )
          const to: PositionRel = StageUtils.side_to_position(
            snippet.data.to.side,
            this.layerModel.layoutMode,
            snippet.data.to.offset
          )
          if (from.x === to.x && to.y === to.y) {
            model.setPositionRel(this.stage_size, to)
          } else {
            move_task = model.move(from, to, StageUtils.move_speed_to_num(snippet.data.moveSpeed))
          }

          AnimationManager.delay(10).then(() =>
            model.applyAndWait(snippet.data.motion, snippet.data.facial)
          )

          await show_task
          if (move_task) await move_task
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
