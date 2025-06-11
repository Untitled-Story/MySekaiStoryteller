import { ILogObj, Logger } from 'tslog'
import { ipcMain, dialog } from 'electron'
import path from 'node:path'
import * as fs from 'node:fs'
import { SelectStoryResponse } from '../../common/types/IpcResponse'
import { StoryData, StorySchema } from '../../common/types/Story'
import { z } from 'zod'

async function setupIpcHandlers(logger: Logger<ILogObj>): Promise<void> {
  ipcMain.handle(
    'electron:select-story-file-until-selected',
    async (): Promise<SelectStoryResponse> => {
      logger.info('Handle IPC event: electron:select-story-file-until-selected')
      let selected: boolean = false
      let filePath: string

      while (!selected) {
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

        if (!canceled) {
          selected = true
          filePath = filePaths[0]
        }
      }

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
}

export default setupIpcHandlers
