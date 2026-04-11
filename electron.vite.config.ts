// noinspection JSUnusedGlobalSymbols

import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@': resolve('src/main'),
        '@preload': resolve('src/preload'),
        '@common': resolve('src/common')
      }
    }
  },
  preload: {
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
          welcome: resolve(__dirname, 'src/renderer/welcome.html'),
          editor: resolve(__dirname, 'src/renderer/editor.html')
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve('src/main'),
        '@preload': resolve('src/preload'),
        '@renderer': resolve('src/renderer/src'),
        '@windows': resolve('src/renderer/src/windows'),
        '@common': resolve('src/common'),
        '@dev': resolve('src/dev')
      }
    },
    plugins: [react()]
  }
})
