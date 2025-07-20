import { globalShortcut } from 'electron'
import { mainWindow } from '../index'
import { ILogObj, Logger } from 'tslog'

export default function setupShortcutHandlers(logger: Logger<ILogObj>, isMac: boolean): void {
  const reloadShortcut = isMac ? 'Command+Shift+R' : 'Ctrl+Shift+R'
  globalShortcut.register(reloadShortcut, () => {
    logger.info('Reload by shortcut')
    mainWindow.reload()
  })
}
