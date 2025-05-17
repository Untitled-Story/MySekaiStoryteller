import { SelectStoryResponse } from '../../../common/types/ipc_response'
import { Snippet, Story } from '../../../common/types/story'
import { Live2DModel } from 'pixi-live2d-display-mulmotion'
import * as PIXI from 'pixi.js'
import { TextureMap, Live2DModelMap } from '../types/asset_map'

export default class StoryManager {
  public readonly storyJsonPath: string
  public readonly storyFolder: string
  public readonly storyData: Story

  constructor(story: SelectStoryResponse) {
    this.storyJsonPath = story.path!
    this.storyFolder = window.api.getFolder(this.storyJsonPath)
    this.storyData = story.data!
  }

  public async preloadModels(): Promise<Live2DModelMap[]> {
    const result: Live2DModelMap[] = []
    for (const model of this.storyData.models) {
      const fullPath = `mss://load-file/${this.storyFolder}/models/${model.model}`
      result.push({
        id: model.id,
        model: Live2DModel.fromSync(fullPath, {
          ticker: PIXI.Ticker.shared,
          autoFocus: false,
          autoHitTest: false
        })
      })
    }
    return result
  }

  public async preloadImages(): Promise<TextureMap[]> {
    const result: TextureMap[] = []

    for (const image of this.storyData.images) {
      const imageUrl = `mss://load-file/${this.storyFolder}/images/${image.image}`
      const texture = PIXI.Texture.from(imageUrl)

      result.push({
        id: image.id,
        image: texture
      })
    }

    return result
  }

  get snippets(): Snippet[] {
    return this.storyData.snippets
  }
}
