/** Default filename stem used by desktop and mobile exports. */
export function buildExportFileName(title: string, now: Date = new Date()): string {
  const timestamp =
    now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0') +
    '_' +
    now.getHours().toString().padStart(2, '0') +
    now.getMinutes().toString().padStart(2, '0') +
    now.getSeconds().toString().padStart(2, '0')

  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_')
  return `${safeTitle}_${timestamp}_MySekaiStoryteller.mp4`
}

/** Desktop default: under app data outputs. */
export function buildDefaultExportPath(dataPath: string, title: string): string {
  return `${dataPath.replace(/\/+$/, '')}/outputs/${buildExportFileName(title)}`
}

/**
 * Mobile public display/publish path:
 * `{MoviesDir}/MySekaiStoryteller/<default filename>`
 */
export function buildMoviesExportPath(moviesDir: string, title: string): string {
  const root = moviesDir.replace(/\/+$/, '')
  return `${root}/MySekaiStoryteller/${buildExportFileName(title)}`
}

/** Private encode working path (always writable). */
export function buildPrivateEncodePath(dataPath: string, title: string): string {
  return buildDefaultExportPath(dataPath, title)
}
