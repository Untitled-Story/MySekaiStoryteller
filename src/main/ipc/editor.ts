import { ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { EditorProjectPayload } from '@common/types/EditorProjectPayload'
import { ProjectMetadata } from '@common/types/ProjectMetadata'
import { windowManager } from '@/manager/WindowManager'

const projectsDir = path.join(process.cwd(), 'projects')

function getProjectMetadata(projectName: string): ProjectMetadata | null {
  const metadataPath = path.join(projectsDir, projectName, 'metadata.json')
  if (!fs.existsSync(metadataPath)) {
    return null
  }
  return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as ProjectMetadata
}

function buildEditorPayload(
  projectName: string
): { success: true; payload: EditorProjectPayload } | { success: false; error: string } {
  const projectPath = path.join(projectsDir, projectName)
  if (!fs.existsSync(projectPath)) {
    return { success: false, error: '项目不存在或已被删除' }
  }

  const metadata = getProjectMetadata(projectName)
  if (!metadata) {
    return { success: false, error: '无法读取项目元数据' }
  }

  return { success: true, payload: { path: projectPath, metadata } }
}

export function registerEditorIPC(): void {
  ipcMain.handle('editor:open-project', (_, projectName: string) => {
    const result = buildEditorPayload(projectName)
    if (!result.success) {
      return result
    }

    windowManager.openEditorWindow(result.payload)
    return { success: true }
  })
}
