import { invoke } from '@tauri-apps/api/core'
import {
  editorRoutePath,
  homeRoutePath,
  playerRoutePath,
  prefersInAppNavigation
} from '@/lib/platform'

type NavigateFn = (path: string) => void

let navigateHandler: NavigateFn | null = null

export function registerAppNavigator(navigate: NavigateFn | null): void {
  navigateHandler = navigate
}

function navigateInApp(path: string): void {
  if (navigateHandler) {
    navigateHandler(path)
    return
  }

  const hashPath: string = path.startsWith('/') ? `#${path}` : `#/${path}`
  window.location.hash = hashPath
}

export async function openEditorWindow(projectName: string): Promise<void> {
  if (prefersInAppNavigation()) {
    navigateInApp(editorRoutePath(projectName))
    return
  }
  await invoke('open_editor', { projectName })
}

export async function openPlayerWindow(projectName: string): Promise<void> {
  if (prefersInAppNavigation()) {
    navigateInApp(playerRoutePath(projectName))
    return
  }
  await invoke('open_player', { projectName })
}

export async function closeEditorWindow(): Promise<void> {
  if (prefersInAppNavigation()) {
    navigateInApp(homeRoutePath())
    return
  }

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().close()
  } catch {
    navigateInApp(homeRoutePath())
  }
}

export async function closePlayerWindow(): Promise<void> {
  if (prefersInAppNavigation()) {
    navigateInApp(homeRoutePath())
    return
  }

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().close()
  } catch {
    navigateInApp(homeRoutePath())
  }
}
