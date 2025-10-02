import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ProjectMetadata } from '@common/types/ProjectMetadata'

const projectsDir = path.join(process.cwd(), 'projects')

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
}
