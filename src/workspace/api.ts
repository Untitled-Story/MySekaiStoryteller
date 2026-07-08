import { invoke } from '@tauri-apps/api/core'
import type { DataFontInfo } from '@/settings/fonts'

export function getDefaultWorkspaceDir(): Promise<string> {
  return invoke<string>('get_default_workspace_dir')
}

export function getWorkspace(): Promise<string | null> {
  return invoke<string | null>('get_workspace')
}

export function getDataPath(): Promise<string> {
  return invoke<string>('get_data_path')
}

export function getDataFonts(): Promise<DataFontInfo[]> {
  return invoke<DataFontInfo[]>('get_data_fonts')
}
