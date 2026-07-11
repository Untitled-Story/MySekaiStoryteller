import { invoke } from '@tauri-apps/api/core'
import type { RenderConfig } from '@/settings/types'

export function openEditorWindow(projectName: string): Promise<void> {
  return invoke('open_editor', { projectName })
}

export function openPlayerWindow(
  projectName: string,
  render: boolean = false,
  renderConfig?: RenderConfig
): Promise<void> {
  return invoke('open_player', { projectName, render, renderConfig })
}
