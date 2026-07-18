import type { RenderConfig } from '@/settings/types'

const STORAGE_KEY = 'mss.pendingRenderConfig.v1'

type PendingEntry = {
  projectName: string
  config: RenderConfig
  createdAt: number
}

function readAll(): PendingEntry[] {
  try {
    const raw: string | null = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item: unknown): item is PendingEntry => {
      if (!item || typeof item !== 'object') return false
      const record = item as Record<string, unknown>
      return typeof record.projectName === 'string' && typeof record.config === 'object' && record.config !== null
    })
  } catch {
    return []
  }
}

function writeAll(entries: PendingEntry[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-4)))
  } catch {
    // sessionStorage may be unavailable; in-memory fallback is enough for same navigation tick.
  }
}

let memoryEntries: PendingEntry[] = []

/** Stash render config for in-app (Android/iOS) single-webview export navigation. */
export function stashPendingRenderConfig(projectName: string, config: RenderConfig): void {
  const entry: PendingEntry = {
    projectName,
    config,
    createdAt: Date.now()
  }
  memoryEntries = [...memoryEntries.filter((e) => e.projectName !== projectName), entry]
  const disk = readAll().filter((e) => e.projectName !== projectName)
  disk.push(entry)
  writeAll(disk)
}

/** Peek without removing (survives React StrictMode double mount if needed). */
export function peekPendingRenderConfig(projectName: string | null | undefined): RenderConfig | null {
  if (!projectName) return null
  const fromMem = memoryEntries.find((e) => e.projectName === projectName)
  if (fromMem) return fromMem.config
  const fromDisk = readAll().find((e) => e.projectName === projectName)
  return fromDisk?.config ?? null
}

/** Take and remove pending config for a project. */
export function takePendingRenderConfig(projectName: string | null | undefined): RenderConfig | null {
  if (!projectName) return null
  const memIdx = memoryEntries.findIndex((e) => e.projectName === projectName)
  let config: RenderConfig | null = null
  if (memIdx >= 0) {
    config = memoryEntries[memIdx]?.config ?? null
    memoryEntries = memoryEntries.filter((_, i) => i !== memIdx)
  }
  const disk = readAll()
  const diskIdx = disk.findIndex((e) => e.projectName === projectName)
  if (diskIdx >= 0) {
    config = config ?? disk[diskIdx]?.config ?? null
    writeAll(disk.filter((_, i) => i !== diskIdx))
  }
  return config
}

export function clearPendingRenderConfig(projectName?: string | null): void {
  if (!projectName) {
    memoryEntries = []
    writeAll([])
    return
  }
  memoryEntries = memoryEntries.filter((e) => e.projectName !== projectName)
  writeAll(readAll().filter((e) => e.projectName !== projectName))
}
