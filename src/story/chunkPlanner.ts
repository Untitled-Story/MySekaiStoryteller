export type FrameChunk = {
  workerIndex: number
  startFrame: number
  endFrame: number
}

export type ExportJob = {
  jobId: number
  startFrame: number
  endFrame: number
  segmentPath: string
  sessionKey: string
  attempts: number
  /** Owning worker/slot for lane scheduling. */
  slotId?: number
}

export type ChunkSizeStats = {
  recentRetries?: number
  recentStable?: number
}

/**
 * Split total frames into N equal contiguous ranges [start, end).
 * Every worker weight is 1 (equal lanes). Exactly one segment per worker.
 */
export function planFrameChunks(totalFrames: number, workers: number): FrameChunk[] {
  const safeWorkers = clampConcurrency(workers)
  const frames = Math.max(0, Math.floor(totalFrames))

  if (frames === 0) {
    return [{ workerIndex: 0, startFrame: 0, endFrame: 0 }]
  }

  if (safeWorkers === 1) {
    return [{ workerIndex: 0, startFrame: 0, endFrame: frames }]
  }

  // Equal weights: each worker gets ~frames/n.
  const totalWeight = safeWorkers
  const sizes: number[] = []
  let assigned = 0
  for (let w = 0; w < safeWorkers; w += 1) {
    if (w === safeWorkers - 1) {
      sizes.push(Math.max(0, frames - assigned))
    } else {
      const size = Math.floor((frames * 1) / totalWeight)
      sizes.push(size)
      assigned += size
    }
  }

  // Give leftover frames (from floor) to earliest workers so sum === frames.
  const sum = sizes.reduce((a: number, b: number): number => a + b, 0)
  if (sum < frames) {
    let need = frames - sum
    for (let w = 0; w < safeWorkers && need > 0; w += 1) {
      sizes[w] += 1
      need -= 1
    }
  } else if (sum > frames) {
    let over = sum - frames
    for (let w = safeWorkers - 1; w >= 0 && over > 0; w -= 1) {
      const take = Math.min(over, sizes[w] ?? 0)
      sizes[w] -= take
      over -= take
    }
  }

  const chunks: FrameChunk[] = []
  let cursor = 0
  for (let w = 0; w < safeWorkers; w += 1) {
    const size = Math.max(0, sizes[w] ?? 0)
    const startFrame = cursor
    const endFrame = cursor + size
    cursor = endFrame
    chunks.push({ workerIndex: w, startFrame, endFrame })
  }

  if (chunks.length > 0 && cursor < frames) {
    chunks[chunks.length - 1].endFrame = frames
  }

  return chunks.length > 0 ? chunks : [{ workerIndex: 0, startFrame: 0, endFrame: frames }]
}

/** Any positive integer is valid concurrency. */
export function clampConcurrency(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.max(1, Math.floor(value))
}

/** Minimum chunk size in frames (~≥1s). */
export function minChunkFrames(fps: number): number {
  const safeFps = Math.max(1, Math.floor(fps) || 60)
  return Math.max(60, safeFps)
}

/** Maximum chunk size in frames (~≤15s). */
export function maxChunkFrames(fps: number): number {
  const safeFps = Math.max(1, Math.floor(fps) || 60)
  return safeFps * 15
}

/**
 * Dynamic chunk size from remaining frames / thread count / retry pressure.
 * "Minimum" means minChunk (block size floor), not a pool size.
 */
export function nextChunkSize(
  remainingFrames: number,
  concurrency: number,
  fps: number,
  stats: ChunkSizeStats = {}
): number {
  const remaining = Math.max(0, Math.floor(remainingFrames))
  if (remaining <= 0) return 0

  const n = clampConcurrency(concurrency)
  const minC = minChunkFrames(fps)
  const maxC = maxChunkFrames(fps)

  // Prefer finer chunks so a finished worker can attach at mid-story boundaries.
  // concurrency=1 still used per-lane mint, but keep pieces small enough for parallel attach.
  let chunk = Math.ceil(remaining / Math.max(4 * n, 4))

  const retries = Math.max(0, stats.recentRetries ?? 0)
  const stable = Math.max(0, stats.recentStable ?? 0)
  if (retries > 0) {
    chunk = Math.floor(chunk / Math.min(4, 1 + retries))
  } else if (stable >= 3) {
    // Mild growth only — avoid giant second-half monopolies.
    chunk = Math.floor(chunk * 1.1)
  }

  if (remaining <= minC * 2) {
    return remaining
  }

  // Cap max chunk tighter (~8s) for faster handoff between workers.
  const handoffMax = Math.min(maxC, safeFpsFrom(fps) * 8)
  return Math.max(minC, Math.min(handoffMax, Math.max(1, chunk), remaining))
}

function safeFpsFrom(fps: number): number {
  return Math.max(1, Math.floor(fps) || 60)
}

export type LaneState = {
  slotId: number
  laneStart: number
  laneEnd: number
  /** Next unminted frame inside this lane. */
  nextFrame: number
}

/**
 * Lane scheduler: each worker owns one contiguous frame range.
 * Jobs are minted only within that lane so sticky continue always works
 * after the first warm-up to laneStart. Cross-lane steal is forbidden.
 */
export type LaneJobPlanner = {
  totalFrames: number
  lanes: LaneState[]
  nextJobId: number
  /** Mint the entire remaining lane as one job (no secondary split). */
  takeForSlot(
    slotId: number,
    fps?: number,
    stats?: ChunkSizeStats
  ): Omit<ExportJob, 'segmentPath' | 'sessionKey' | 'attempts'> | null
  /**
   * Drain unminted remainder of a slot's lane into at most one job.
   * Sticky-only: jobs must stay on the same slot (no cross-slot cold warm-up).
   */
  abandonSlotRemainder(
    slotId: number,
    fps?: number,
    stats?: ChunkSizeStats
  ): Array<Omit<ExportJob, 'segmentPath' | 'sessionKey' | 'attempts'>>
  hasRemaining(): boolean
  remainingInSlot(slotId: number): number
  /** Grow total frames and append extra range onto the last lane (tail extension). */
  extendTotalFrames(newTotal: number): void
  /** Shrink planning horizon to known story end (trim black tail). */
  shrinkTotalFrames(newTotal: number): void
  /** Smallest unminted start across lanes, or null if done. */
  nextGlobalUnminted(): number | null
}

export function createLaneJobPlanner(totalFrames: number, workers: number): LaneJobPlanner {
  const frames = Math.max(0, Math.floor(totalFrames))
  const n = clampConcurrency(workers)
  const lanes: LaneState[] = planFrameChunks(frames, n).map((c) => ({
    slotId: c.workerIndex,
    laneStart: c.startFrame,
    laneEnd: c.endFrame,
    nextFrame: c.startFrame
  }))

  return {
    totalFrames: frames,
    lanes,
    nextJobId: 0,
    takeForSlot(slotId: number) {
      const lane = this.lanes.find((l) => l.slotId === slotId)
      if (!lane) return null
      if (lane.nextFrame >= lane.laneEnd) return null
      // One job per lane: take the entire remaining range (no secondary split).
      const startFrame = lane.nextFrame
      const endFrame = lane.laneEnd
      lane.nextFrame = endFrame
      const jobId = this.nextJobId
      this.nextJobId += 1
      return { jobId, startFrame, endFrame, slotId }
    },
    abandonSlotRemainder(slotId: number) {
      const planned = this.takeForSlot(slotId)
      return planned ? [planned] : []
    },
    hasRemaining() {
      return this.lanes.some((l) => l.nextFrame < l.laneEnd)
    },
    remainingInSlot(slotId: number) {
      const lane = this.lanes.find((l) => l.slotId === slotId)
      if (!lane) return 0
      return Math.max(0, lane.laneEnd - lane.nextFrame)
    },
    extendTotalFrames(newTotal: number) {
      const target = Math.max(this.totalFrames, Math.floor(newTotal))
      if (target <= this.totalFrames) return
      const extra = target - this.totalFrames
      this.totalFrames = target
      if (this.lanes.length === 0) {
        this.lanes.push({
          slotId: 0,
          laneStart: 0,
          laneEnd: target,
          nextFrame: 0
        })
        return
      }
      // Append tail extension to the last lane so sticky workers can continue.
      const last = this.lanes[this.lanes.length - 1]
      last.laneEnd += extra
    },
    shrinkTotalFrames(newTotal: number) {
      const target = Math.max(0, Math.floor(newTotal))
      if (target >= this.totalFrames) return
      this.totalFrames = target
      for (const lane of this.lanes) {
        if (lane.laneStart >= target) {
          lane.laneStart = target
          lane.laneEnd = target
          lane.nextFrame = target
          continue
        }
        if (lane.laneEnd > target) lane.laneEnd = target
        if (lane.nextFrame > target) lane.nextFrame = target
      }
    },
    nextGlobalUnminted() {
      let best: number | null = null
      for (const lane of this.lanes) {
        if (lane.nextFrame < lane.laneEnd) {
          if (best === null || lane.nextFrame < best) best = lane.nextFrame
        }
      }
      return best
    }
  }
}

/** @deprecated use createLaneJobPlanner — kept for any external callers */
export type JobPlanner = {
  totalFrames: number
  nextFrame: number
  nextJobId: number
  takeNext(
    concurrency: number,
    fps: number,
    stats?: ChunkSizeStats
  ): Omit<ExportJob, 'segmentPath' | 'sessionKey' | 'attempts'> | null
}

export function createJobPlanner(totalFrames: number): JobPlanner {
  const frames = Math.max(0, Math.floor(totalFrames))
  return {
    totalFrames: frames,
    nextFrame: 0,
    nextJobId: 0,
    takeNext(concurrency: number, fps: number, stats?: ChunkSizeStats) {
      if (this.nextFrame >= this.totalFrames) return null
      const remaining = this.totalFrames - this.nextFrame
      const size = nextChunkSize(remaining, concurrency, fps, stats)
      if (size <= 0) return null
      const startFrame = this.nextFrame
      const endFrame = Math.min(this.totalFrames, startFrame + size)
      this.nextFrame = endFrame
      const jobId = this.nextJobId
      this.nextJobId += 1
      return { jobId, startFrame, endFrame }
    }
  }
}

export function buildJobPaths(
  sessionId: string,
  tempDir: string,
  job: { jobId: number; startFrame: number; endFrame: number }
): Pick<ExportJob, 'segmentPath' | 'sessionKey'> {
  const segmentPath = `${tempDir.replace(/\\/g, '/')}/seg_${String(job.jobId).padStart(4, '0')}.mp4`
  const sessionKey = `${sessionId}_j${job.jobId}`
  return { segmentPath, sessionKey }
}

/** Prefer sticky start==lastEnd, else lowest startFrame. */
export function pickNextJob<T extends { startFrame: number; endFrame: number }>(
  freeJobs: T[],
  lastEndFrame: number | null
): T | null {
  if (freeJobs.length === 0) return null
  if (lastEndFrame !== null) {
    const sticky = freeJobs.find((j) => j.startFrame === lastEndFrame)
    if (sticky) return sticky
  }
  return (
    [...freeJobs].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)[0] ?? null
  )
}
