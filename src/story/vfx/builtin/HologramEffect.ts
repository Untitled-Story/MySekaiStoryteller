import { Assets, Graphics } from 'pixi.js'
import type { Texture } from 'pixi.js'
import { AdjustmentFilter, BloomFilter, CRTFilter } from 'pixi-filters'
import { VisualEffectBase } from '@/story/vfx/VisualEffectBase'
import type { StoryVisualEffectContext } from '@/story/vfx/types'
import hologramPatternUrl from './assets/vfx_hologram.svg?url'

const HOLOGRAM_WIDTH = 3000
const HOLOGRAM_HEIGHT = 4500

export class HologramEffect extends VisualEffectBase {
  private elapsed = 0
  private graphicLarge = new Graphics()
  private graphicSmall = new Graphics()
  private readonly crtFilter: CRTFilter
  private readonly adjustFilter: AdjustmentFilter
  private readonly animateLinear: StoryVisualEffectContext['animateLinear']
  private animating = false
  private effectDestroyed = false
  private patternReady = false

  private readonly scaleLarge = 0.9
  private readonly scaleSmall = 0.8
  private readonly maxAlpha = 0.5

  constructor(context: StoryVisualEffectContext) {
    super(context)
    this.animateLinear = context.animateLinear
    this.addChild(this.graphicLarge, this.graphicSmall)

    void this.loadPattern()

    this.crtFilter = new CRTFilter({ time: 0, lineWidth: 8, lineContrast: 0.03, vignetting: 0 })
    this.adjustFilter = new AdjustmentFilter({ alpha: 0.85, brightness: 1, red: 0.75 })

    this._parentFilters = [
      this.crtFilter,
      new AdjustmentFilter({ alpha: 0.85, brightness: 1.25, red: 0.75 })
    ]
    this.filters = [this.crtFilter, this.adjustFilter, new BloomFilter({ strength: 15 })]
  }

  update(delta: number): void {
    if (!this.enabled) return
    this.elapsed += delta

    const amp = 0.25
    const offset = 1.2
    this.adjustFilter.brightness = offset + amp * Math.sin(this.elapsed * 0.05)
    this.crtFilter.time += delta * 0.01
    this.crtFilter.seed = Math.random()

    if (this.patternReady && !this.animating) {
      this.animating = true

      const startScale = this.graphicSmall.scale.x
      const targetScale = this.scaleLarge

      void this.animateLinear((progress) => {
        if (this.effectDestroyed) return

        const eased = 0.5 - 0.5 * Math.cos(Math.PI * progress)

        this.graphicSmall.scale.set(startScale + (targetScale - startScale) * eased)

        const fadeIn = eased * this.maxAlpha
        const fadeOut = (1 - eased) * this.maxAlpha
        const totalAlpha = fadeIn + fadeOut
        const normalize = totalAlpha > 1.5 ? 1.5 / totalAlpha : 1

        this.graphicSmall.alpha = fadeIn * normalize
        this.graphicLarge.alpha = fadeOut * normalize
      }, 5000)
        .then((): void => {
          if (this.effectDestroyed) return

          const temp = this.graphicLarge
          this.graphicLarge = this.graphicSmall
          this.graphicSmall = temp

          this.graphicSmall.scale.set(this.scaleSmall)
          this.graphicSmall.alpha = 0
          this.graphicLarge.alpha = this.maxAlpha

          this.animating = false
        })
        .catch((): void => {
          this.animating = false
        })
    }
  }

  destroyEffect(): void {
    this.effectDestroyed = true
    this.filters = []
    this.removeChildren()
    this.destroy({ children: true })
  }

  private createPattern(texture: Texture, width: number, height: number): void {
    const modelCanvasWidth = this.model.internalModel.width
    const modelCanvasHeight = this.model.internalModel.height

    const draw = (graphic: Graphics, scale: number): void => {
      graphic.clear()
      graphic
        .poly([width / 3, height, 0, 0, width, 0, (2 * width) / 3, height])
        .fill({ texture, textureSpace: 'local' })
      graphic.pivot.set(width / 2, height / 1.7)
      graphic.position.set(modelCanvasWidth / 2, modelCanvasHeight * this.model.anchor.y)
      graphic.scale.set(scale)
    }

    draw(this.graphicLarge, this.scaleLarge)
    draw(this.graphicSmall, this.scaleSmall)
    this.graphicLarge.alpha = this.maxAlpha
    this.graphicSmall.alpha = 0
    this.patternReady = true
  }

  private async loadPattern(): Promise<void> {
    try {
      const texture = await Assets.load<Texture>(hologramPatternUrl)
      if (!this.effectDestroyed) {
        this.createPattern(texture, HOLOGRAM_WIDTH, HOLOGRAM_HEIGHT)
      }
    } catch (error: unknown) {
      console.error('Failed to load hologram pattern', error)
    }
  }
}

export function createHologramEffect(context: StoryVisualEffectContext): HologramEffect {
  return new HologramEffect(context)
}
