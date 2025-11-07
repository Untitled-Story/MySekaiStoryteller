import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ProjectMetadata } from '@common/types/ProjectMetadata'

const projectsDir = path.join(process.cwd(), 'projects')

function validateProjectName(name: string): { valid: boolean; error?: string } {
  if (!name || name.trim().length === 0) {
    return { valid: false, error: '项目名称不能为空' }
  }

  const invalidChars = /[<>:"/\\|?*]/
  if (invalidChars.test(name)) {
    return { valid: false, error: '项目名称不能包含以下特殊字符: < > : " / \\ | ? *' }
  }

  if (name.length > 255) {
    return { valid: false, error: '项目名称过长(最多255个字符)' }
  }

  return { valid: true }
}

function getProjectPath(projectName: string): string {
  return path.join(projectsDir, projectName)
}

function projectExists(projectName: string): boolean {
  return fs.existsSync(getProjectPath(projectName))
}

function updateProjectMetadata(projectName: string, updates: Partial<ProjectMetadata>): void {
  const metadataPath = path.join(getProjectPath(projectName), 'metadata.json')
  let metadata: ProjectMetadata

  if (fs.existsSync(metadataPath)) {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as ProjectMetadata
  } else {
    metadata = {
      title: projectName,
      lastModified: Date.now()
    }
  }

  Object.assign(metadata, updates)
  metadata.lastModified = Date.now()

  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))
}

export function registerProjectIPC(): void {
  ipcMain.handle('project:get-projects', (): string[] => {
    if (!fs.existsSync(projectsDir)) {
      fs.mkdirSync(projectsDir)
    }

    return fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .filter((name) => fs.existsSync(path.join(projectsDir, name, 'metadata.json')))
  })

  ipcMain.handle('project:get-metadata', (_, projectName: string): ProjectMetadata | null => {
    const file = path.join(projectsDir, projectName, 'metadata.json')

    if (!fs.existsSync(file)) {
      return null
    }

    return JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectMetadata
  })

  ipcMain.handle('project:set-metadata', (_, projectName: string, data: ProjectMetadata): void => {
    const dir = path.join(projectsDir, projectName)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(data, null, 2))
  })

  ipcMain.handle(
    'project:create',
    (_, projectName: string): { success: boolean; error?: string } => {
      const validation = validateProjectName(projectName)
      if (!validation.valid) {
        return { success: false, error: validation.error }
      }

      if (projectExists(projectName)) {
        return { success: false, error: '该项目名称已存在' }
      }

      const projectPath = getProjectPath(projectName)

      try {
        fs.mkdirSync(projectPath, { recursive: true })
        updateProjectMetadata(projectName, { title: projectName })
        return { success: true }
      } catch (error) {
        if (projectExists(projectName)) {
          try {
            fs.rmSync(projectPath, { recursive: true })
          } catch (cleanupError) {
            console.error('Failed to cleanup after error:', cleanupError)
          }
        }
        return {
          success: false,
          error: '创建项目失败: ' + (error instanceof Error ? error.message : '未知错误')
        }
      }
    }
  )

  ipcMain.handle(
    'project:delete',
    (_, projectName: string): { success: boolean; error?: string } => {
      const validation = validateProjectName(projectName)
      if (!validation.valid) {
        return { success: false, error: validation.error }
      }

      if (!projectExists(projectName)) {
        return { success: false, error: '项目不存在' }
      }

      try {
        fs.rmSync(getProjectPath(projectName), { recursive: true, force: true })
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: '删除项目失败: ' + (error instanceof Error ? error.message : '未知错误')
        }
      }
    }
  )

  ipcMain.handle(
    'project:rename',
    (_, oldName: string, newName: string): { success: boolean; error?: string } => {
      const oldValidation = validateProjectName(oldName)
      if (!oldValidation.valid) {
        return { success: false, error: '原' + oldValidation.error }
      }

      const newValidation = validateProjectName(newName)
      if (!newValidation.valid) {
        return { success: false, error: '新' + newValidation.error }
      }

      if (!projectExists(oldName)) {
        return { success: false, error: '原项目不存在' }
      }

      if (projectExists(newName)) {
        return { success: false, error: '该项目名称已存在' }
      }

      try {
        fs.renameSync(getProjectPath(oldName), getProjectPath(newName))
        updateProjectMetadata(newName, { title: newName })
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: '重命名项目失败: ' + (error instanceof Error ? error.message : '未知错误')
        }
      }
    }
  )
}
