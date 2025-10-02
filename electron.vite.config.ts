import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@': resolve('src/main'),
        '@preload': resolve('src/preload'),
        '@common': resolve('src/common')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@': resolve('src/main'),
        '@preload': resolve('src/preload'),
        '@common': resolve('src/common')
      }
    }
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          welcome: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve('src/main'),
        '@preload': resolve('src/preload'),
        '@renderer': resolve('src/renderer/src'),
        '@windows': resolve('src/renderer/src/windows'),
        '@common': resolve('src/common')
      }
    },
    plugins: [react()]
  }
})
