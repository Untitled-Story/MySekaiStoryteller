import { StoryVisualEffectRegistry } from '@/story/vfx/types'
import { createHologramEffect } from './HologramEffect'
import { createTriangleParticleEffect } from './TriangleParticleEffect'

export function createBuiltinVisualEffectRegistry(): StoryVisualEffectRegistry {
  return new StoryVisualEffectRegistry([
    {
      name: 'builtin:hologram-beam',
      factory: createHologramEffect
    },
    {
      name: 'builtin:hologram-triangles',
      factory: createTriangleParticleEffect
    },
    {
      name: 'hologram',
      effects: ['builtin:hologram-beam', 'builtin:hologram-triangles']
    }
  ])
}
