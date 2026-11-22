export type ModelLayout = {
  anchor: number
  normalScale: number
}

/**
 * The layout a model gets when it is first registered to a project. Keep in sync with
 * `register_project_model` in the Rust backend.
 */
export function defaultModelLayout(staticPortrait: boolean): ModelLayout {
  return staticPortrait ? { anchor: 0.8, normalScale: 1 } : { anchor: 0.5, normalScale: 2.1 }
}
