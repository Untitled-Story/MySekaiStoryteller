import { SelectStoryResponse } from '../../../common/types/IpcResponse'
import { SnippetData, StoryData } from '../../../common/types/Story'
import { TextureMap, Live2DModelMap } from '../types/AssetMap'
import AdvancedModel from '../model/AdvancedModel'
import { AlphaFilter, Texture, Ticker } from 'pixi.js'

export default class StoryManager {
  public readonly storyJsonPath: string
  public readonly storyFolder: string
  public readonly storyData: StoryData

  constructor(story: SelectStoryResponse) {
    this.storyJsonPath = story.path!
    this.storyFolder = window.api.getFolder(this.storyJsonPath)
    this.storyData = story.data!
  }

  public async preloadModels(): Promise<Live2DModelMap[]> {
    const result: Live2DModelMap[] = []
    for (const model_data of this.storyData.models) {
      const fullPath = `mss://load-file/${this.storyFolder}/models/${model_data.model}`
      const model = await AdvancedModel.from(fullPath, {
        ticker: Ticker.shared,
        autoFocus: false,
        autoHitTest: false,
        breathDepth: 0.2
      })

      // Always true
      model.visible = true

      // For facial and motion
      model.internalModel.extendParallelMotionManager(2)

      const alpha_filter = new AlphaFilter(0)
      alpha_filter.resolution = 2

      model.filters = [alpha_filter]

      model.anchor.set(0.5)

      result.push({
        id: model_data.id,
        model: model
      })
    }
    return result
  }

  public async preloadImages(): Promise<TextureMap[]> {
    const result: TextureMap[] = []

    for (const image of this.storyData.images) {
      const imageUrl = `mss://load-file/${this.storyFolder}/images/${image.image}`
      const texture = await Texture.fromURL(imageUrl)

      result.push({
        id: image.id,
        image: texture
      })
    }

    return result
  }

  get snippets(): SnippetData[] {
    return this.storyData.snippets
  }
}
