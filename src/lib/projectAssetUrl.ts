import { convertFileSrc } from '@tauri-apps/api/core'

const PROTOCOL_PATH_MARKER: string = '__mss_protocol_path__'

export function localAssetUrl(rootPath: string, relativePath: string): string {
  const root: string = encodePath(rootPath)
  const child: string = encodeRelativePath(relativePath)

  return `${resolveProtocolBaseUrl()}${root}/${child}`
}

export function projectAssetUrl(projectPath: string, relativePath: string): string {
  return localAssetUrl(projectPath, relativePath)
}

function resolveProtocolBaseUrl(): string {
  const markerUrl: string = convertFileSrc(PROTOCOL_PATH_MARKER, 'mss')
  const encodedMarker: string = encodeURIComponent(PROTOCOL_PATH_MARKER)

  if (!markerUrl.endsWith(encodedMarker)) {
    throw new Error(`无法解析资源协议地址: ${markerUrl}`)
  }

  return markerUrl.slice(0, -encodedMarker.length)
}

function encodePath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .split('/')
    .filter((part: string): boolean => Boolean(part))
    .map((part: string): string => encodeURIComponent(part))
    .join('/')
}

function encodeRelativePath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .split('/')
    .filter((part: string): boolean => Boolean(part))
    .map((part: string): string => {
      if (part === '..') {
        throw new Error(`资源路径不能包含上级目录: ${path}`)
      }
      return encodeURIComponent(part)
    })
    .join('/')
}
