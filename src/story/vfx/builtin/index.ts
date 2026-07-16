import { StoryVisualEffectRegistry } from '@/story/vfx/types'
import { createHologramEffect } from './HologramEffect'
import { createTriangleParticleEffect } from './TriangleParticleEffect'
import {
  createBlurEffect,
  createColorOverlayEffect,
  createCrtEffect,
  createGrayscaleEffect,
  createOldFilmEffect
} from './FilterEffects'

const ALL_TARGETS = ['Model', 'Stage', 'Screen'] as const

export function createBuiltinVisualEffectRegistry(): StoryVisualEffectRegistry {
  return new StoryVisualEffectRegistry([
    {
      name: 'builtin:hologram-beam',
      targets: ['Model'],
      factory: createHologramEffect
    },
    {
      name: 'TriangleParticles',
      targets: ['Model'],
      factory: createTriangleParticleEffect
    },
    {
      name: 'Hologram',
      targets: ['Model'],
      effects: ['builtin:hologram-beam', 'TriangleParticles']
    },
    {
      name: 'Grayscale',
      targets: ALL_TARGETS,
      factory: createGrayscaleEffect
    },
    {
      name: 'Blur',
      targets: ALL_TARGETS,
      factory: createBlurEffect
    },
    {
      name: 'OldFilm',
      targets: ALL_TARGETS,
      factory: createOldFilmEffect
    },
    {
      name: 'CRT',
      targets: ALL_TARGETS,
      factory: createCrtEffect
    },
    {
      name: 'ColorOverlay',
      targets: ALL_TARGETS,
      factory: createColorOverlayEffect
    }
  ])
}
