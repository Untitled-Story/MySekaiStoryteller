import { convertFileSrc } from '@tauri-apps/api/core'

export function localAssetUrl(rootPath: string, relativePath: string): string {
  const root: string = rootPath.replaceAll('\\', '/').replace(/\/+$/, '')
  const child: string = relativePath
    .replaceAll('\\', '/')
    .split('/')
    .filter((part: string): boolean => Boolean(part))
    .map((part: string): string => {
      if (part === '..') {
        throw new Error(`资源路径不能包含上级目录: ${relativePath}`)
      }
      return part
    })
    .join('/')

  return convertFileSrc(`${root}/${child}`, 'mss')
}

export function projectAssetUrl(projectPath: string, relativePath: string): string {
  return localAssetUrl(projectPath, relativePath)
}
