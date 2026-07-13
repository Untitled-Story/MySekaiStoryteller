import { Graphics } from 'pixi.js'
import { VisualEffectBase } from '@/story/vfx/VisualEffectBase'
import type { StoryVisualEffectContext } from '@/story/vfx/types'

class ParticleTriangle extends Graphics {
  private age = 0

  constructor(
    x: number,
    y: number,
    color: number,
    size: number,
    private readonly velocityX: number,
    private readonly velocityY: number,
    private readonly rotationSpeed: number,
    private readonly lifespan: number,
    private readonly fadeDuration: number,
    filled: boolean
  ) {
    super()
    this.x = x
    this.y = y
    this.alpha = 0
    this.rotation = Math.random() * Math.PI * 2
    this.blendMode = 'add'

    const points = [-size / 2, size / 2, size / 2, size / 2, 0, -size / 2]
    if (filled) {
      this.poly(points).fill(color)
    } else {
      this.poly(points).stroke({ width: 10, color })
    }
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

export default class TriangleParticleEffect extends VisualEffectBase {
  private readonly particles: ParticleTriangle[] = []
  private elapsedMs = 0
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

  constructor(context: StoryVisualEffectContext) {
    super(context.model)
  }

  private randomInRange([min, max]: [number, number]): number {
    return min + Math.random() * (max - min)
  }

  private spawnParticle(): void {
    if (this.particles.length >= this.maxParticles) return

    const x = this.model.internalModel.width * (0.1 + Math.random() * 0.8)
    const y = this.model.internalModel.height * (0.25 + Math.random() * 0.5)
    const color = this.colors[Math.floor(Math.random() * this.colors.length)]
    const size = this.randomInRange(this.sizeRange)
    const velocityX = this.randomInRange(this.velocityRangeX)
    const velocityY = this.randomInRange(this.velocityRangeY)
    const rotationSpeed =
      this.randomInRange(this.rotationSpeedRange) * (Math.random() > 0.5 ? 1 : -1)
    const lifespan = this.randomInRange(this.lifespanRange)
    const filled = Math.random() > 0.5

    const particle = new ParticleTriangle(
      x,
      y,
      color,
      size,
      velocityX,
      velocityY,
      rotationSpeed,
      lifespan,
      this.fadeTime,
      filled
    )
    this.model.addChild(particle)
    this.particles.push(particle)
  }

  update(delta: number): void {
    if (!this.enabled) return
    this.elapsedMs += delta * (1000 / 60)
    if (this.elapsedMs - this.lastSpawnTime > this.spawnInterval) {
      this.spawnParticle()
      this.lastSpawnTime = this.elapsedMs
    }

    for (let index = this.particles.length - 1; index >= 0; index--) {
      const particle = this.particles[index]
      if (particle.update(delta)) {
        particle.removeFromParent()
        particle.destroy()
        this.particles.splice(index, 1)
      }
    }
  }

  destroyEffect(): void {
    this.clearAllParticles()
  }

  clearAllParticles(): void {
    for (const particle of this.particles) {
      particle.removeFromParent()
      particle.destroy()
    }
    this.particles.length = 0
  }
}

export function createTriangleParticleEffect(
  context: StoryVisualEffectContext
): TriangleParticleEffect {
  return new TriangleParticleEffect(context)
}
