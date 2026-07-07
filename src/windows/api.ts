import { invoke } from '@tauri-apps/api/core'

export function openEditorWindow(projectName: string): Promise<void> {
  return invoke('open_editor', { projectName })
}

export function openPlayerWindow(projectName: string): Promise<void> {
  return invoke('open_player', { projectName })
}
