import { BrowserWindow, shell } from 'electron'
import { getIconPath } from '@/utils/getIconPath'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

export function createWindow({
  width,
  height,
  html,
  title
}: {
  width: number
  height: number
  html: string
  title?: string
}) {
  const window = new BrowserWindow({
    width,
    height,
    title,
    useContentSize: true,
    show: false,
    autoHideMenuBar: true,
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  window.setMenu(null)

  window.on('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    setTimeout(() => shell.openExternal(details.url))
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    setTimeout(() => window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${html}`))
  } else {
    setTimeout(() => window.loadFile(join(__dirname, `../renderer/${html}`)))
  }

  return window
}
