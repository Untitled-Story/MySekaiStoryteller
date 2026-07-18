export function buildDefaultExportPath(dataPath: string, title: string): string {
  const now = new Date()
  const timestamp =
    now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0') +
    '_' +
    now.getHours().toString().padStart(2, '0') +
    now.getMinutes().toString().padStart(2, '0') +
    now.getSeconds().toString().padStart(2, '0')

  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_')
  return `${dataPath}/outputs/${safeTitle}_${timestamp}_MySekaiStoryteller.mp4`
}
