import { BrowserWindow } from 'electron'
import { createWindow } from '@/utils/createWindow'
import { EditorProjectPayload } from '@common/types/EditorProjectPayload'

export class WindowManager {
  private welcomeWindow: BrowserWindow | null = null
  private editorWindow: BrowserWindow | null = null
  private currentEditorPayload: EditorProjectPayload | null = null

  showWelcomeWindow() {
    const window =
      this.welcomeWindow && !this.welcomeWindow.isDestroyed()
        ? this.welcomeWindow
        : this.createWelcomeWindow()

    window.show()
    window.focus()
    this.welcomeWindow = window

    return window
  }

  openEditorWindow(payload: EditorProjectPayload) {
    const existingWindow =
      this.editorWindow && !this.editorWindow.isDestroyed() ? this.editorWindow : null
    const window = existingWindow ?? this.createEditorWindow(payload)

    if (existingWindow) {
      this.queueEditorPayload(window, payload)
    }

    window.show()
    window.focus()
    this.editorWindow = window

    if (this.welcomeWindow && !this.welcomeWindow.isDestroyed()) {
      this.welcomeWindow.hide()
    }

    return window
  }

  private createWelcomeWindow() {
    const window = createWindow({
      width: 1000,
      height: 600,
      html: 'welcome.html',
      title: 'MySekaiStoryteller'
    })

    this.welcomeWindow = window

    window.on('closed', () => {
      if (this.welcomeWindow === window) {
        this.welcomeWindow = null
      }
    })

    return window
  }

  private createEditorWindow(payload: EditorProjectPayload) {
    const window = createWindow({
      width: 1280,
      height: 720,
      html: 'editor.html',
      title: 'MySekaiStoryteller - Editor'
    })

    this.editorWindow = window
    this.queueEditorPayload(window, payload)

    window.on('closed', () => {
      if (this.editorWindow === window) {
        this.editorWindow = null
        this.currentEditorPayload = null
      }
      this.showWelcomeWindow()
    })

    return window
  }

  private queueEditorPayload(window: BrowserWindow, payload: EditorProjectPayload) {
    this.currentEditorPayload = payload
    const sendPayload = () => {
      if (this.currentEditorPayload) {
        window.webContents.send('editor:project-data', this.currentEditorPayload)
      }
    }

    if (window.webContents.isLoading() || window.webContents.getURL() === '') {
      window.webContents.once('did-finish-load', sendPayload)
    } else {
      sendPayload()
    }
  }
}

export const windowManager = new WindowManager()
