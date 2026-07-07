import type { LeafSnippetData } from '@/story/schema'
import type { SnippetByType, SnippetConstructor, SnippetRegistry } from '@/story/types'
import { builtinSnippetRegistrations } from './builtin'

export type StorySnippetType = LeafSnippetData['type']

export type StorySnippetRegistration = {
  [TType in StorySnippetType]: {
    type: TType
    constructor: SnippetConstructor<SnippetByType<TType>>
  }
}[StorySnippetType]

type RegisteredSnippetConstructor = SnippetConstructor<never>

export class StorySnippetRegistry {
  private readonly constructors = new Map<StorySnippetType, RegisteredSnippetConstructor>()

  constructor(registrations: readonly StorySnippetRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration)
    }
  }

  register({ type, constructor }: StorySnippetRegistration): void {
    this.constructors.set(type, constructor as RegisteredSnippetConstructor)
  }

  unregister(type: StorySnippetType): void {
    this.constructors.delete(type)
  }

  get<TType extends StorySnippetType>(type: TType): SnippetConstructor<SnippetByType<TType>> {
    const constructor = this.constructors.get(type)
    if (!constructor) {
      throw new Error(`未注册 Story snippet: ${type}`)
    }

    return constructor as SnippetConstructor<SnippetByType<TType>>
  }

  entries(): StorySnippetRegistration[] {
    return [...this.constructors.entries()].map(([type, constructor]) => ({
      type,
      constructor: constructor as SnippetConstructor<SnippetByType<typeof type>>
    }))
  }

  toObject(): SnippetRegistry {
    return Object.fromEntries(this.constructors.entries()) as SnippetRegistry
  }

  clone(): StorySnippetRegistry {
    return new StorySnippetRegistry(this.entries())
  }
}

export function createBuiltinSnippetRegistry(): StorySnippetRegistry {
  return new StorySnippetRegistry(builtinSnippetRegistrations)
}

export const snippetRegistry = createBuiltinSnippetRegistry()
