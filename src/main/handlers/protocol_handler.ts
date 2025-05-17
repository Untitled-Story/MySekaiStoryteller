import { net, protocol } from 'electron'
import * as url from 'node:url'
import { ILogObj, Logger } from 'tslog'

export default async function setupProtocolHandlers(logger: Logger<ILogObj>): Promise<void> {
  protocol.handle('mss', (request) => {
    logger.info(`Handle mss protocol: ${request.url}`)
    const requestUrl = new URL(request.url)

    if (requestUrl.host === 'load-file') {
      const fileUrl = url.pathToFileURL(requestUrl.pathname.replace(/^\//, '')).toString()
      logger.info(`Encoded to: ${fileUrl}`)
      return net.fetch(fileUrl)
    } else {
      return new Response('Bad request', {
        status: 400
      })
    }
  })
}
