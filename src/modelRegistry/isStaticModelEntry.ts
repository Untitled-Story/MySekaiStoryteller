const STATIC_MODEL_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.webp']

/** A registry entry that is an image rather than a Live2D settings JSON is a static portrait. */
export function isStaticModelEntry(entry: string): boolean {
  const normalized: string = entry.toLowerCase()
  return STATIC_MODEL_EXTENSIONS.some((extension: string): boolean =>
    normalized.endsWith(extension)
  )
}
