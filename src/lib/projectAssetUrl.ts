export function localAssetUrl(rootPath: string, relativePath: string): string {
  const root: string = encodePath(rootPath)
  const child = relativePath
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      if (part === '..') {
        throw new Error(`资源路径不能包含上级目录: ${relativePath}`)
      }
      return encodeURIComponent(part)
    })
    .join('/')

  return `mss://load-file/${root}/${child}`
}

export function projectAssetUrl(projectPath: string, relativePath: string): string {
  return localAssetUrl(projectPath, relativePath)
}

function encodePath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .map((part: string): string => encodeURIComponent(part))
    .join('/')
}
