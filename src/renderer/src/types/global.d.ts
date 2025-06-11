import { ElectronAPI } from '@electron-toolkit/preload'
import API from '../../../common/types/PreloadAPI'

declare global {
  interface Window {
    electronAPI: ElectronAPI
    api: API
  }
}

export {}
