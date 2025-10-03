import { join } from 'path'
import { app } from 'electron'

export function getIconPath() {
  if (process.platform === 'win32') {
    return join(app.getAppPath(), 'resources', 'icon.ico')
  } else if (process.platform === 'darwin') {
    return join(app.getAppPath(), 'resources', 'icon.icns')
  } else {
    return join(app.getAppPath(), 'resources', 'icon.png')
  }
}
