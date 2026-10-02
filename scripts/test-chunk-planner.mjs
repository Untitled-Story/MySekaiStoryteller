/**
 * Targeted invariants for the export chunk/lane planner (pure TS, no DOM).
 * Run with: node scripts/test-chunk-planner.mjs
 *
 * Node >= 22.6 strips types natively, so we import the .ts module directly.
 */
import assert from 'node:assert/strict'
import {
  planFrameChunks,
  clampConcurrency,
  minChunkFrames,
  maxChunkFrames,
  nextChunkSize,
  createLaneJobPlanner,
  pickNextJob
} from '../src/story/chunkPlanner.ts'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok - ${name}`)
}

console.log('chunkPlanner: planFrameChunks invariants')

// Contiguity + full coverage [0, total) for a sweep of (frames, workers).
check('coverage [0,total) and contiguity across a sweep', () => {
  for (const total of [0, 1, 7, 64, 3600, 99_999]) {
    for (const workers of [1, 2, 3, 4, 8, 1000]) {
      const chunks = planFrameChunks(total, workers)
      const n = clampConcurrency(workers)
      // Exactly one chunk per active worker when total>0.
      assert.equal(chunks.length, total === 0 ? 1 : n, `chunk count total=${total} n=${n}`)
      let cursor = 0
      for (let i = 0; i < chunks.length; i += 1) {
        const c = chunks[i]
        assert.equal(c.workerIndex, i, 'workerIndex is dense 0..n-1')
        assert.equal(c.startFrame, cursor, `contiguity at ${i} total=${total}`)
        assert.ok(c.endFrame >= c.startFrame, 'end >= start')
        cursor = c.endFrame
      }
      assert.equal(cursor, total, `union covers [0,${total})`)
    }
  }
})

check('zero frames yields a single empty chunk on worker 0', () => {
  assert.deepEqual(planFrameChunks(0, 4), [{ workerIndex: 0, startFrame: 0, endFrame: 0 }])
})

console.log('chunkPlanner: concurrency clamp')
check('clampConcurrency guards non-finite / <1', () => {
  assert.equal(clampConcurrency(undefined), 1)
  assert.equal(clampConcurrency(NaN), 1)
  assert.equal(clampConcurrency(0), 1)
  assert.equal(clampConcurrency(-5), 1)
  assert.equal(clampConcurrency(2.9), 2)
  assert.equal(clampConcurrency(4), 4)
})

console.log('chunkPlanner: chunk-size bounds')
check('min/max chunk frames scale with fps', () => {
  assert.ok(minChunkFrames(60) <= maxChunkFrames(60))
  assert.equal(maxChunkFrames(60), 60 * 15)
  assert.ok(minChunkFrames(30) < minChunkFrames(60) || minChunkFrames(30) === 60)
})
check('nextChunkSize respects bounds and remaining', () => {
  // Very small remaining returns the remaining as-is.
  assert.equal(nextChunkSize(0, 4, 60), 0)
  const small = nextChunkSize(10, 4, 60)
  assert.equal(small, 10, 'tiny remaining returns remaining')
  const big = nextChunkSize(10_000, 4, 60)
  assert.ok(big >= minChunkFrames(60), '>= min chunk')
  assert.ok(big <= maxChunkFrames(60), '<= max chunk')
  assert.ok(big < 10_000, 'smaller than remaining when plenty left')
})

console.log('chunkPlanner: lane planner (sticky lanes, no cross-lane steal)')

// Helper: after any mint/shrink/extend, the unminted lanes must stay a
// contiguous partition of [0, totalFrames) with no overlap.
function assertPartitionPlanner(planner, expectTotal) {
  assert.equal(planner.totalFrames, expectTotal, 'planner totalFrames')
  const lanes = [...planner.lanes].sort((a, b) => a.laneStart - b.laneStart)
  let cursor = 0
  for (const lane of lanes) {
    assert.equal(lane.laneStart, cursor, `lane contiguity at ${cursor}`)
    assert.ok(lane.laneEnd >= lane.laneStart, 'lane end >= start')
    // nextFrame must be within the lane bounds.
    assert.ok(
      lane.nextFrame >= lane.laneStart && lane.nextFrame <= lane.laneEnd,
      'nextFrame within lane'
    )
    cursor = lane.laneEnd
  }
  assert.equal(cursor, expectTotal, `union covers [0,${expectTotal})`)
}

check('lanes partition [0,total) for a sweep', () => {
  for (const total of [0, 1, 9, 3600, 99_999]) {
    for (const workers of [1, 2, 3, 4]) {
      const planner = createLaneJobPlanner(total, workers)
      assertPartitionPlanner(planner, Math.max(0, total))
    }
  }
})

check('takeForSlot mints only within a lane and sticky-drains it', () => {
  const planner = createLaneJobPlanner(1000, 2)
  // 2 lanes: [0,500), [500,1000).
  const j0 = planner.takeForSlot(0)
  assert.ok(j0, 'slot 0 has a job')
  assert.equal(j0.startFrame, 0)
  assert.equal(j0.endFrame, 500)
  assert.equal(planner.remainingInSlot(0), 0, 'slot 0 drained')
  assert.equal(planner.remainingInSlot(1), 500, 'slot 1 untouched')
  const j1 = planner.takeForSlot(1)
  assert.equal(j1.startFrame, 500)
  assert.equal(j1.endFrame, 1000)
  assert.equal(planner.hasRemaining(), false)
  assert.equal(planner.nextGlobalUnminted(), null)
  // Jobs are numbered monotonically.
  assert.equal(j1.jobId, j0.jobId + 1)
})

check('extendTotalFrames appends tail to last lane keeping partition', () => {
  const planner = createLaneJobPlanner(100, 2)
  planner.takeForSlot(0)
  planner.extendTotalFrames(200)
  assertPartitionPlanner(planner, 200)
  // The extension went onto the last lane; slot 0 stays drained.
  assert.equal(planner.remainingInSlot(0), 0)
  assert.equal(planner.remainingInSlot(1), 150, 'last lane absorbed the tail')
  // Slot 1's lane is [50,200) and was never minted, so its first frame is 50.
  assert.equal(planner.nextGlobalUnminted(), 50, 'first unminted is lane 1 start')
})

check('shrinkTotalFrames trims tail without breaking partition', () => {
  const planner = createLaneJobPlanner(1000, 2)
  planner.shrinkTotalFrames(600)
  assertPartitionPlanner(planner, 600)
  assert.equal(planner.remainingInSlot(0), 500, 'slot 0 still [0,500)')
  assert.equal(planner.remainingInSlot(1), 100, 'slot 1 trimmed to [500,600)')
})

check('extend after shrink keeps a valid partition', () => {
  const planner = createLaneJobPlanner(1000, 3)
  planner.shrinkTotalFrames(300)
  planner.extendTotalFrames(450)
  assertPartitionPlanner(planner, 450)
  assert.equal(planner.hasRemaining(), true)
})

console.log('chunkPlanner: pickNextJob sticky preference')
check('prefers sticky start==lastEnd, else lowest start', () => {
  const jobs = [
    { jobId: 0, startFrame: 0, endFrame: 100 },
    { jobId: 1, startFrame: 100, endFrame: 200 },
    { jobId: 2, startFrame: 200, endFrame: 300 }
  ]
  // Sticky: lastEnd=100 -> job starting at 100 even though a lower start exists elsewhere.
  assert.equal(pickNextJob(jobs, 100)?.jobId, 1, 'sticky match')
  // No sticky match: lowest startFrame.
  assert.equal(pickNextJob(jobs, 999)?.jobId, 0, 'falls back to lowest start')
  // Empty.
  assert.equal(pickNextJob([], 100), null)
  // null lastEnd -> lowest start.
  assert.equal(pickNextJob(jobs, null)?.jobId, 0)
})

// Forward-only semantic: a worker whose sticky position is past a job's start
// must not take that backward job. pickNextJob returns sticky-or-lowest; the
// backward rejection is enforced by the caller, but the planner must expose a
// job that a forward worker would reject.
check('forward rejection: job strictly behind lastEnd is not sticky', () => {
  const jobs = [
    { jobId: 0, startFrame: 0, endFrame: 100 },
    { jobId: 1, startFrame: 100, endFrame: 200 }
  ]
  // Worker already at frame 300: no sticky job (none starts at 300), so it
  // falls back to the lowest start (job 0), which it must reject (backward).
  const picked = pickNextJob(jobs, 300)
  assert.ok(picked, 'a job is still returned for the caller to evaluate')
  assert.ok(picked.startFrame < 300, 'caller sees a backward job to reject')
})

console.log(`\nchunk-planner: ${passed} checks passed`)
