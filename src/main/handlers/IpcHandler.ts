import { ILogObj, Logger } from 'tslog'
import { app, dialog, ipcMain } from 'electron'
import path from 'node:path'
import * as fs from 'node:fs'
import { SelectStoryResponse } from '../../common/types/IpcResponse'
import { StoryData, StorySchema } from '../../common/types/Story'
import { z } from 'zod'
import { mainWindow } from '../index'

async function setupIpcHandlers(logger: Logger<ILogObj>): Promise<void> {
  ipcMain.handle(
    'electron:select-story-file-until-selected',
    async (): Promise<SelectStoryResponse> => {
      logger.info('Handle IPC event: electron:select-story-file-until-selected')
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Select a story file',
        filters: [
          {
            name: 'Sekai Story File',
            extensions: ['sekai-story.json']
          }
        ],
        properties: ['openFile']
      })

      if (canceled) {
        app.exit(0)
      }

      const filePath = filePaths[0]

      try {
        const normalizedPath: string = path.resolve(filePath!)

        const rawData = await fs.promises.readFile(normalizedPath, 'utf8')

        const parsedData: StoryData = StorySchema.parse(JSON.parse(rawData))

        return { success: true, path: normalizedPath, data: parsedData }
      } catch (error) {
        if (error instanceof z.ZodError) {
          const errorMessage = error.issues
            .map((issue) => `'${issue.path.join('.')}': ${issue.message}`)
            .join('\n')
          return { success: false, zodIssueMessage: errorMessage, error: error }
        } else {
          return { success: false, error: error }
        }
      }
    }
  )

  ipcMain.on('electron:on-error', (_event, err: Error) => {
    logger.info('Handle IPC event: electron:on-error')
    logger.error(err)
    dialog
      .showMessageBox({
        type: 'error',
        title: 'Render Error',
        message: 'An error occurred in the rendering process.',
        detail: `${err.message}\n\n${err.stack}`,
        buttons: ['Reload', 'Exit']
      })
      .then((resp) => {
        if (resp.response === 0) {
          mainWindow.reload()
        } else {
          app.quit()
        }
      })
  })

  ipcMain.on('electron:resize', (_event, width: number, height: number) => {
    logger.info('Handle IPC event: electron:resize')
    logger.info(`Resize size: ${width}x${height}`)

    const [oldX, oldY] = mainWindow.getPosition()
    const [oldWidth, oldHeight] = mainWindow.getSize()

    const centerX = oldX + oldWidth / 2
    const centerY = oldY + oldHeight / 2

    const newX = Math.floor(centerX - width / 2)
    const newY = Math.floor(centerY - height / 2)

    mainWindow.setContentSize(width, height, true)
    mainWindow.setPosition(newX, newY, true)
  })
}

export default setupIpcHandlers
