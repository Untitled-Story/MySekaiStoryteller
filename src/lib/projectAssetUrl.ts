export function localAssetUrl(rootPath: string, relativePath: string): string {
  const root = rootPath.replace(/\/$/, '')
  const child = relativePath
    .split('/')
    .filter(Boolean)
    .map((part) => {
      if (part === '..') {
        throw new Error(`资源路径不能包含上级目录: ${relativePath}`)
      }
      return encodeURIComponent(part)
    })
    .join('/')

  return `mss://load-file${encodeURI(root)}/${child}`
}

export function projectAssetUrl(projectPath: string, relativePath: string): string {
  return localAssetUrl(projectPath, relativePath)
}
