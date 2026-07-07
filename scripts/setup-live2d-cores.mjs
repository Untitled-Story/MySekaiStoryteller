import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const __dirname = dirname(fileURLToPath(import.meta.url))
const coreDir = resolve(__dirname, '../public/live2d-core')

const assets = [
  {
    url: 'https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js',
    file: resolve(coreDir, 'live2d.min.js')
  },
  {
    url: 'https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.4.zip',
    zipEntries: [
      {
        entryFile: 'CubismSdkForWeb-5-r.4/Core/live2dcubismcore.js',
        outputFile: resolve(coreDir, 'live2dcubismcore.js')
      },
      {
        entryFile: 'CubismSdkForWeb-5-r.4/Core/live2dcubismcore.js.map',
        outputFile: resolve(coreDir, 'live2dcubismcore.js.map')
      }
    ]
  }
]

async function main() {
  mkdirSync(coreDir, { recursive: true })

  for (const asset of assets) {
    await download(asset)
  }

  console.log(`Live2D core files are ready at ${coreDir}`)
}

async function download({ url, file, zipEntries }) {
  if (file && existsSync(file)) {
    return
  }

  if (zipEntries && zipEntries.every(({ outputFile }) => existsSync(outputFile))) {
    return
  }

  console.log(`Downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length) {
    throw new Error(`Got empty response from ${url}`)
  }

  if (file) {
    writeFileSync(file, buffer)
    return
  }

  if (zipEntries) {
    await unzip(zipEntries, buffer)
  }
}

async function unzip(zipEntries, buffer) {
  const zip = await JSZip.loadAsync(buffer)

  for (const { entryFile, outputFile } of zipEntries) {
    if (existsSync(outputFile)) {
      continue
    }

    const zipFile = zip.file(entryFile)
    if (!zipFile) {
      throw new Error(`No zip entry found for ${entryFile}`)
    }

    mkdirSync(dirname(outputFile), { recursive: true })
    await new Promise((resolvePromise, reject) => {
      zipFile
        .nodeStream()
        .pipe(createWriteStream(outputFile, 'utf8'))
        .on('finish', resolvePromise)
        .on('error', reject)
    })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
