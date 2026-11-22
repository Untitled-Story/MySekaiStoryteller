import type { Application } from 'pixi.js'

/**
 * Destroys an application without releasing Pixi's global resources. `destroy(true)` also clears
 * the page-wide `TexturePool`, which destroys filter textures that other live applications still
 * have bound; their filter pipeline then fails every frame with
 * `null is not an object (evaluating 'this.resources[index]')`.
 *
 * Several applications can be alive at once: the editor's stage and asset previews, and on mobile
 * the editor, the player and the model preview all share one webview while their teardown is
 * deferred. Use this everywhere instead of `destroy(true)`. The pooled textures that stay behind
 * are reused by the next application.
 */
export function destroyPixiApp(app: Application): void {
  app.destroy({ removeView: true }, { children: true })
}
