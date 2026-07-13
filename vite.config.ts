import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const host: string | undefined = process.env.TAURI_DEV_HOST
const packageMetadata: { version: string } = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf8')
) as { version: string }

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageMetadata.version)
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/windows/main/index.html'),
        editor: resolve(__dirname, 'src/windows/editor/index.html'),
        player: resolve(__dirname, 'src/windows/player/index.html')
      }
    }
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  }
})
