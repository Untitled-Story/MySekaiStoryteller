import { Graphics, Matrix, Texture } from 'pixi.js'
import { CRTFilter, AdjustmentFilter } from 'pixi-filters'
import { VisualEffect } from './VisualEffect'
import AdvancedModel from '../model/AdvancedModel'
import vfx_hologram from '../../assets/ui/vfx_hologram.svg'

export class HologramEffect extends VisualEffect {
  private elapsed = 0
  private readonly graphic: Graphics
  private readonly crtFilter: CRTFilter
  private readonly adjustFilter: AdjustmentFilter

  constructor(model: AdvancedModel, width: number, height: number) {
    super(model)

    this.graphic = new Graphics()
    this.addChild(this.graphic)

    const texture = Texture.from(vfx_hologram)

    const initGraphic = (): void => this.createPattern(texture, width, height)

    if (texture.valid) {
      initGraphic()
    } else {
      texture.baseTexture.once('loaded', initGraphic)
    }

    this.crtFilter = new CRTFilter({ time: 2, lineWidth: 10, lineContrast: 0.1, vignetting: 0 })
    this.adjustFilter = new AdjustmentFilter({ alpha: 0.8, brightness: 1.2, red: 0.7 })
    this._parentFilters = [this.crtFilter, this.adjustFilter]
    this.filters = [this.crtFilter, this.adjustFilter]

    const animateCRT = (): void => {
      this.crtFilter.time += 0.2
      this.crtFilter.lineWidth = 7 + 5 * Math.sin(this.crtFilter.time * 0.01)
      this.crtFilter.seed = Math.random()
      requestAnimationFrame(animateCRT)
    }
    animateCRT()
  }

  private createPattern(texture: Texture, width: number, height: number): void {
    //TODO: Remove logs
    console.info(width, height)
    console.info(texture.width, texture.height)
    const matrix = new Matrix().scale(width / texture.width, height / texture.height)
    this.graphic.clear()
    this.graphic.beginTextureFill({ texture, matrix })
    this.graphic.drawPolygon([width / 3, height, 0, 0, width, 0, (2 * width) / 3, height])
    this.graphic.endFill()
    this.graphic.alpha = 0.8
    this.graphic.pivot.set(width / 2, height / 2)
    this.graphic.position.set(width / 2, height / 2)
  }

  update(delta: number): void {
    this.elapsed += delta
    this.graphic.alpha = 0.9 + 0.1 * Math.sin(this.elapsed * 0.1)
    this.graphic.scale.x = 1 + 0.01 * Math.sin(this.elapsed * 0.1)
    this.crtFilter.time += delta * 0.01
  }

  destroyEffect(): void {
    this.filters = []
    this.removeChildren()
    this.destroy({ children: true })
  }
}
