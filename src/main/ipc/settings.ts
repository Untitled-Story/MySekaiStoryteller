import { ipcMain, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings } from '@common/types/Settings'

const configDir = path.join(process.cwd(), 'configs')
const configPath = path.join(configDir, 'config.json')

function ensureConfigDir(): void {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
}

function readSettings(): AppSettings | null {
  try {
    if (!fs.existsSync(configPath)) {
      return null
    }
    const raw = fs.readFileSync(configPath, 'utf8')
    return JSON.parse(raw) as AppSettings
  } catch (error) {
    console.error('[settings] Failed to read settings:', error)
    return null
  }
}

function writeSettings(settings: AppSettings): void {
  ensureConfigDir()
  fs.writeFileSync(configPath, JSON.stringify(settings, null, 2), 'utf8')
}

function broadcastSettings(settings: AppSettings): void {
  const windows = BrowserWindow.getAllWindows()
  windows.forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send('settings:changed', settings)
    }
  })
}

export function registerSettingsIPC(): void {
  ipcMain.handle('settings:get', (): AppSettings | null => {
    return readSettings()
  })

  ipcMain.handle('settings:set', (_event, settings: AppSettings): void => {
    writeSettings(settings)
    broadcastSettings(settings)
  })

  ipcMain.on('settings:get-sync', (event) => {
    event.returnValue = readSettings()
  })
}
