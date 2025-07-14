import { net, protocol } from 'electron'
import * as url from 'node:url'

export default async function setupProtocolHandlers(): Promise<void> {
  protocol.handle('mss', (request) => {
    const requestUrl = new URL(request.url)

    if (requestUrl.host === 'load-file') {
      const fileUrl = url.pathToFileURL(requestUrl.pathname.replace(/^\//, '')).toString()
      return net.fetch(fileUrl)
    } else {
      return new Response('Bad request', {
        status: 400
      })
    }
  })
}
