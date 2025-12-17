import { SelectStoryResponse } from '../../../common/types/IpcResponse'
import { SnippetData, StoryData } from '../../../common/types/Story'
import { Live2DModelMap, TextureMap } from '../types/AssetMap'
import AdvancedModel from '../model/AdvancedModel'
import { Resource, Texture, Ticker } from 'pixi.js'
import { Cubism2InternalModel } from 'pixi-live2d-display-advanced'

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

      let model: AdvancedModel

      try {
        model = await AdvancedModel.from(fullPath, {
          ticker: Ticker.shared,
          autoFocus: false,
          autoHitTest: false,
          breathDepth: 0
        })
      } catch (error) {
        if (error instanceof Error && error.message === 'Network error.') {
          throw new Error(
            `Model ${model_data.id} could not be loaded.\nModel path: ${model_data.model}\n`,
            {
              cause: error
            }
          )
        }
        throw error
      }

      if (model.internalModel instanceof Cubism2InternalModel) {
        model.internalModel.setAutoBlinkEnable(false)
      }

      model.initialize(model_data)

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

      let texture: Texture<Resource>

      try {
        texture = await Texture.fromURL(imageUrl)
      } catch (error) {
        if (error instanceof Event && error.type === 'error') {
          throw new Error(`Image ${image.id} could not be loaded.\nImage path: ${image.image}\n`)
        }

        throw error
      }

      result.push({
        id: image.id,
        image: texture
      })
    }

    return result
  }

  public geVoiceUrlByName(name: string): string {
    return `mss://load-file/${this.storyFolder}/voices/${name}`
  }

  get snippets(): SnippetData[] {
    return this.storyData.snippets
  }
}
