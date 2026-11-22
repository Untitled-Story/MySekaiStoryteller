import type { Application } from 'pixi.js'

/**
 * Destroys an application without releasing Pixi's global resources. `destroy(true)` also clears
 * the window-wide `TexturePool`, which destroys filter textures that other live applications
 * still have bound; their filter pipeline then fails every frame with
 * `null is not an object (evaluating 'this.resources[index]')`. Editor windows host several
 * applications at once (stage preview and asset preview), so they must not use `true`.
 */
export function destroyPixiApp(app: Application): void {
  app.destroy({ removeView: true }, { children: true })
}
