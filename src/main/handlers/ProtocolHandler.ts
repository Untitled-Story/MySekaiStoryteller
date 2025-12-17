import { net, protocol } from 'electron'
import * as url from 'node:url'

export default async function setupProtocolHandlers(): Promise<void> {
  protocol.handle('mss', async (request) => {
    const requestUrl = new URL(request.url)

    if (requestUrl.host === 'load-file') {
      const decodedPath = decodeURIComponent(requestUrl.pathname)
      const localPath = decodedPath.replace(/^\//, '')
      const fileUrl = url.pathToFileURL(localPath).toString()

      try {
        const resp = await net.fetch(fileUrl)

        if (!resp.ok) {
          return new Response('File Not Found', { status: 404 })
        }

        return resp
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (_) {
        return new Response('File Not Found', { status: 404 })
      }
    }

    return new Response('Bad request', { status: 400 })
  })
}
