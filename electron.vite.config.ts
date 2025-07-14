import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [
      {
        name: 'build-html',
        transformIndexHtml: (html) => {
          return {
            html,
            tags: [
              {
                tag: 'script',
                attrs: {
                  src: 'live2d.min.js'
                },
                injectTo: 'body'
              },
              {
                tag: 'script',
                attrs: {
                  src: 'live2dcubismcore.min.js'
                },
                injectTo: 'body'
              }
            ]
          }
        }
      }
    ]
  }
})
