import { Graphics, Matrix, Texture } from 'pixi.js'
import { AdjustmentFilter, CRTFilter, BloomFilter } from 'pixi-filters'
import { VisualEffect } from './VisualEffect'
import AdvancedModel from '../model/AdvancedModel'
import vfx_hologram from '../../assets/ui/vfx_hologram.svg'
import AnimationManager from '../managers/AnimationManager'

// Thanks lezzthanthree/SEKAI-Stories to provide a solution
export class HologramEffect extends VisualEffect {
  private elapsed = 0
  private graphic_l: Graphics
  private graphic_s: Graphics
  private readonly crtFilter: CRTFilter
  private readonly adjustFilter: AdjustmentFilter

  private readonly scaleLarge = 0.9
  private readonly scaleSmall = 0.8
  private readonly maxAlpha = 0.5

  constructor(model: AdvancedModel, width: number, height: number) {
    super(model)

    this.graphic_l = new Graphics()
    this.graphic_s = new Graphics()
    this.addChild(this.graphic_l, this.graphic_s)

    const texture = Texture.from(vfx_hologram)
    const init = (): void => this.createPattern(texture, width, height)
    texture.valid ? init() : texture.baseTexture.once('loaded', init)

    this.crtFilter = new CRTFilter({ time: 0, lineWidth: 8, lineContrast: 0.03, vignetting: 0 })
    this.adjustFilter = new AdjustmentFilter({ alpha: 0.85, brightness: 1, red: 0.75 })

    this._parentFilters = [
      this.crtFilter,
      new AdjustmentFilter({ alpha: 0.85, brightness: 1.25, red: 0.75 })
    ]
    this.filters = [this.crtFilter, this.adjustFilter, new BloomFilter(15)]

    const animateCRT = (): void => {
      this.crtFilter.time += 0.03
      this.crtFilter.seed = Math.random()
      requestAnimationFrame(animateCRT)
    }
    animateCRT()
  }

  update(delta: number): void {
    if (!this.enabled) return
    this.elapsed += delta

    const amp = 0.25
    const offset = 1.2
    this.adjustFilter.brightness = offset + amp * Math.sin(this.elapsed * 0.05)
    this.crtFilter.time += delta * 0.01

    const small = this.graphic_s
    const large = this.graphic_l

    if (!this['animating']) {
      this['animating'] = true

      const startScale = small.scale.x
      const targetScale = this.scaleLarge

      AnimationManager.run((progress) => {
        const eased = 0.5 - 0.5 * Math.cos(Math.PI * progress)

        small.scale.set(startScale + (targetScale - startScale) * eased)

        const fadeIn = eased * this.maxAlpha
        const fadeOut = (1 - eased) * this.maxAlpha
        const totalAlpha = fadeIn + fadeOut
        const normalize = totalAlpha > 1.5 ? 1.5 / totalAlpha : 1

        small.alpha = fadeIn * normalize
        large.alpha = fadeOut * normalize
      }, 5000).then(() => {
        const temp = this.graphic_l
        this.graphic_l = this.graphic_s
        this.graphic_s = temp

        this.graphic_s.scale.set(this.scaleSmall)
        this.graphic_s.alpha = 0
        this.graphic_l.alpha = this.maxAlpha

        this['animating'] = false
      })
    }
  }

  private createPattern(texture: Texture, width: number, height: number): void {
    const draw = (g: Graphics, scale: number): void => {
      const matrix = new Matrix().scale(width / texture.width, height / texture.height)
      g.clear()
      g.beginTextureFill({ texture, matrix })
      g.drawPolygon([width / 3, height, 0, 0, width, 0, (2 * width) / 3, height])
      g.endFill()
      g.pivot.set(width / 2, height / 1.7)
      const offsetY = (0.5 - this.model.anchor.y) * this.model.height
      g.position.set(this.model.width / 2, this.model.height / 2 - offsetY)
      g.scale.set(scale)
    }

    draw(this.graphic_l, this.scaleLarge)
    draw(this.graphic_s, this.scaleSmall)
    this.graphic_l.alpha = this.maxAlpha
    this.graphic_s.alpha = 0
  }

  destroyEffect(): void {
    this.filters = []
    this.removeChildren()
    this.destroy({ children: true })
  }
}
