import { BLEND_MODES, Graphics } from 'pixi.js'
import { VisualEffect } from './VisualEffect'
import AdvancedModel from '../model/AdvancedModel'

class ParticleTriangle extends Graphics {
  private age = 0
  private readonly lifespan: number
  private readonly fadeDuration: number
  private readonly velocityX: number
  private readonly velocityY: number
  private readonly rotationSpeed: number

  constructor(
    x: number,
    y: number,
    color: number,
    size: number,
    velocityX: number,
    velocityY: number,
    rotationSpeed: number,
    lifespan: number,
    fadeDuration: number,
    filled: boolean
  ) {
    super()
    this.x = x
    this.y = y
    this.lifespan = lifespan
    this.fadeDuration = fadeDuration
    this.velocityX = velocityX
    this.velocityY = velocityY
    this.rotationSpeed = rotationSpeed

    this.alpha = 0
    this.rotation = Math.random() * Math.PI * 2
    this.blendMode = BLEND_MODES.ADD

    if (filled) this.beginFill(color)
    else this.lineStyle(10, color)

    this.drawPolygon([-size / 2, size / 2, size / 2, size / 2, 0, -size / 2])
    this.endFill()
  }

  update(delta: number): boolean {
    this.x += this.velocityX * delta
    this.y += this.velocityY * delta
    this.rotation += this.rotationSpeed * delta
    this.age += delta / 60

    if (this.age < this.fadeDuration) {
      this.alpha = this.age / this.fadeDuration
    } else {
      const remaining = this.lifespan - this.fadeDuration
      const elapsed = this.age - this.fadeDuration
      this.alpha = 1 - elapsed / remaining
    }

    return this.age >= this.lifespan
  }
}

export default class TriangleParticleEffect extends VisualEffect {
  private particles: ParticleTriangle[] = []
  private lastSpawnTime = 0

  private readonly maxParticles = 15
  private readonly spawnInterval = 250
  private readonly sizeRange: [number, number] = [100, 200]
  private readonly velocityRangeX: [number, number] = [-0.8, 0.8]
  private readonly velocityRangeY: [number, number] = [-0.8, 0.8]
  private readonly rotationSpeedRange: [number, number] = [0.01, 0.04]
  private readonly lifespanRange: [number, number] = [5, 10]
  private readonly fadeTime = 0.5
  private readonly colors = [0xff00ff, 0x00ffff, 0xffff00]

  constructor(model: AdvancedModel) {
    super(model)
  }

  private randomInRange([min, max]: [number, number]): number {
    return min + Math.random() * (max - min)
  }

  private spawnParticle(): void {
    if (!this.model || this.particles.length >= this.maxParticles) return

    const bounds = this.model.getLocalBounds()
    const x = bounds.width * (0.1 + Math.random() * 0.8)
    const y = bounds.height * (0.25 + Math.random() * 0.5)
    const color = this.colors[Math.floor(Math.random() * this.colors.length)]
    const size = this.randomInRange(this.sizeRange)
    const vx = this.randomInRange(this.velocityRangeX)
    const vy = this.randomInRange(this.velocityRangeY)
    const rot = this.randomInRange(this.rotationSpeedRange) * (Math.random() > 0.5 ? 1 : -1)
    const lifespan = this.randomInRange(this.lifespanRange)
    const filled = Math.random() > 0.5

    const particle = new ParticleTriangle(
      x,
      y,
      color,
      size,
      vx,
      vy,
      rot,
      lifespan,
      this.fadeTime,
      filled
    )
    this.model.addChild(particle)
    this.particles.push(particle)
  }

  update(delta: number): void {
    if (!this.enabled) return
    const now = performance.now()
    if (now - this.lastSpawnTime > this.spawnInterval) {
      this.spawnParticle()
      this.lastSpawnTime = now
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i]
      if (particle.update(delta)) {
        this.model.removeChild(particle)
        particle.destroy()
        this.particles.splice(i, 1)
      }
    }
  }

  destroyEffect(): void {
    for (const p of this.particles) {
      p.destroy()
    }
    this.particles.length = 0
  }
}
