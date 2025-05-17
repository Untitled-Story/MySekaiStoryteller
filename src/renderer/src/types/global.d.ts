import { ElectronAPI } from '@electron-toolkit/preload'
import API from '../../../common/types/preload_api'

declare global {
  interface Window {
    electronAPI: ElectronAPI
    api: API
  }
}

export {}
