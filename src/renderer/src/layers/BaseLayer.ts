import { Application, Container, DisplayObject } from 'pixi.js'

export default abstract class BaseLayer {
  protected readonly app: Application
  protected readonly stage: Container<DisplayObject>
  protected readonly layerContainer: Container<DisplayObject>

  protected constructor(app: Application, zIndex: number) {
    this.app = app
    this.stage = app.stage
    this.layerContainer = new Container()
    this.layerContainer.zIndex = zIndex

    this.stage.addChild(this.layerContainer)
  }
}
