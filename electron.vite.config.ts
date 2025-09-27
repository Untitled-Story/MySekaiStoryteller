import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          welcome: resolve(__dirname, 'src/renderer/index.html'),
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve('src/main'),
        '@preload': resolve('src/preload'),
        '@renderer': resolve('src/renderer/src'),
        '@windows': resolve('src/renderer/src/windows'),
      }
    },
    plugins: [react()]
  }
})
