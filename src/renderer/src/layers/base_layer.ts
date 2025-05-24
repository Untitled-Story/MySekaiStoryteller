import { Application, Container, DisplayObject } from 'pixi.js'

export default abstract class BaseLayer {
  protected readonly app: Application
  protected readonly stage: Container<DisplayObject>

  protected constructor(app: Application) {
    this.app = app
    this.stage = app.stage
  }
}
