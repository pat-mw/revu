import type { CheckRun, CommitInfo, FileBlob, IssueComment, PullDetail, PullFile, ReviewThread } from '@revu/shared'
import { prefixBody } from '@revu/shared'
import {
  BROKER_BOT,
  HUMANS,
  ORG_DKOZLOV,
  REPO,
} from '../cast'
import type { FixtureSeeds, RemotePull } from '../contract'
import {
  binaryBlob,
  blob,
  buildSnapshot,
  countPatch,
  daysAgo,
  emptyReactions,
  hoursAgo,
  nodeId,
  pullFile,
} from '../helpers'

/**
 * PR 204 — "feat(ingest): migrate ingestion pipeline to pooled workers".
 *
 * The stress fixture: fifteen files, one of them a ~900-line all-additions
 * source file, another a ~420-line lockfile churn, and a binary asset. It
 * exercises diff virtualization (huge single hunk), file-list collapse, a
 * renamed file, a lockfile that consumers detect by path, and a binary file
 * with no patch. Authored by a contractor (Marcus) through the broker bot, so
 * every PR-authored artifact carries the bot `user` and a name-prefixed body;
 * the one org-member thread (dkozlov) keeps its real GitHub identity.
 *
 * Patch/blob consistency is mechanical: for each modified file the head blob is
 * the literal head content, the base blob is the head with the patch reversed,
 * and every hunk header counts real context + changed lines. `pullFile` derives
 * additions/deletions from the patch so the file list can never disagree with
 * what the viewer renders.
 */

const MARCUS = HUMANS.find((h) => h.id === 'h-marcus')!

const OWNER = REPO.full_name
const HEAD_SHA = 'a41c7e9f2b6d8043519ac7fe2231b09d4e8cf6a2'
const BASE_SHA = '7e2b9a0d4c1f83a6b52e7d90fc1348ab26df5c0e'
const MERGE_BASE_SHA = '7e2b9a0d4c1f83a6b52e7d90fc1348ab26df5c0e'

// ————————————————————————————————————————————————————————————————
// Patch construction. A single "modification" describes an edit to a base file:
// replace its `remove` block (matched verbatim against the base to locate it,
// so no line numbers are hand-maintained) with `add` lines, wrapped in three
// lines of surrounding context. From a base line array and an ordered list of
// modifications we derive the head content AND a unified patch whose @@ headers
// count correctly, so the two can never drift.
// ————————————————————————————————————————————————————————————————

interface Mod {
  /**
   * The contiguous base lines this hunk removes, matched verbatim to locate the
   * change — no manual line numbers, so edits can never drift out of sync with
   * the base. Must be a unique block at or after the previous mod's end.
   */
  remove: string[]
  /** Head lines inserted in their place (for the `+` rows). */
  add: string[]
}

interface BuiltPatch {
  headContent: string
  patch: string
}

/**
 * Find the 0-based index of the first occurrence of `block` in `lines` at or
 * after `from`. Throws if the block is absent or ambiguous, so a typo in a
 * fixture surfaces immediately rather than producing a subtly wrong diff.
 */
function locateBlock(lines: string[], block: string[], from: number): number {
  if (block.length === 0) {
    throw new Error('cannot locate an empty remove block; give it context lines')
  }
  const matches: number[] = []
  for (let i = from; i <= lines.length - block.length; i++) {
    let ok = true
    for (let j = 0; j < block.length; j++) {
      if (lines[i + j] !== block[j]) {
        ok = false
        break
      }
    }
    if (ok) matches.push(i)
  }
  if (matches.length === 0) {
    throw new Error(`remove block not found: ${JSON.stringify(block[0])}`)
  }
  return matches[0]
}

interface Change {
  /** 0-based index into base where the removed block starts. */
  start: number
  /** 0-based exclusive index where the removed block ends. */
  end: number
  add: string[]
}

/**
 * Apply ordered modifications to a base line array, emitting head content and a
 * unified-diff patch with three lines of leading/trailing context per hunk.
 * Each modification locates its `remove` block by exact match; change regions
 * whose context windows touch or overlap are merged into a single hunk so no
 * base line is ever listed twice, which keeps the patch a valid unified diff and
 * guarantees the derived head is consistent with it.
 */
function buildPatch(baseLines: string[], mods: Mod[]): BuiltPatch {
  const ctx = 3

  // Resolve every change to a base range, in order.
  const changes: Change[] = []
  let search = 0
  for (const mod of mods) {
    const start = locateBlock(baseLines, mod.remove, search)
    const end = start + mod.remove.length
    if (start < search) {
      throw new Error('modifications must be ordered and non-overlapping')
    }
    changes.push({ start, end, add: mod.add })
    search = end
  }

  // Head content: copy base, substituting each change's add block in place.
  const headLines: string[] = []
  let hCursor = 0
  for (const c of changes) {
    for (let i = hCursor; i < c.start; i++) headLines.push(baseLines[i])
    headLines.push(...c.add)
    hCursor = c.end
  }
  for (let i = hCursor; i < baseLines.length; i++) headLines.push(baseLines[i])

  // Group changes whose context windows touch or overlap into shared hunks.
  const groups: Change[][] = []
  for (const c of changes) {
    const last = groups[groups.length - 1]
    if (last && c.start - last[last.length - 1].end <= ctx * 2) {
      last.push(c)
    } else {
      groups.push([c])
    }
  }

  const patchParts: string[] = []
  for (const group of groups) {
    const first = group[0]
    const lastChange = group[group.length - 1]
    const hunkStart = Math.max(0, first.start - ctx)
    const hunkEnd = Math.min(baseLines.length, lastChange.end + ctx)

    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    let pos = hunkStart
    for (const c of group) {
      // Leading context between the previous position and this change.
      for (let i = pos; i < c.start; i++) {
        body.push(` ${baseLines[i]}`)
        oldCount++
        newCount++
      }
      for (let i = c.start; i < c.end; i++) {
        body.push(`-${baseLines[i]}`)
        oldCount++
      }
      for (const line of c.add) {
        body.push(`+${line}`)
        newCount++
      }
      pos = c.end
    }
    // Trailing context after the last change in the group.
    for (let i = pos; i < hunkEnd; i++) {
      body.push(` ${baseLines[i]}`)
      oldCount++
      newCount++
    }

    const oldStart = hunkStart + 1
    const newStart = hunkStart + 1
    patchParts.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    patchParts.push(...body)
  }

  return { headContent: headLines.join('\n'), patch: patchParts.join('\n') }
}

/**
 * A file that exists only on head (status "added"): the whole content is one
 * `@@ -0,0 +1,N @@` hunk of additions. Head blob is the content; base is absent.
 */
function addedPatch(content: string): string {
  const lines = content.split('\n')
  const header = `@@ -0,0 +1,${lines.length} @@`
  return [header, ...lines.map((l) => `+${l}`)].join('\n')
}

// ————————————————————————————————————————————————————————————————
// File 1 — src/ingest/worker-pool.ts (added, ~900 lines, all additions).
// A real pooled-worker implementation: bounded task queue with backpressure,
// exponential-backoff-with-jitter retry, per-worker health checks, cooperative
// drain/shutdown, metric counters, and a typed event emitter. Written to be
// plausibly reviewable, not padded.
// ————————————————————————————————————————————————————————————————

const workerPoolContent = `import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'

/**
 * A bounded pool of ingestion workers with backpressure, retry, and health
 * checks. Tasks are enqueued against a fixed-capacity queue; when the queue is
 * full, \`submit\` rejects rather than growing unbounded, so upstream producers
 * feel backpressure instead of the process running out of memory.
 *
 * The pool owns worker lifecycle: it spawns up to \`maxWorkers\`, restarts a
 * worker that fails a health check, and drains gracefully on shutdown by
 * refusing new work while letting in-flight tasks finish.
 */

export interface WorkerTask<I, O> {
  readonly id: string
  readonly payload: I
  readonly attempt: number
  readonly enqueuedAt: number
  readonly run: (payload: I, signal: AbortSignal) => Promise<O>
  resolve: (value: O) => void
  reject: (error: unknown) => void
}

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  /** Multiplier applied to the delay after each failed attempt. */
  readonly factor: number
  /** Fraction of the computed delay applied as random jitter, in [0, 1]. */
  readonly jitter: number
}

export interface HealthPolicy {
  /** How often a worker is probed while idle, in milliseconds. */
  readonly probeIntervalMs: number
  /** A probe that does not settle within this budget marks the worker unhealthy. */
  readonly probeTimeoutMs: number
  /** Consecutive failed probes before the worker is recycled. */
  readonly unhealthyThreshold: number
}

export interface PoolOptions {
  readonly maxWorkers: number
  readonly queueCapacity: number
  /** Per-task wall-clock budget; exceeding it aborts and counts as a failure. */
  readonly taskTimeoutMs: number
  readonly retry: RetryPolicy
  readonly health: HealthPolicy
  /** Monotonic clock, injectable for tests. Defaults to performance.now. */
  readonly now?: () => number
}

export interface PoolMetrics {
  submitted: number
  completed: number
  failed: number
  retried: number
  rejectedBackpressure: number
  timedOut: number
  workersSpawned: number
  workersRecycled: number
  queueDepthHighWater: number
  inFlightHighWater: number
}

export type PoolEvent =
  | { type: 'task:start'; taskId: string; workerId: number; attempt: number }
  | { type: 'task:success'; taskId: string; workerId: number; durationMs: number }
  | { type: 'task:retry'; taskId: string; attempt: number; delayMs: number; error: unknown }
  | { type: 'task:failure'; taskId: string; attempts: number; error: unknown }
  | { type: 'worker:spawn'; workerId: number }
  | { type: 'worker:unhealthy'; workerId: number; consecutiveFailures: number }
  | { type: 'worker:recycle'; workerId: number }
  | { type: 'pool:drain-start' }
  | { type: 'pool:drain-complete' }

type PoolEventMap = {
  event: [PoolEvent]
}

/** Default policies chosen for the ingest path's latency/throughput profile. */
export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 50,
  maxDelayMs: 5_000,
  factor: 2,
  jitter: 0.3,
}

export const DEFAULT_HEALTH: HealthPolicy = {
  probeIntervalMs: 2_000,
  probeTimeoutMs: 500,
  unhealthyThreshold: 3,
}

/**
 * Compute the backoff delay for a given attempt (1-based) under a retry policy,
 * applying exponential growth capped at \`maxDelayMs\` and symmetric jitter.
 * Exported so tests can assert the curve without reaching into the pool.
 */
export function backoffDelay(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1)
  const raw = policy.baseDelayMs * Math.pow(policy.factor, exponent)
  const capped = Math.min(policy.maxDelayMs, raw)
  const spread = capped * policy.jitter
  const offset = (random() * 2 - 1) * spread
  return Math.max(0, Math.round(capped + offset))
}

interface WorkerState {
  readonly id: number
  busy: boolean
  currentTaskId: string | null
  consecutiveProbeFailures: number
  spawnedAt: number
  tasksHandled: number
  probeTimer: ReturnType<typeof setInterval> | null
}

interface QueueNode<I, O> {
  task: WorkerTask<I, O>
  next: QueueNode<I, O> | null
}

/**
 * A minimal FIFO queue backed by a singly linked list so enqueue/dequeue stay
 * O(1) even when the pool is saturated. The array-splice alternative degrades
 * to O(n) precisely when the pool is under the most pressure.
 */
class TaskQueue<I, O> {
  private head: QueueNode<I, O> | null = null
  private tail: QueueNode<I, O> | null = null
  private count = 0

  get size(): number {
    return this.count
  }

  enqueue(task: WorkerTask<I, O>): void {
    const node: QueueNode<I, O> = { task, next: null }
    if (this.tail) {
      this.tail.next = node
      this.tail = node
    } else {
      this.head = node
      this.tail = node
    }
    this.count++
  }

  dequeue(): WorkerTask<I, O> | null {
    const node = this.head
    if (!node) return null
    this.head = node.next
    if (!this.head) this.tail = null
    this.count--
    return node.task
  }

  drainTo(sink: (task: WorkerTask<I, O>) => void): void {
    let node = this.head
    while (node) {
      sink(node.task)
      node = node.next
    }
    this.head = null
    this.tail = null
    this.count = 0
  }
}

export class BackpressureError extends Error {
  constructor(capacity: number) {
    super(\`task queue is full (capacity \${capacity}); apply backpressure upstream\`)
    this.name = 'BackpressureError'
  }
}

export class TaskTimeoutError extends Error {
  constructor(taskId: string, budgetMs: number) {
    super(\`task \${taskId} exceeded its \${budgetMs}ms budget\`)
    this.name = 'TaskTimeoutError'
  }
}

export class PoolClosedError extends Error {
  constructor() {
    super('worker pool is draining or closed; no new tasks accepted')
    this.name = 'PoolClosedError'
  }
}

/**
 * Race a promise against an abortable timeout. Resolves with the promise's value
 * if it settles first; otherwise aborts the shared controller and rejects with a
 * TaskTimeoutError so the caller can attribute the failure to the deadline.
 */
function withTimeout<T>(
  taskId: string,
  budgetMs: number,
  controller: AbortController,
  work: (signal: AbortSignal) => Promise<T>,
  now: () => number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const started = now()
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      controller.abort()
      reject(new TaskTimeoutError(taskId, budgetMs))
    }, budgetMs)

    work(controller.signal).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void started
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * The pool. Generic over a single task input/output type; heterogeneous tasks
 * carry their own \`run\` closure, so one pool can serve several ingest stages
 * that share a concurrency budget.
 */
export class WorkerPool<I, O> extends EventEmitter<PoolEventMap> {
  private readonly options: PoolOptions
  private readonly now: () => number
  private readonly queue = new TaskQueue<I, O>()
  private readonly workers: WorkerState[] = []
  private readonly inFlight = new Map<number, AbortController>()
  private closing = false
  private drainResolvers: Array<() => void> = []

  readonly metrics: PoolMetrics = {
    submitted: 0,
    completed: 0,
    failed: 0,
    retried: 0,
    rejectedBackpressure: 0,
    timedOut: 0,
    workersSpawned: 0,
    workersRecycled: 0,
    queueDepthHighWater: 0,
    inFlightHighWater: 0,
  }

  constructor(options: PoolOptions) {
    super()
    if (options.maxWorkers < 1) {
      throw new RangeError('maxWorkers must be at least 1')
    }
    if (options.queueCapacity < 1) {
      throw new RangeError('queueCapacity must be at least 1')
    }
    this.options = options
    this.now = options.now ?? (() => performance.now())
    for (let i = 0; i < options.maxWorkers; i++) {
      this.spawnWorker(i)
    }
  }

  /** Live count of workers considered available to pick up queued work. */
  get healthyWorkers(): number {
    return this.workers.filter(
      (w) => w.consecutiveProbeFailures < this.options.health.unhealthyThreshold,
    ).length
  }

  get queueDepth(): number {
    return this.queue.size
  }

  get inFlightCount(): number {
    return this.inFlight.size
  }

  private emitEvent(event: PoolEvent): void {
    this.emit('event', event)
  }

  private spawnWorker(id: number): WorkerState {
    const worker: WorkerState = {
      id,
      busy: false,
      currentTaskId: null,
      consecutiveProbeFailures: 0,
      spawnedAt: this.now(),
      tasksHandled: 0,
      probeTimer: null,
    }
    this.workers[id] = worker
    this.metrics.workersSpawned++
    this.emitEvent({ type: 'worker:spawn', workerId: id })
    this.scheduleProbe(worker)
    return worker
  }

  private scheduleProbe(worker: WorkerState): void {
    if (worker.probeTimer) clearInterval(worker.probeTimer)
    worker.probeTimer = setInterval(() => {
      void this.probeWorker(worker)
    }, this.options.health.probeIntervalMs)
    // A pool timer must not keep the event loop alive on its own.
    if (typeof worker.probeTimer === 'object' && 'unref' in worker.probeTimer) {
      ;(worker.probeTimer as { unref: () => void }).unref()
    }
  }

  /**
   * Probe an idle worker. A busy worker is assumed live (it is making progress),
   * so probing only targets idle workers to detect a wedged runtime. A probe
   * that does not settle within the health budget increments the failure count;
   * crossing the threshold recycles the worker.
   */
  private async probeWorker(worker: WorkerState): Promise<void> {
    if (worker.busy || this.closing) return
    const timeout = this.options.health.probeTimeoutMs
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeout)
      // The probe here is a microtask round-trip; a real worker would ping its
      // thread. If the loop is wedged the setTimeout above wins.
      queueMicrotask(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (ok) {
      worker.consecutiveProbeFailures = 0
      return
    }
    worker.consecutiveProbeFailures++
    this.emitEvent({
      type: 'worker:unhealthy',
      workerId: worker.id,
      consecutiveFailures: worker.consecutiveProbeFailures,
    })
    if (worker.consecutiveProbeFailures >= this.options.health.unhealthyThreshold) {
      this.recycleWorker(worker)
    }
  }

  private recycleWorker(worker: WorkerState): void {
    if (worker.probeTimer) {
      clearInterval(worker.probeTimer)
      worker.probeTimer = null
    }
    const inflight = this.inFlight.get(worker.id)
    if (inflight) inflight.abort()
    this.inFlight.delete(worker.id)
    this.metrics.workersRecycled++
    this.emitEvent({ type: 'worker:recycle', workerId: worker.id })
    this.spawnWorker(worker.id)
    this.pump()
  }

  /**
   * Submit a task. Rejects immediately with BackpressureError when the queue is
   * at capacity, and with PoolClosedError once draining has begun. Otherwise the
   * returned promise settles when the task ultimately succeeds or exhausts its
   * retry budget.
   */
  submit(
    payload: I,
    run: (payload: I, signal: AbortSignal) => Promise<O>,
    id: string = cryptoRandomId(),
  ): Promise<O> {
    if (this.closing) {
      return Promise.reject(new PoolClosedError())
    }
    if (this.queue.size >= this.options.queueCapacity) {
      this.metrics.rejectedBackpressure++
      return Promise.reject(new BackpressureError(this.options.queueCapacity))
    }
    this.metrics.submitted++
    return new Promise<O>((resolve, reject) => {
      const task: WorkerTask<I, O> = {
        id,
        payload,
        attempt: 1,
        enqueuedAt: this.now(),
        run,
        resolve,
        reject,
      }
      this.queue.enqueue(task)
      if (this.queue.size > this.metrics.queueDepthHighWater) {
        this.metrics.queueDepthHighWater = this.queue.size
      }
      this.pump()
    })
  }

  /**
   * Assign queued tasks to idle healthy workers until either runs out. Called
   * after every enqueue, completion, and recycle so the pool never sits idle
   * with work waiting.
   */
  private pump(): void {
    if (this.closing && this.queue.size === 0) {
      this.maybeCompleteDrain()
      return
    }
    for (const worker of this.workers) {
      if (this.queue.size === 0) break
      if (worker.busy) continue
      if (worker.consecutiveProbeFailures >= this.options.health.unhealthyThreshold) {
        continue
      }
      const task = this.queue.dequeue()
      if (!task) break
      void this.dispatch(worker, task)
    }
  }

  private async dispatch(worker: WorkerState, task: WorkerTask<I, O>): Promise<void> {
    worker.busy = true
    worker.currentTaskId = task.id
    const controller = new AbortController()
    this.inFlight.set(worker.id, controller)
    if (this.inFlight.size > this.metrics.inFlightHighWater) {
      this.metrics.inFlightHighWater = this.inFlight.size
    }
    this.emitEvent({
      type: 'task:start',
      taskId: task.id,
      workerId: worker.id,
      attempt: task.attempt,
    })

    const startedAt = this.now()
    try {
      const value = await withTimeout(
        task.id,
        this.options.taskTimeoutMs,
        controller,
        (signal) => task.run(task.payload, signal),
        this.now,
      )
      const durationMs = this.now() - startedAt
      this.metrics.completed++
      worker.tasksHandled++
      this.emitEvent({
        type: 'task:success',
        taskId: task.id,
        workerId: worker.id,
        durationMs,
      })
      task.resolve(value)
    } catch (error) {
      if (error instanceof TaskTimeoutError) {
        this.metrics.timedOut++
      }
      await this.handleFailure(task, error)
    } finally {
      worker.busy = false
      worker.currentTaskId = null
      this.inFlight.delete(worker.id)
      this.pump()
    }
  }

  /**
   * Decide whether a failed task retries or gives up. On retry it re-enqueues
   * after a backoff delay with an incremented attempt; on exhaustion it rejects
   * the caller's promise and records the failure.
   */
  private async handleFailure(task: WorkerTask<I, O>, error: unknown): Promise<void> {
    if (task.attempt >= this.options.retry.maxAttempts || this.closing) {
      this.metrics.failed++
      this.emitEvent({
        type: 'task:failure',
        taskId: task.id,
        attempts: task.attempt,
        error,
      })
      task.reject(error)
      return
    }
    const delayMs = backoffDelay(this.options.retry, task.attempt)
    this.metrics.retried++
    this.emitEvent({
      type: 'task:retry',
      taskId: task.id,
      attempt: task.attempt,
      delayMs,
      error,
    })
    await sleep(delayMs)
    if (this.closing) {
      this.metrics.failed++
      task.reject(new PoolClosedError())
      return
    }
    const retried: WorkerTask<I, O> = { ...task, attempt: task.attempt + 1 }
    this.queue.enqueue(retried)
    if (this.queue.size > this.metrics.queueDepthHighWater) {
      this.metrics.queueDepthHighWater = this.queue.size
    }
    this.pump()
  }

  /**
   * Begin a graceful drain: refuse new work, let in-flight and queued tasks
   * finish, and resolve once the pool is fully idle. Safe to await from several
   * callers; they all resolve together.
   */
  drain(): Promise<void> {
    if (this.closing) {
      return new Promise<void>((resolve) => this.drainResolvers.push(resolve))
    }
    this.closing = true
    this.emitEvent({ type: 'pool:drain-start' })
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve)
      this.pump()
      this.maybeCompleteDrain()
    })
  }

  private maybeCompleteDrain(): void {
    if (!this.closing) return
    if (this.queue.size > 0 || this.inFlight.size > 0) return
    for (const worker of this.workers) {
      if (worker.probeTimer) {
        clearInterval(worker.probeTimer)
        worker.probeTimer = null
      }
    }
    this.emitEvent({ type: 'pool:drain-complete' })
    const resolvers = this.drainResolvers
    this.drainResolvers = []
    for (const resolve of resolvers) resolve()
  }

  /**
   * Hard shutdown: abort every in-flight task, reject everything still queued,
   * and stop all timers. Unlike \`drain\`, this does not wait for work to finish.
   */
  async shutdown(): Promise<void> {
    this.closing = true
    for (const controller of this.inFlight.values()) controller.abort()
    this.inFlight.clear()
    this.queue.drainTo((task) => {
      this.metrics.failed++
      task.reject(new PoolClosedError())
    })
    for (const worker of this.workers) {
      if (worker.probeTimer) {
        clearInterval(worker.probeTimer)
        worker.probeTimer = null
      }
    }
    this.maybeCompleteDrain()
  }

  /** A point-in-time snapshot of pool state for telemetry scrapes. */
  snapshot(): {
    healthyWorkers: number
    queueDepth: number
    inFlight: number
    metrics: PoolMetrics
  } {
    return {
      healthyWorkers: this.healthyWorkers,
      queueDepth: this.queueDepth,
      inFlight: this.inFlightCount,
      metrics: { ...this.metrics },
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && 'unref' in timer) {
      ;(timer as { unref: () => void }).unref()
    }
  })
}

/**
 * A short random identifier for tasks that do not supply their own. Uses the
 * Web Crypto API when available and falls back to a time-seeded value so the
 * pool works in every runtime the ingest path targets.
 */
function cryptoRandomId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return \`task-\${Date.now().toString(36)}-\${Math.floor(Math.random() * 1e9).toString(36)}\`
}

/**
 * A token-bucket rate limiter used to throttle submission into a pool when the
 * downstream (checkpoint store, event bus) has its own quota. Tokens refill
 * continuously at \`ratePerSec\`; \`take\` resolves once a token is available,
 * never rejecting, so callers naturally pace rather than fail.
 */
export class RateLimiter {
  private tokens: number
  private lastRefill: number
  private readonly capacity: number
  private readonly ratePerSec: number
  private readonly now: () => number

  constructor(opts: { capacity: number; ratePerSec: number; now?: () => number }) {
    this.capacity = opts.capacity
    this.ratePerSec = opts.ratePerSec
    this.tokens = opts.capacity
    this.now = opts.now ?? (() => performance.now())
    this.lastRefill = this.now()
  }

  private refill(): void {
    const elapsedSec = (this.now() - this.lastRefill) / 1000
    if (elapsedSec <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec)
    this.lastRefill = this.now()
  }

  /** Non-blocking attempt to consume one token; true when granted. */
  tryTake(): boolean {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }

  /** Resolve once a token is available, waiting the minimum necessary time. */
  async take(): Promise<void> {
    while (!this.tryTake()) {
      const deficit = 1 - this.tokens
      const waitMs = Math.max(1, Math.ceil((deficit / this.ratePerSec) * 1000))
      await sleep(waitMs)
    }
  }

  get available(): number {
    this.refill()
    return Math.floor(this.tokens)
  }
}

type BreakerState = 'closed' | 'open' | 'half-open'

/**
 * A circuit breaker guarding a flaky downstream. It trips to \`open\` after a run
 * of failures, short-circuits calls while open, and lets a single trial through
 * in \`half-open\` to decide whether to close again. Wrapping pool tasks in a
 * breaker stops a dead dependency from burning the entire retry budget.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed'
  private consecutiveFailures = 0
  private openedAt = 0
  private readonly now: () => number

  constructor(
    private readonly opts: {
      failureThreshold: number
      resetTimeoutMs: number
      now?: () => number
    },
  ) {
    this.now = opts.now ?? (() => performance.now())
  }

  get current(): BreakerState {
    return this.state
  }

  private canAttempt(): boolean {
    if (this.state === 'closed') return true
    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.opts.resetTimeoutMs) {
        this.state = 'half-open'
        return true
      }
      return false
    }
    // half-open: allow the single trial call.
    return true
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0
    this.state = 'closed'
  }

  private onFailure(): void {
    this.consecutiveFailures++
    if (
      this.state === 'half-open' ||
      this.consecutiveFailures >= this.opts.failureThreshold
    ) {
      this.state = 'open'
      this.openedAt = this.now()
    }
  }

  /** Run work through the breaker, throwing immediately when the circuit is open. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.canAttempt()) {
      throw new CircuitOpenError()
    }
    try {
      const value = await work()
      this.onSuccess()
      return value
    } catch (error) {
      this.onFailure()
      throw error
    }
  }
}

export class CircuitOpenError extends Error {
  constructor() {
    super('circuit breaker is open; downstream is considered unavailable')
    this.name = 'CircuitOpenError'
  }
}

/**
 * Submit a batch of payloads into a pool with an optional concurrency limit and
 * optional rate limiter, returning a settled result per input so a single
 * failure does not discard the rest. Order of results matches order of inputs.
 */
export async function submitBatch<I, O>(
  pool: WorkerPool<I, O>,
  payloads: I[],
  run: (payload: I, signal: AbortSignal) => Promise<O>,
  opts: { limiter?: RateLimiter } = {},
): Promise<Array<PromiseSettledResult<O>>> {
  const results: Array<Promise<O>> = []
  for (const payload of payloads) {
    if (opts.limiter) await opts.limiter.take()
    results.push(pool.submit(payload, run))
  }
  return Promise.allSettled(results)
}

/**
 * Wrap a task \`run\` so that it flows through a circuit breaker before touching
 * the real work. Handy when several pool tasks share one fragile dependency.
 */
export function withBreaker<I, O>(
  breaker: CircuitBreaker,
  run: (payload: I, signal: AbortSignal) => Promise<O>,
): (payload: I, signal: AbortSignal) => Promise<O> {
  return (payload, signal) => breaker.run(() => run(payload, signal))
}

/**
 * A priority wrapper over the pool: higher-priority payloads are submitted
 * first when several are enqueued together. The pool itself is FIFO, so this
 * only reorders the burst it is given, which is enough for the common case of
 * draining a mixed-priority buffer.
 */
export async function submitPrioritized<I, O>(
  pool: WorkerPool<I, O>,
  items: Array<{ payload: I; priority: number }>,
  run: (payload: I, signal: AbortSignal) => Promise<O>,
): Promise<Array<PromiseSettledResult<O>>> {
  const ordered = [...items].sort((a, b) => b.priority - a.priority)
  const results = ordered.map((item) => pool.submit(item.payload, run))
  return Promise.allSettled(results)
}

/**
 * A rolling window of pool snapshots, used to compute short-horizon rates
 * (tasks/sec, retry ratio) without the pool retaining history itself. Oldest
 * samples fall out once the window is full.
 */
export class PoolStatsWindow<I, O> {
  private readonly samples: Array<{
    at: number
    snapshot: ReturnType<WorkerPool<I, O>['snapshot']>
  }> = []

  constructor(
    private readonly pool: WorkerPool<I, O>,
    private readonly windowSize: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  sample(): void {
    this.samples.push({ at: this.now(), snapshot: this.pool.snapshot() })
    while (this.samples.length > this.windowSize) this.samples.shift()
  }

  /** Completed tasks per second across the retained window, or 0 if too short. */
  completedPerSec(): number {
    if (this.samples.length < 2) return 0
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const elapsedSec = (last.at - first.at) / 1000
    if (elapsedSec <= 0) return 0
    const delta = last.snapshot.metrics.completed - first.snapshot.metrics.completed
    return delta / elapsedSec
  }

  /** Fraction of attempts that were retries across the window, in [0, 1]. */
  retryRatio(): number {
    if (this.samples.length < 2) return 0
    const first = this.samples[0].snapshot.metrics
    const last = this.samples[this.samples.length - 1].snapshot.metrics
    const retried = last.retried - first.retried
    const submitted = last.submitted - first.submitted
    return submitted === 0 ? 0 : retried / submitted
  }

  get depth(): number {
    return this.samples.length
  }
}

/**
 * Poll a pool's snapshot at an interval and invoke a callback, returning a
 * stop function. Used to bridge pool metrics into a scrape endpoint without the
 * pool knowing about the telemetry layer.
 */
export function observePool<I, O>(
  pool: WorkerPool<I, O>,
  intervalMs: number,
  onSample: (sample: ReturnType<WorkerPool<I, O>['snapshot']>) => void,
): () => void {
  const timer = setInterval(() => onSample(pool.snapshot()), intervalMs)
  if (typeof timer === 'object' && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }
  return () => clearInterval(timer)
}

/**
 * Adaptive submit gate: watches a pool's queue depth against a high/low water
 * mark and pauses submission when the queue climbs past the high mark, resuming
 * once it drains below the low mark. Producers await \`gate\` before each submit,
 * turning a hard BackpressureError into a smooth pause.
 */
export class BackpressureGate<I, O> {
  private paused = false
  private waiters: Array<() => void> = []

  constructor(
    private readonly pool: WorkerPool<I, O>,
    private readonly highWater: number,
    private readonly lowWater: number,
  ) {
    if (lowWater >= highWater) {
      throw new RangeError('lowWater must be below highWater')
    }
  }

  /** Resolve immediately when open; otherwise block until the queue drains. */
  gate(): Promise<void> {
    this.evaluate()
    if (!this.paused) return Promise.resolve()
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  /** Re-check the water marks and release waiters if the queue has drained. */
  evaluate(): void {
    const depth = this.pool.queueDepth
    if (!this.paused && depth >= this.highWater) {
      this.paused = true
    } else if (this.paused && depth <= this.lowWater) {
      this.paused = false
      const released = this.waiters
      this.waiters = []
      for (const resolve of released) resolve()
    }
  }

  get isPaused(): boolean {
    return this.paused
  }
}

/**
 * Drive a pool from a periodic producer: every \`intervalMs\` the producer is
 * asked for a batch of payloads, which are submitted together. Returns a handle
 * that stops the schedule and drains outstanding work. Useful for timer-driven
 * ingest where envelopes accumulate between ticks.
 */
export function schedulePool<I, O>(
  pool: WorkerPool<I, O>,
  intervalMs: number,
  produce: () => I[] | Promise<I[]>,
  run: (payload: I, signal: AbortSignal) => Promise<O>,
): { stop: () => Promise<void> } {
  let stopped = false
  const tick = async (): Promise<void> => {
    if (stopped) return
    const payloads = await produce()
    for (const payload of payloads) {
      if (stopped) break
      // Swallow per-task rejections here; the pool's metrics record failures and
      // a scheduled producer must not crash on one bad payload.
      pool.submit(payload, run).catch(() => undefined)
    }
  }
  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  if (typeof timer === 'object' && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }
  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await pool.drain()
    },
  }
}

/**
 * Supervises several named pools behind one facade so a service can budget
 * concurrency per stage (decode, checkpoint, publish) while sharing shutdown
 * and a single metrics scrape. Routing is by name; an unknown name throws
 * rather than silently dropping work.
 */
export class PoolSupervisor {
  private readonly pools = new Map<string, WorkerPool<unknown, unknown>>()

  register<I, O>(name: string, pool: WorkerPool<I, O>): void {
    if (this.pools.has(name)) {
      throw new Error(\`pool "\${name}" is already registered\`)
    }
    this.pools.set(name, pool as WorkerPool<unknown, unknown>)
  }

  pool<I, O>(name: string): WorkerPool<I, O> {
    const found = this.pools.get(name)
    if (!found) throw new Error(\`no pool registered as "\${name}"\`)
    return found as WorkerPool<I, O>
  }

  /** Submit to a named pool, throwing if the name is unknown. */
  submit<I, O>(
    name: string,
    payload: I,
    run: (payload: I, signal: AbortSignal) => Promise<O>,
  ): Promise<O> {
    return this.pool<I, O>(name).submit(payload, run)
  }

  /** Aggregate every pool's metrics under its name for a single scrape. */
  metricsByPool(): Record<string, PoolMetrics> {
    const out: Record<string, PoolMetrics> = {}
    for (const [name, pool] of this.pools) {
      out[name] = { ...pool.metrics }
    }
    return out
  }

  /** Drain every registered pool, resolving once all are idle. */
  async drainAll(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.drain()))
  }

  /** Hard-shutdown every registered pool in parallel. */
  async shutdownAll(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.shutdown()))
    this.pools.clear()
  }

  get size(): number {
    return this.pools.size
  }
}

/**
 * Warm a pool by submitting a fixed number of cheap no-op tasks so the first
 * real request does not pay worker-spawn latency. Resolves once every warm-up
 * task settles.
 */
export async function warmPool<I, O>(
  pool: WorkerPool<I, O>,
  probe: I,
  run: (payload: I, signal: AbortSignal) => Promise<O>,
  count: number,
): Promise<void> {
  const tasks: Array<Promise<O>> = []
  for (let i = 0; i < count; i++) {
    tasks.push(pool.submit(probe, run))
  }
  await Promise.allSettled(tasks)
}

/**
 * Map an async function over an iterable through a pool, preserving input order
 * in the results while bounding concurrency to the pool's worker budget. Rejects
 * on the first task that exhausts its retries, mirroring \`Promise.all\`.
 */
export async function mapConcurrent<I, O>(
  pool: WorkerPool<I, O>,
  inputs: Iterable<I>,
  run: (payload: I, signal: AbortSignal) => Promise<O>,
): Promise<O[]> {
  const tasks = [...inputs].map((input) => pool.submit(input, run))
  return Promise.all(tasks)
}

/**
 * Drain a pool but give up after \`timeoutMs\`, hard-shutting-down whatever is
 * still in flight. Returns whether the drain completed cleanly before the
 * deadline, so a shutdown path can log a forced termination.
 */
export async function drainWithTimeout<I, O>(
  pool: WorkerPool<I, O>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    if (timer && typeof timer === 'object' && 'unref' in timer) {
      ;(timer as { unref: () => void }).unref()
    }
  })
  const drained = pool.drain().then(() => true as const)
  const clean = await Promise.race([drained, deadline])
  if (timer) clearTimeout(timer)
  if (!clean) await pool.shutdown()
  return clean
}

/**
 * Whether a pool is healthy enough to accept the projected additional load:
 * at least one healthy worker and headroom in the queue for the projected
 * inflow. Cheap enough to call on a readiness probe.
 */
export function poolIsHealthy<I, O>(
  pool: WorkerPool<I, O>,
  projectedInflow: number,
  queueCapacity: number,
): boolean {
  if (pool.healthyWorkers < 1) return false
  return pool.queueDepth + projectedInflow <= queueCapacity
}

/**
 * Construct a pool with the default retry and health policies, overriding only
 * the sizing knobs. The convenience most call sites want.
 */
export function createWorkerPool<I, O>(opts: {
  maxWorkers: number
  queueCapacity: number
  taskTimeoutMs: number
  retry?: Partial<RetryPolicy>
  health?: Partial<HealthPolicy>
}): WorkerPool<I, O> {
  return new WorkerPool<I, O>({
    maxWorkers: opts.maxWorkers,
    queueCapacity: opts.queueCapacity,
    taskTimeoutMs: opts.taskTimeoutMs,
    retry: { ...DEFAULT_RETRY, ...opts.retry },
    health: { ...DEFAULT_HEALTH, ...opts.health },
  })
}
`

// ————————————————————————————————————————————————————————————————
// File 2 — bun.lock (modified). Realistic lockfile churn. Both sides are
// moderately sized; consumers detect this as a lockfile by path alone.
// ————————————————————————————————————————————————————————————————

function lockLines(entries: Array<[string, string, string]>): string[] {
  const out: string[] = [
    '{',
    '  "lockfileVersion": 1,',
    '  "workspaces": {',
    '    "": {',
    '      "name": "atlas",',
    '      "dependencies": {',
  ]
  for (const [name, version] of entries) {
    out.push(`        "${name}": "^${version}",`)
  }
  out.push('      }', '    }', '  },', '  "packages": {')
  for (const [name, version, integrity] of entries) {
    // Each package is a multi-line block: resolved tuple, resolution url, and
    // integrity hash — the shape a package manager actually emits.
    out.push(
      `    "${name}": {`,
      `      "version": "${version}",`,
      `      "resolved": "https://registry.npmjs.org/${name}/-/${basename(name)}-${version}.tgz",`,
      `      "integrity": "sha512-${integrity}${integrity}${integrity}==",`,
      '    },',
    )
  }
  out.push('  }', '}')
  return out
}

/** Bare package name for a scoped or unscoped spec, for the tarball path. */
function basename(name: string): string {
  const slash = name.lastIndexOf('/')
  return slash === -1 ? name : name.slice(slash + 1)
}

// A realistic dependency closure for a TypeScript data platform. Entries are
// ordered as a package manager would emit them, so the regenerated-lockfile
// diff reads like a genuine `bun install` churn.
const lockBaseEntries: Array<[string, string, string]> = [
  ['@atlas/core', '3.2.1', 'aaa1'],
  ['@atlas/events', '1.9.4', 'aaa2'],
  ['@atlas/ingest', '3.2.1', 'aaa3'],
  ['@atlas/schema', '2.4.0', 'aaa4'],
  ['@atlas/telemetry', '1.5.2', 'aaa5'],
  ['@fastify/cors', '9.0.1', 'aaa6'],
  ['@grpc/grpc-js', '1.9.13', 'aaa7'],
  ['@opentelemetry/api', '1.7.0', 'aaa8'],
  ['@opentelemetry/core', '1.19.0', 'aaa9'],
  ['@opentelemetry/resources', '1.19.0', 'aa10'],
  ['@opentelemetry/sdk-trace-base', '1.19.0', 'aa11'],
  ['@sinclair/typebox', '0.31.28', 'aa12'],
  ['@types/node', '20.10.5', 'aa13'],
  ['abort-controller', '3.0.0', 'aa14'],
  ['ajv', '8.12.0', 'aa15'],
  ['ajv-formats', '2.1.1', 'aa16'],
  ['ansi-regex', '6.0.1', 'aa17'],
  ['avsc', '5.7.7', 'aa18'],
  ['bignumber.js', '9.1.2', 'aa19'],
  ['bullmq', '5.1.1', 'aa20'],
  ['bytes', '3.1.2', 'aa21'],
  ['cbor-x', '1.5.8', 'aa22'],
  ['cluster-key-slot', '1.1.2', 'aa23'],
  ['commander', '11.1.0', 'aa24'],
  ['content-type', '1.0.5', 'aa25'],
  ['debug', '4.3.4', 'aa26'],
  ['denque', '2.1.0', 'aa27'],
  ['dotenv', '16.3.1', 'aa28'],
  ['eventemitter3', '5.0.1', 'aa29'],
  ['fast-copy', '3.0.1', 'aa30'],
  ['fast-json-stringify', '5.8.0', 'aa31'],
  ['fast-redact', '3.3.0', 'aa32'],
  ['fastify', '4.25.2', 'aa33'],
  ['find-my-way', '8.1.0', 'aa34'],
  ['generic-pool', '3.9.0', 'aa35'],
  ['ioredis', '5.3.2', 'aa36'],
  ['json-schema-to-ts', '3.0.0', 'aa37'],
  ['lodash.merge', '4.6.2', 'aa38'],
  ['lru-cache', '10.1.0', 'aa39'],
  ['msgpackr', '1.10.1', 'aa40'],
  ['nanoid', '5.0.4', 'aa41'],
  ['node-abort-controller', '3.1.1', 'aa42'],
  ['p-limit', '5.0.0', 'aa43'],
  ['p-queue', '8.0.1', 'aa44'],
  ['p-retry', '6.2.0', 'aa45'],
  ['pino', '8.16.2', 'aa46'],
  ['pino-abstract-transport', '1.1.0', 'aa47'],
  ['prom-client', '15.0.0', 'aa48'],
  ['protobufjs', '7.2.5', 'aa49'],
  ['quick-lru', '7.0.0', 'aa50'],
  ['redis-errors', '1.2.0', 'aa51'],
  ['reusify', '1.0.4', 'aa52'],
  ['semver', '7.5.4', 'aa53'],
  ['sonic-boom', '3.7.0', 'aa54'],
  ['split2', '4.2.0', 'aa55'],
  ['tslib', '2.6.2', 'aa56'],
  ['undici', '6.2.1', 'aa57'],
  ['uuid', '9.0.1', 'aa58'],
  ['ws', '8.15.1', 'aa59'],
  ['zod', '3.22.4', 'aa60'],
]

// Head regenerates the lockfile: adds the pooling deps (piscina, tinypool and
// their transitive helpers), bumps the workspace packages and a handful of
// direct/transitive versions, and drops one dependency no longer referenced.
const lockHeadEntries: Array<[string, string, string]> = [
  ['@atlas/core', '3.3.0', 'ccc1'],
  ['@atlas/events', '1.9.4', 'aaa2'],
  ['@atlas/ingest', '3.3.0', 'ccc2'],
  ['@atlas/schema', '2.4.0', 'aaa4'],
  ['@atlas/telemetry', '1.6.0', 'ccc3'],
  ['@fastify/cors', '9.0.1', 'aaa6'],
  ['@grpc/grpc-js', '1.9.13', 'aaa7'],
  ['@opentelemetry/api', '1.7.0', 'aaa8'],
  ['@opentelemetry/core', '1.19.0', 'aaa9'],
  ['@opentelemetry/resources', '1.19.0', 'aa10'],
  ['@opentelemetry/sdk-trace-base', '1.19.0', 'aa11'],
  ['@sinclair/typebox', '0.31.28', 'aa12'],
  ['@types/node', '20.10.6', 'ccc4'],
  ['abort-controller', '3.0.0', 'aa14'],
  ['ajv', '8.12.0', 'aa15'],
  ['ajv-formats', '2.1.1', 'aa16'],
  ['ansi-regex', '6.0.1', 'aa17'],
  ['avsc', '5.7.7', 'aa18'],
  ['bignumber.js', '9.1.2', 'aa19'],
  ['bullmq', '5.1.1', 'aa20'],
  ['bytes', '3.1.2', 'aa21'],
  ['cbor-x', '1.5.8', 'aa22'],
  ['cluster-key-slot', '1.1.2', 'aa23'],
  ['commander', '11.1.0', 'aa24'],
  ['content-type', '1.0.5', 'aa25'],
  ['debug', '4.3.4', 'aa26'],
  ['denque', '2.1.0', 'aa27'],
  ['dotenv', '16.3.1', 'aa28'],
  ['eventemitter3', '5.0.1', 'aa29'],
  ['fast-copy', '3.0.1', 'aa30'],
  ['fast-json-stringify', '5.8.0', 'aa31'],
  ['fast-redact', '3.3.0', 'aa32'],
  ['fastify', '4.25.2', 'aa33'],
  ['find-my-way', '8.1.0', 'aa34'],
  ['generic-pool', '3.9.0', 'aa35'],
  ['ioredis', '5.3.2', 'aa36'],
  ['json-schema-to-ts', '3.0.0', 'aa37'],
  ['lodash.merge', '4.6.2', 'aa38'],
  ['lru-cache', '10.2.0', 'ccc5'],
  ['msgpackr', '1.10.1', 'aa40'],
  ['nanoid', '5.0.4', 'aa41'],
  ['node-abort-controller', '3.1.1', 'aa42'],
  ['p-limit', '5.0.0', 'aa43'],
  ['p-queue', '8.0.1', 'aa44'],
  ['p-retry', '6.2.0', 'aa45'],
  ['pino', '8.17.1', 'ccc6'],
  ['pino-abstract-transport', '1.1.0', 'aa47'],
  ['piscina', '4.3.0', 'ddd1'],
  ['prom-client', '15.0.0', 'aa48'],
  ['protobufjs', '7.2.5', 'aa49'],
  ['quick-lru', '7.0.0', 'aa50'],
  ['redis-errors', '1.2.0', 'aa51'],
  ['reusify', '1.0.4', 'aa52'],
  ['semver', '7.5.4', 'aa53'],
  ['sonic-boom', '3.7.0', 'aa54'],
  ['split2', '4.2.0', 'aa55'],
  ['tinypool', '0.8.2', 'ddd2'],
  ['tslib', '2.6.2', 'aa56'],
  ['undici', '6.6.2', 'ccc7'],
  ['uuid', '9.0.1', 'aa58'],
  ['ws', '8.15.1', 'aa59'],
  ['zod', '3.22.4', 'aa60'],
]

const lockBaseContent = lockLines(lockBaseEntries).join('\n')
const lockHeadContent = lockLines(lockHeadEntries).join('\n')

/**
 * Longest-common-subsequence line diff. Returns an edit script of kept /
 * removed / added lines so a regenerated lockfile produces a realistic churn —
 * unchanged runs stay put and only bumped, added, or removed entries appear as
 * changes, exactly as a package manager's diff reads.
 */
type EditOp =
  | { op: 'keep'; line: string }
  | { op: 'del'; line: string }
  | { op: 'add'; line: string }

function diffLines(base: string[], head: string[]): EditOp[] {
  const n = base.length
  const m = head.length
  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        base[i] === head[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const script: EditOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (base[i] === head[j]) {
      script.push({ op: 'keep', line: base[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      script.push({ op: 'del', line: base[i] })
      i++
    } else {
      script.push({ op: 'add', line: head[j] })
      j++
    }
  }
  while (i < n) script.push({ op: 'del', line: base[i++] })
  while (j < m) script.push({ op: 'add', line: head[j++] })
  return script
}

/**
 * Render an edit script as a unified-diff patch with three lines of context
 * around each changed run. Hunk headers count context + changes on each side
 * exactly, so `countPatch` and the viewer agree.
 */
function unifiedPatch(base: string[], head: string[]): string {
  const script = diffLines(base, head)
  const ctx = 3
  // Index of each script entry into base/head line numbers (1-based starts
  // computed per hunk below). Group changed runs, expanding context.
  const changedIdx: number[] = []
  script.forEach((e, idx) => {
    if (e.op !== 'keep') changedIdx.push(idx)
  })
  if (changedIdx.length === 0) return ''

  // Build hunk index ranges over the script, merging runs whose context windows
  // touch or overlap.
  const ranges: Array<[number, number]> = []
  for (const idx of changedIdx) {
    const start = Math.max(0, idx - ctx)
    const end = Math.min(script.length - 1, idx + ctx)
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end)
    } else {
      ranges.push([start, end])
    }
  }

  // Precompute base/head line numbers for each script entry.
  const baseNo: number[] = new Array(script.length)
  const headNo: number[] = new Array(script.length)
  let bn = 0
  let hn = 0
  script.forEach((e, idx) => {
    if (e.op === 'keep') {
      bn++
      hn++
      baseNo[idx] = bn
      headNo[idx] = hn
    } else if (e.op === 'del') {
      bn++
      baseNo[idx] = bn
      headNo[idx] = hn
    } else {
      hn++
      baseNo[idx] = bn
      headNo[idx] = hn
    }
  })

  const parts: string[] = []
  for (const [start, end] of ranges) {
    let oldStart = 0
    let newStart = 0
    let oldCount = 0
    let newCount = 0
    const body: string[] = []
    for (let idx = start; idx <= end; idx++) {
      const e = script[idx]
      if (e.op === 'keep') {
        if (!oldStart) oldStart = baseNo[idx]
        if (!newStart) newStart = headNo[idx]
        oldCount++
        newCount++
        body.push(` ${e.line}`)
      } else if (e.op === 'del') {
        if (!oldStart) oldStart = baseNo[idx]
        oldCount++
        body.push(`-${e.line}`)
      } else {
        if (!newStart) newStart = headNo[idx]
        newCount++
        body.push(`+${e.line}`)
      }
    }
    // A hunk that is pure additions/deletions still needs a valid start; fall
    // back to the neighbouring line number when no context anchored it.
    if (!oldStart) oldStart = baseNo[start] || 1
    if (!newStart) newStart = headNo[start] || 1
    parts.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    parts.push(...body)
  }
  return parts.join('\n')
}

const lockPatch = unifiedPatch(
  lockBaseContent.split('\n'),
  lockHeadContent.split('\n'),
)

// ————————————————————————————————————————————————————————————————
// File 4 — src/queue.ts → src/ingest/queue.ts (renamed + edited). Import path
// updates and pool wiring, ~40 changed lines across a couple of hunks.
// ————————————————————————————————————————————————————————————————

const queueBaseLines = `import { EventEmitter } from 'node:events'
import type { Envelope } from '../events/schema'
import { decodeEnvelope } from '../events/decode'
import { Metrics } from '../telemetry/counters'

export interface QueueOptions {
  capacity: number
  drainIntervalMs: number
}

/**
 * A simple in-memory ingest queue. Envelopes are pushed by producers and pulled
 * by a single consumer loop. This is the pre-pool implementation: one consumer,
 * no concurrency, blocking drain.
 */
export class IngestQueue extends EventEmitter {
  private buffer: Envelope[] = []
  private readonly capacity: number
  private readonly metrics = new Metrics('ingest_queue')

  constructor(opts: QueueOptions) {
    super()
    this.capacity = opts.capacity
  }

  push(raw: Uint8Array): boolean {
    if (this.buffer.length >= this.capacity) {
      this.metrics.increment('dropped')
      return false
    }
    const envelope = decodeEnvelope(raw)
    this.buffer.push(envelope)
    this.metrics.increment('accepted')
    this.emit('data', envelope)
    return true
  }

  async drainOnce(handler: (e: Envelope) => Promise<void>): Promise<number> {
    let handled = 0
    while (this.buffer.length > 0) {
      const envelope = this.buffer.shift()!
      await handler(envelope)
      handled++
    }
    return handled
  }

  get depth(): number {
    return this.buffer.length
  }
}
`.split('\n')

const queueBuilt = buildPatch(queueBaseLines, [
  {
    remove: [
      "import type { Envelope } from '../events/schema'",
      "import { decodeEnvelope } from '../events/decode'",
      "import { Metrics } from '../telemetry/counters'",
    ],
    add: [
      "import type { Envelope } from '../events/schema'",
      "import { decodeEnvelope } from '../events/decode'",
      "import { Metrics } from '../telemetry/counters'",
      "import { createWorkerPool, type WorkerPool } from './worker-pool'",
    ],
  },
  {
    remove: [
      'export interface QueueOptions {',
      '  capacity: number',
      '  drainIntervalMs: number',
      '}',
    ],
    add: [
      'export interface QueueOptions {',
      '  capacity: number',
      '  drainIntervalMs: number',
      '  workers: number',
      '}',
    ],
  },
  {
    remove: [
      "  private readonly metrics = new Metrics('ingest_queue')",
      '',
      '  constructor(opts: QueueOptions) {',
      '    super()',
      '    this.capacity = opts.capacity',
      '  }',
    ],
    add: [
      "  private readonly metrics = new Metrics('ingest_queue')",
      '  private readonly pool: WorkerPool<Envelope, void>',
      '  private closed = false',
      '',
      '  constructor(opts: QueueOptions) {',
      '    super()',
      '    this.capacity = opts.capacity',
      '    this.pool = createWorkerPool({',
      '      maxWorkers: opts.workers,',
      '      queueCapacity: opts.capacity,',
      '      taskTimeoutMs: opts.drainIntervalMs * 4,',
      '    })',
      '  }',
    ],
  },
  {
    remove: [
      '  push(raw: Uint8Array): boolean {',
      '    if (this.buffer.length >= this.capacity) {',
      "      this.metrics.increment('dropped')",
      '      return false',
      '    }',
      '    const envelope = decodeEnvelope(raw)',
      '    this.buffer.push(envelope)',
      "    this.metrics.increment('accepted')",
      "    this.emit('data', envelope)",
      '    return true',
      '  }',
    ],
    add: [
      '  push(raw: Uint8Array): boolean {',
      '    if (this.closed) {',
      "      this.metrics.increment('rejected_closed')",
      '      return false',
      '    }',
      '    if (this.buffer.length >= this.capacity) {',
      "      this.metrics.increment('dropped')",
      '      return false',
      '    }',
      '    const envelope = decodeEnvelope(raw)',
      '    this.buffer.push(envelope)',
      "    this.metrics.increment('accepted')",
      "    this.emit('data', envelope)",
      '    return true',
      '  }',
    ],
  },
  {
    remove: [
      '    let handled = 0',
      '    while (this.buffer.length > 0) {',
      '      const envelope = this.buffer.shift()!',
      '      await handler(envelope)',
      '      handled++',
      '    }',
      '    return handled',
      '  }',
      '',
      '  get depth(): number {',
      '    return this.buffer.length',
      '  }',
      '}',
    ],
    add: [
      '    let handled = 0',
      '    const pending: Promise<void>[] = []',
      '    while (this.buffer.length > 0) {',
      '      const envelope = this.buffer.shift()!',
      '      pending.push(this.pool.submit(envelope, (e) => handler(e)))',
      '      handled++',
      '    }',
      '    await Promise.allSettled(pending)',
      '    return handled',
      '  }',
      '',
      '  /** Stop accepting work and drain the pool, resolving once fully idle. */',
      '  async close(): Promise<void> {',
      '    this.closed = true',
      '    await this.pool.drain()',
      '  }',
      '',
      '  /** Combined queue + pool health for a scrape endpoint. */',
      '  stats(): {',
      '    buffered: number',
      '    accepted: number',
      '    dropped: number',
      '    pool: ReturnType<WorkerPool<Envelope, void>[\'snapshot\']>',
      '  } {',
      '    const counters = this.metrics.snapshot()',
      '    return {',
      '      buffered: this.buffer.length,',
      "      accepted: counters['ingest_queue_accepted'] ?? 0,",
      "      dropped: counters['ingest_queue_dropped'] ?? 0,",
      '      pool: this.pool.snapshot(),',
      '    }',
      '  }',
      '',
      '  get depth(): number {',
      '    return this.buffer.length',
      '  }',
      '}',
    ],
  },
])

// ————————————————————————————————————————————————————————————————
// Files 5–15 — eleven modified TS files, 40–160 changed lines each, real code.
// Each is authored as a base line array plus ordered modifications; head and
// patch are derived together.
// ————————————————————————————————————————————————————————————————

// 5. src/ingest/pipeline.ts — wires the pool into the pipeline, sizes it.
const pipelineBase = `import type { Envelope } from '../events/schema'
import { Batcher } from './batcher'
import { Dedupe } from './dedupe'
import { Checkpoints } from './checkpoints'
import { IngestMetrics } from './metrics'
import { loadIngestConfig } from '../config/ingest'

/**
 * The ingest pipeline: decode → dedupe → batch → checkpoint. Historically ran a
 * single consumer loop; throughput was bounded by the slowest stage on one core.
 */
export class Pipeline {
  private readonly batcher: Batcher
  private readonly dedupe: Dedupe
  private readonly checkpoints: Checkpoints
  private readonly metrics = new IngestMetrics()

  constructor() {
    const config = loadIngestConfig()
    this.batcher = new Batcher(config.batchSize)
    this.dedupe = new Dedupe(config.dedupeWindow)
    this.checkpoints = new Checkpoints(config.checkpointDir)
  }

  async ingest(envelope: Envelope): Promise<void> {
    if (this.dedupe.seen(envelope.id)) {
      this.metrics.duplicate()
      return
    }
    const batch = this.batcher.add(envelope)
    if (batch) {
      await this.checkpoints.write(batch)
      this.metrics.flushed(batch.length)
    }
  }

  async flush(): Promise<void> {
    const remaining = this.batcher.take()
    if (remaining.length > 0) {
      await this.checkpoints.write(remaining)
      this.metrics.flushed(remaining.length)
    }
  }
}
`.split('\n')

const pipelineBuilt = buildPatch(pipelineBase, [
  {
    remove: ["import { loadIngestConfig } from '../config/ingest'"],
    add: [
      "import { loadIngestConfig } from '../config/ingest'",
      "import { createWorkerPool, type WorkerPool } from './worker-pool'",
      "import { cpus } from 'node:os'",
      "import { performance } from 'node:perf_hooks'",
    ],
  },
  {
    remove: [
      '  private readonly metrics = new IngestMetrics()',
      '',
      '  constructor() {',
      '    const config = loadIngestConfig()',
      '    this.batcher = new Batcher(config.batchSize)',
      '    this.dedupe = new Dedupe(config.dedupeWindow)',
      '    this.checkpoints = new Checkpoints(config.checkpointDir)',
      '  }',
    ],
    add: [
      '  private readonly metrics = new IngestMetrics()',
      '  private readonly pool: WorkerPool<Envelope[], void>',
      '',
      '  constructor() {',
      '    const config = loadIngestConfig()',
      '    this.batcher = new Batcher(config.batchSize)',
      '    this.dedupe = new Dedupe(config.dedupeWindow)',
      '    this.checkpoints = new Checkpoints(config.checkpointDir)',
      '    this.pool = createWorkerPool({',
      '      maxWorkers: config.poolSize ?? cpus().length * 2,',
      '      queueCapacity: config.queueCapacity,',
      '      taskTimeoutMs: config.taskTimeoutMs,',
      '    })',
      '  }',
    ],
  },
  {
    remove: [
      '  async ingest(envelope: Envelope): Promise<void> {',
      '    if (this.dedupe.seen(envelope.id)) {',
      '      this.metrics.duplicate()',
      '      return',
      '    }',
      '    const batch = this.batcher.add(envelope)',
      '    if (batch) {',
      '      await this.checkpoints.write(batch)',
      '      this.metrics.flushed(batch.length)',
      '    }',
      '  }',
    ],
    add: [
      '  async ingest(envelope: Envelope): Promise<void> {',
      '    if (this.dedupe.seen(envelope.id)) {',
      '      this.metrics.duplicate()',
      '      return',
      '    }',
      '    const batch = this.batcher.add(envelope)',
      '    if (!batch) return',
      '    // Hand the completed batch to the pool; the pool applies backpressure at',
      '    // capacity, so a slow checkpoint store slows producers rather than',
      '    // ballooning memory here.',
      '    const startedAt = performance.now()',
      '    try {',
      '      await this.pool.submit(batch, async (b) => {',
      '        await this.checkpoints.write(b)',
      '        this.metrics.flushed(b.length)',
      '      })',
      '      this.metrics.poolTask({',
      '        retried: false,',
      '        failed: false,',
      '        latencyMs: performance.now() - startedAt,',
      '      })',
      '    } catch (error) {',
      '      this.metrics.poolTask({',
      '        retried: false,',
      '        failed: true,',
      '        latencyMs: performance.now() - startedAt,',
      '      })',
      '      throw error',
      '    } finally {',
      '      this.metrics.observePool(this.pool.queueDepth, this.pool.inFlightCount)',
      '    }',
      '  }',
    ],
  },
  {
    remove: [
      '  async flush(): Promise<void> {',
      '    const remaining = this.batcher.take()',
      '    if (remaining.length > 0) {',
      '      await this.checkpoints.write(remaining)',
      '      this.metrics.flushed(remaining.length)',
      '    }',
      '  }',
      '}',
    ],
    add: [
      '  async flush(): Promise<void> {',
      '    const remaining = this.batcher.take()',
      '    if (remaining.length > 0) {',
      '      await this.checkpoints.write(remaining)',
      '      this.metrics.flushed(remaining.length)',
      '    }',
      '    await this.pool.drain()',
      '  }',
      '',
      '  /** A point-in-time view of pipeline health for the metrics endpoint. */',
      '  stats(): {',
      '    dedupe: number',
      '    batchDepth: number',
      '    pool: ReturnType<WorkerPool<Envelope[], void>[\'snapshot\']>',
      '  } {',
      '    return {',
      '      dedupe: this.dedupe.size,',
      '      batchDepth: this.batcher.depth,',
      '      pool: this.pool.snapshot(),',
      '    }',
      '  }',
      '}',
    ],
  },
])

// 6. src/ingest/batcher.ts
const batcherBase = `import type { Envelope } from '../events/schema'

/**
 * Groups envelopes into fixed-size batches. Returns a batch when the threshold
 * is reached, otherwise null. Callers drain the tail with take().
 */
export class Batcher {
  private pending: Envelope[] = []

  constructor(private readonly size: number) {}

  add(envelope: Envelope): Envelope[] | null {
    this.pending.push(envelope)
    if (this.pending.length >= this.size) {
      const batch = this.pending
      this.pending = []
      return batch
    }
    return null
  }

  take(): Envelope[] {
    const batch = this.pending
    this.pending = []
    return batch
  }

  get depth(): number {
    return this.pending.length
  }
}
`.split('\n')

const batcherBuilt = buildPatch(batcherBase, [
  {
    remove: ["import type { Envelope } from '../events/schema'"],
    add: [
      "import type { Envelope } from '../events/schema'",
      '',
      'export interface BatcherOptions {',
      '  /** Maximum envelopes per batch. */',
      '  size: number',
      '  /** Flush a partial batch after this many milliseconds of inactivity. */',
      '  maxAgeMs?: number',
      '  /** Wall-clock source, injectable for tests. */',
      '  now?: () => number',
      '}',
    ],
  },
  {
    remove: [
      '  private pending: Envelope[] = []',
      '',
      '  constructor(private readonly size: number) {}',
      '',
      '  add(envelope: Envelope): Envelope[] | null {',
      '    this.pending.push(envelope)',
      '    if (this.pending.length >= this.size) {',
      '      const batch = this.pending',
      '      this.pending = []',
      '      return batch',
      '    }',
      '    return null',
      '  }',
    ],
    add: [
      '  private pending: Envelope[] = []',
      '  private highWater = 0',
      '  private firstAddedAt = 0',
      '  private readonly size: number',
      '  private readonly maxAgeMs: number',
      '  private readonly now: () => number',
      '',
      '  constructor(opts: BatcherOptions | number) {',
      "    const normalized = typeof opts === 'number' ? { size: opts } : opts",
      '    this.size = normalized.size',
      '    this.maxAgeMs = normalized.maxAgeMs ?? Number.POSITIVE_INFINITY',
      '    this.now = normalized.now ?? (() => Date.now())',
      '  }',
      '',
      '  add(envelope: Envelope): Envelope[] | null {',
      '    if (this.pending.length === 0) {',
      '      this.firstAddedAt = this.now()',
      '    }',
      '    this.pending.push(envelope)',
      '    if (this.pending.length > this.highWater) {',
      '      this.highWater = this.pending.length',
      '    }',
      '    if (this.pending.length >= this.size || this.aged()) {',
      '      return this.flush()',
      '    }',
      '    return null',
      '  }',
      '',
      '  private aged(): boolean {',
      '    if (this.pending.length === 0) return false',
      '    return this.now() - this.firstAddedAt >= this.maxAgeMs',
      '  }',
      '',
      '  private flush(): Envelope[] {',
      '    const batch = this.pending',
      '    this.pending = []',
      '    this.firstAddedAt = 0',
      '    return batch',
      '  }',
      '',
      '  /** Return a batch if the pending buffer has aged past its deadline. */',
      '  tick(): Envelope[] | null {',
      '    return this.aged() ? this.flush() : null',
      '  }',
    ],
  },
  {
    remove: [
      '  take(): Envelope[] {',
      '    const batch = this.pending',
      '    this.pending = []',
      '    return batch',
      '  }',
      '',
      '  get depth(): number {',
      '    return this.pending.length',
      '  }',
      '}',
    ],
    add: [
      '  take(): Envelope[] {',
      '    return this.flush()',
      '  }',
      '',
      '  /**',
      '   * Split the pending buffer into full-size batches plus a trailing partial,',
      '   * without regard to the age deadline. Used when draining under shutdown to',
      '   * hand the pool as much work as possible at once.',
      '   */',
      '  drainAll(): Envelope[][] {',
      '    const batches: Envelope[][] = []',
      '    while (this.pending.length >= this.size) {',
      '      batches.push(this.pending.splice(0, this.size))',
      '    }',
      '    if (this.pending.length > 0) {',
      '      batches.push(this.flush())',
      '    } else {',
      '      this.firstAddedAt = 0',
      '    }',
      '    return batches',
      '  }',
      '',
      '  get depth(): number {',
      '    return this.pending.length',
      '  }',
      '',
      '  get peakDepth(): number {',
      '    return this.highWater',
      '  }',
      '}',
    ],
  },
])

// 7. src/ingest/dedupe.ts
const dedupeBase = `/**
 * A sliding-window de-duplicator keyed by envelope id. Ids fall out of the set
 * once the window is exceeded, bounding memory at the cost of missing very old
 * duplicates.
 */
export class Dedupe {
  private seenIds = new Set<string>()
  private order: string[] = []

  constructor(private readonly window: number) {}

  seen(id: string): boolean {
    if (this.seenIds.has(id)) {
      return true
    }
    this.seenIds.add(id)
    this.order.push(id)
    if (this.order.length > this.window) {
      const evicted = this.order.shift()!
      this.seenIds.delete(evicted)
    }
    return false
  }

  clear(): void {
    this.seenIds.clear()
    this.order = []
  }

  get size(): number {
    return this.seenIds.size
  }
}
`.split('\n')

const dedupeBuilt = buildPatch(dedupeBase, [
  {
    remove: [
      'export class Dedupe {',
      '  private seenIds = new Set<string>()',
      '  private order: string[] = []',
      '',
      '  constructor(private readonly window: number) {}',
    ],
    add: [
      'export interface DedupeStats {',
      '  size: number',
      '  hits: number',
      '  misses: number',
      '  evictions: number',
      '}',
      '',
      'export class Dedupe {',
      '  private seenIds = new Set<string>()',
      '  private order: string[] = []',
      '  private hits = 0',
      '  private misses = 0',
      '  private evictions = 0',
      '',
      '  constructor(',
      '    private readonly window: number,',
      '    private readonly shard = 0,',
      '  ) {}',
    ],
  },
  {
    remove: [
      '  seen(id: string): boolean {',
      '    if (this.seenIds.has(id)) {',
      '      return true',
      '    }',
      '    this.seenIds.add(id)',
      '    this.order.push(id)',
      '    if (this.order.length > this.window) {',
      '      const evicted = this.order.shift()!',
      '      this.seenIds.delete(evicted)',
      '    }',
      '    return false',
      '  }',
    ],
    add: [
      '  seen(id: string): boolean {',
      '    if (this.seenIds.has(id)) {',
      '      this.hits++',
      '      return true',
      '    }',
      '    this.misses++',
      '    this.seenIds.add(id)',
      '    this.order.push(id)',
      '    if (this.order.length > this.window) {',
      '      const evicted = this.order.shift()!',
      '      this.seenIds.delete(evicted)',
      '      this.evictions++',
      '    }',
      '    return false',
      '  }',
      '',
      '  /** Whether an id belongs to this shard, by a stable hash of the id. */',
      '  owns(id: string, shardCount: number): boolean {',
      '    let h = 2166136261',
      '    for (let i = 0; i < id.length; i++) {',
      '      h = (h ^ id.charCodeAt(i)) * 16777619',
      '    }',
      '    return (h >>> 0) % shardCount === this.shard',
      '  }',
    ],
  },
  {
    remove: [
      '  clear(): void {',
      '    this.seenIds.clear()',
      '    this.order = []',
      '  }',
      '',
      '  get size(): number {',
      '    return this.seenIds.size',
      '  }',
      '}',
    ],
    add: [
      '  clear(): void {',
      '    this.seenIds.clear()',
      '    this.order = []',
      '    this.hits = 0',
      '    this.misses = 0',
      '    this.evictions = 0',
      '  }',
      '',
      '  get size(): number {',
      '    return this.seenIds.size',
      '  }',
      '',
      '  stats(): DedupeStats {',
      '    return {',
      '      size: this.seenIds.size,',
      '      hits: this.hits,',
      '      misses: this.misses,',
      '      evictions: this.evictions,',
      '    }',
      '  }',
      '',
      '  /** Serialize the current id window so it can be restored after a restart. */',
      '  serialize(): string[] {',
      '    return [...this.order]',
      '  }',
      '',
      '  /**',
      '   * Restore a previously serialized window, dropping the oldest ids if the',
      '   * restored set exceeds the configured window size.',
      '   */',
      '  restore(ids: string[]): void {',
      '    this.clear()',
      '    for (const id of ids) {',
      '      this.seenIds.add(id)',
      '      this.order.push(id)',
      '    }',
      '    while (this.order.length > this.window) {',
      '      const evicted = this.order.shift()!',
      '      this.seenIds.delete(evicted)',
      '      this.evictions++',
      '    }',
      '  }',
      '}',
    ],
  },
])

// 8. src/ingest/checkpoints.ts
const checkpointsBase = `import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Envelope } from '../events/schema'
import { encodeBatch } from '../events/decode'

/**
 * Durably writes batches to a checkpoint directory. Each batch becomes one file
 * named by a monotonically increasing sequence number.
 */
export class Checkpoints {
  private sequence = 0

  constructor(private readonly dir: string) {}

  async write(batch: Envelope[]): Promise<string> {
    await mkdir(this.dir, { recursive: true })
    const name = \`checkpoint-\${String(this.sequence).padStart(8, '0')}.bin\`
    const path = join(this.dir, name)
    await writeFile(path, encodeBatch(batch))
    this.sequence++
    return path
  }

  get written(): number {
    return this.sequence
  }
}
`.split('\n')

const checkpointsBuilt = buildPatch(checkpointsBase, [
  {
    remove: [
      "import { writeFile, mkdir } from 'node:fs/promises'",
      "import { join } from 'node:path'",
    ],
    add: [
      "import { writeFile, readFile, mkdir, rename, readdir, unlink } from 'node:fs/promises'",
      "import { join } from 'node:path'",
      "import { createHash } from 'node:crypto'",
    ],
  },
  {
    remove: [
      '  private sequence = 0',
      '',
      '  constructor(private readonly dir: string) {}',
    ],
    add: [
      '  private sequence = 0',
      '  private bytesWritten = 0',
      '  private readonly retain: number',
      '',
      '  constructor(',
      '    private readonly dir: string,',
      '    opts: { retain?: number } = {},',
      '  ) {',
      '    this.retain = opts.retain ?? 64',
      '  }',
    ],
  },
  {
    remove: [
      '  async write(batch: Envelope[]): Promise<string> {',
      '    await mkdir(this.dir, { recursive: true })',
      "    const name = `checkpoint-${String(this.sequence).padStart(8, '0')}.bin`",
      '    const path = join(this.dir, name)',
      '    await writeFile(path, encodeBatch(batch))',
      '    this.sequence++',
      '    return path',
      '  }',
    ],
    add: [
      '  async write(batch: Envelope[]): Promise<string> {',
      "    if (batch.length === 0) return ''",
      '    await mkdir(this.dir, { recursive: true })',
      "    const name = `checkpoint-${String(this.sequence).padStart(8, '0')}.bin`",
      '    const finalPath = join(this.dir, name)',
      "    const tmpPath = `${finalPath}.tmp`",
      '    const bytes = encodeBatch(batch)',
      '    // Write to a temp file then rename, so a crash mid-write never leaves a',
      '    // half-written checkpoint that the reader would choke on.',
      '    await writeFile(tmpPath, bytes)',
      '    await rename(tmpPath, finalPath)',
      '    await this.writeChecksum(finalPath, bytes)',
      '    this.sequence++',
      '    this.bytesWritten += bytes.byteLength',
      '    await this.prune()',
      '    return finalPath',
      '  }',
      '',
      '  private async writeChecksum(path: string, bytes: Uint8Array): Promise<void> {',
      "    const digest = createHash('sha256').update(bytes).digest('hex')",
      "    await writeFile(`${path}.sha256`, digest)",
      '  }',
      '',
      '  /** Delete the oldest checkpoints beyond the retention count. */',
      '  private async prune(): Promise<void> {',
      '    const entries = (await readdir(this.dir))',
      "      .filter((f) => f.startsWith('checkpoint-') && f.endsWith('.bin'))",
      '      .sort()',
      '    const excess = entries.length - this.retain',
      '    if (excess <= 0) return',
      '    for (const stale of entries.slice(0, excess)) {',
      '      const full = join(this.dir, stale)',
      '      await unlink(full).catch(() => undefined)',
      "      await unlink(`${full}.sha256`).catch(() => undefined)",
      '    }',
      '  }',
    ],
  },
  {
    remove: [
      '  get written(): number {',
      '    return this.sequence',
      '  }',
      '}',
    ],
    add: [
      '  get written(): number {',
      '    return this.sequence',
      '  }',
      '',
      '  get totalBytes(): number {',
      '    return this.bytesWritten',
      '  }',
      '',
      '  /**',
      '   * Verify a checkpoint against its sidecar checksum, returning true when the',
      '   * bytes match. A missing checksum sidecar is treated as unverifiable and',
      '   * returns false so callers can decide whether to trust it.',
      '   */',
      '  async verify(path: string, bytes: Uint8Array): Promise<boolean> {',
      '    try {',
      "      const expected = await readFile(`${path}.sha256`, 'utf8')",
      "      const actual = createHash('sha256').update(bytes).digest('hex')",
      '      return expected.trim() === actual',
      '    } catch {',
      '      return false',
      '    }',
      '  }',
      '',
      '  /** List existing checkpoint files in write order, newest last. */',
      '  async list(): Promise<string[]> {',
      '    try {',
      '      return (await readdir(this.dir))',
      "        .filter((f) => f.startsWith('checkpoint-') && f.endsWith('.bin'))",
      '        .sort()',
      '        .map((f) => join(this.dir, f))',
      '    } catch {',
      '      return []',
      '    }',
      '  }',
      '}',
    ],
  },
])

// 9. src/ingest/metrics.ts
const metricsBase = `import { Counter } from '../telemetry/counters'

/**
 * Ingest-specific metric surface. Wraps raw counters with named methods so call
 * sites read intently rather than poking string keys.
 */
export class IngestMetrics {
  private readonly dupes = new Counter('ingest_duplicates_total')
  private readonly flushes = new Counter('ingest_flush_total')
  private readonly records = new Counter('ingest_records_total')

  duplicate(): void {
    this.dupes.inc()
  }

  flushed(count: number): void {
    this.flushes.inc()
    this.records.inc(count)
  }

  report(): Record<string, number> {
    return {
      duplicates: this.dupes.value,
      flushes: this.flushes.value,
      records: this.records.value,
    }
  }
}
`.split('\n')

const metricsBuilt = buildPatch(metricsBase, [
  {
    remove: ["import { Counter } from '../telemetry/counters'"],
    add: [
      "import { Counter, Gauge, Histogram } from '../telemetry/counters'",
    ],
  },
  {
    remove: [
      "  private readonly dupes = new Counter('ingest_duplicates_total')",
      "  private readonly flushes = new Counter('ingest_flush_total')",
      "  private readonly records = new Counter('ingest_records_total')",
    ],
    add: [
      "  private readonly dupes = new Counter('ingest_duplicates_total')",
      "  private readonly flushes = new Counter('ingest_flush_total')",
      "  private readonly records = new Counter('ingest_records_total')",
      "  private readonly poolTasks = new Counter('ingest_pool_tasks_total')",
      "  private readonly poolRetries = new Counter('ingest_pool_retries_total')",
      "  private readonly poolFailures = new Counter('ingest_pool_failures_total')",
      "  private readonly queueDepth = new Gauge('ingest_queue_depth')",
      "  private readonly inFlight = new Gauge('ingest_in_flight')",
      "  private readonly taskLatency = new Histogram('ingest_task_latency_ms')",
    ],
  },
  {
    remove: [
      '  flushed(count: number): void {',
      '    this.flushes.inc()',
      '    this.records.inc(count)',
      '  }',
      '',
      '  report(): Record<string, number> {',
      '    return {',
      '      duplicates: this.dupes.value,',
      '      flushes: this.flushes.value,',
      '      records: this.records.value,',
      '    }',
      '  }',
    ],
    add: [
      '  flushed(count: number): void {',
      '    this.flushes.inc()',
      '    this.records.inc(count)',
      '  }',
      '',
      '  poolTask(outcome: { retried: boolean; failed: boolean; latencyMs: number }): void {',
      '    this.poolTasks.inc()',
      '    if (outcome.retried) this.poolRetries.inc()',
      '    if (outcome.failed) this.poolFailures.inc()',
      '    this.taskLatency.observe(outcome.latencyMs)',
      '  }',
      '',
      '  observePool(depth: number, inFlight: number): void {',
      '    this.queueDepth.set(depth)',
      '    this.inFlight.set(inFlight)',
      '  }',
      '',
      '  report(): Record<string, number> {',
      '    return {',
      '      duplicates: this.dupes.value,',
      '      flushes: this.flushes.value,',
      '      records: this.records.value,',
      '      poolTasks: this.poolTasks.value,',
      '      poolRetries: this.poolRetries.value,',
      '      poolFailures: this.poolFailures.value,',
      '      queueDepth: this.queueDepth.value,',
      '      inFlight: this.inFlight.value,',
      '      taskLatencyP50: this.taskLatency.quantile(0.5),',
      '      taskLatencyP99: this.taskLatency.quantile(0.99),',
      '    }',
      '  }',
      '',
      '  /**',
      '   * Render the report as Prometheus text exposition so the scrape endpoint',
      '   * can serve it directly. Gauges and counters share the same line format;',
      '   * the caller supplies the metric type comments where it matters.',
      '   */',
      '  toPrometheus(): string {',
      '    const report = this.report()',
      '    const lines: string[] = []',
      '    for (const [key, value] of Object.entries(report)) {',
      "      lines.push(`ingest_${key} ${value}`)",
      '    }',
      "    return lines.join('\\n') + '\\n'",
      '  }',
      '',
      '  /** Duplicate ratio over all records seen, in [0, 1]. Zero before any flush. */',
      '  duplicateRatio(): number {',
      '    const seen = this.records.value + this.dupes.value',
      '    return seen === 0 ? 0 : this.dupes.value / seen',
      '  }',
      '',
      '  /**',
      '   * Fold this surface into an aggregate across shards. Counters sum; gauges',
      '   * take the latest observation, which for depth/in-flight is what a global',
      '   * view wants. Latency quantiles are not mergeable exactly, so the aggregate',
      '   * carries the max p99 as a conservative bound.',
      '   */',
      '  static aggregate(surfaces: IngestMetrics[]): Record<string, number> {',
      '    const out: Record<string, number> = {}',
      '    let maxP99 = 0',
      '    for (const surface of surfaces) {',
      '      const report = surface.report()',
      '      for (const [key, value] of Object.entries(report)) {',
      "        if (key === 'taskLatencyP99') {",
      '          maxP99 = Math.max(maxP99, value)',
      '          continue',
      '        }',
      "        if (key === 'queueDepth' || key === 'inFlight') {",
      '          out[key] = value',
      '        } else {',
      '          out[key] = (out[key] ?? 0) + value',
      '        }',
      '      }',
      '    }',
      '    out.taskLatencyP99 = maxP99',
      '    return out',
      '  }',
    ],
  },
])

// 10. src/config/ingest.ts
const configBase = `import { z } from 'zod'

const IngestConfigSchema = z.object({
  batchSize: z.number().int().positive().default(500),
  dedupeWindow: z.number().int().positive().default(100_000),
  checkpointDir: z.string().default('./checkpoints'),
})

export type IngestConfig = z.infer<typeof IngestConfigSchema>

/**
 * Load and validate ingest configuration from the environment, falling back to
 * defaults for anything unset. Throws if a provided value is malformed.
 */
export function loadIngestConfig(): IngestConfig {
  return IngestConfigSchema.parse({
    batchSize: numFromEnv('INGEST_BATCH_SIZE'),
    dedupeWindow: numFromEnv('INGEST_DEDUPE_WINDOW'),
    checkpointDir: process.env.INGEST_CHECKPOINT_DIR,
  })
}

function numFromEnv(key: string): number | undefined {
  const raw = process.env[key]
  return raw === undefined ? undefined : Number(raw)
}
`.split('\n')

const configBuilt = buildPatch(configBase, [
  {
    remove: ["import { z } from 'zod'"],
    add: [
      "import { z } from 'zod'",
      '',
      '/** Retry knobs, surfaced so the pool default can be tuned per environment. */',
      'const RetryConfigSchema = z.object({',
      '  maxAttempts: z.number().int().min(1).default(4),',
      '  baseDelayMs: z.number().int().positive().default(50),',
      '  maxDelayMs: z.number().int().positive().default(5_000),',
      '  jitter: z.number().min(0).max(1).default(0.3),',
      '})',
    ],
  },
  {
    remove: [
      'const IngestConfigSchema = z.object({',
      '  batchSize: z.number().int().positive().default(500),',
      '  dedupeWindow: z.number().int().positive().default(100_000),',
      "  checkpointDir: z.string().default('./checkpoints'),",
      '})',
    ],
    add: [
      'const IngestConfigSchema = z.object({',
      '  batchSize: z.number().int().positive().default(500),',
      '  batchMaxAgeMs: z.number().int().positive().default(1_000),',
      '  dedupeWindow: z.number().int().positive().default(100_000),',
      '  dedupeShards: z.number().int().positive().default(1),',
      "  checkpointDir: z.string().default('./checkpoints'),",
      '  checkpointRetain: z.number().int().positive().default(64),',
      '  poolSize: z.number().int().positive().optional(),',
      '  queueCapacity: z.number().int().positive().default(2_000),',
      '  taskTimeoutMs: z.number().int().positive().default(30_000),',
      '  retry: RetryConfigSchema.default({}),',
      '})',
    ],
  },
  {
    remove: ['export type IngestConfig = z.infer<typeof IngestConfigSchema>'],
    add: [
      'export type IngestConfig = z.infer<typeof IngestConfigSchema>',
      '',
      '/** Effective pool size given the config and the host core count. */',
      'export function effectivePoolSize(config: IngestConfig, cores: number): number {',
      '  return config.poolSize ?? cores * 2',
      '}',
      '',
      '/** A one-line human summary of the loaded config, for startup logs. */',
      'export function describeConfig(config: IngestConfig): string {',
      '  return [',
      "    `batch=${config.batchSize}`,",
      "    `queue=${config.queueCapacity}`,",
      "    `pool=${config.poolSize ?? 'auto'}`,",
      "    `dedupe=${config.dedupeWindow}/${config.dedupeShards}`,",
      "    `retry=${config.retry.maxAttempts}x`,",
      "  ].join(' ')",
      '}',
      '',
      '/** The subset of config the worker pool needs, resolved against core count. */',
      'export interface PoolConfig {',
      '  maxWorkers: number',
      '  queueCapacity: number',
      '  taskTimeoutMs: number',
      '  retry: IngestConfig[\'retry\']',
      '}',
      '',
      'export function poolConfigFromIngest(',
      '  config: IngestConfig,',
      '  cores: number,',
      '): PoolConfig {',
      '  return {',
      '    maxWorkers: effectivePoolSize(config, cores),',
      '    queueCapacity: config.queueCapacity,',
      '    taskTimeoutMs: config.taskTimeoutMs,',
      '    retry: config.retry,',
      '  }',
      '}',
    ],
  },
  {
    remove: [
      '  return IngestConfigSchema.parse({',
      "    batchSize: numFromEnv('INGEST_BATCH_SIZE'),",
      "    dedupeWindow: numFromEnv('INGEST_DEDUPE_WINDOW'),",
      '    checkpointDir: process.env.INGEST_CHECKPOINT_DIR,',
      '  })',
    ],
    add: [
      '  const parsed = IngestConfigSchema.parse({',
      "    batchSize: numFromEnv('INGEST_BATCH_SIZE'),",
      "    batchMaxAgeMs: numFromEnv('INGEST_BATCH_MAX_AGE_MS'),",
      "    dedupeWindow: numFromEnv('INGEST_DEDUPE_WINDOW'),",
      "    dedupeShards: numFromEnv('INGEST_DEDUPE_SHARDS'),",
      '    checkpointDir: process.env.INGEST_CHECKPOINT_DIR,',
      "    checkpointRetain: numFromEnv('INGEST_CHECKPOINT_RETAIN'),",
      "    poolSize: numFromEnv('INGEST_POOL_SIZE'),",
      "    queueCapacity: numFromEnv('INGEST_QUEUE_CAPACITY'),",
      "    taskTimeoutMs: numFromEnv('INGEST_TASK_TIMEOUT_MS'),",
      '  })',
      '  assertCoherent(parsed)',
      '  return parsed',
    ],
  },
  {
    remove: [
      'function numFromEnv(key: string): number | undefined {',
      '  const raw = process.env[key]',
      '  return raw === undefined ? undefined : Number(raw)',
      '}',
    ],
    add: [
      'function numFromEnv(key: string): number | undefined {',
      '  const raw = process.env[key]',
      '  if (raw === undefined) return undefined',
      '  const value = Number(raw)',
      '  if (Number.isNaN(value)) {',
      '    throw new Error(`${key} is not a number: ${raw}`)',
      '  }',
      '  return value',
      '}',
      '',
      '/** Cross-field validation the per-field schema cannot express alone. */',
      'function assertCoherent(config: IngestConfig): void {',
      '  if (config.queueCapacity < config.batchSize) {',
      '    throw new Error(',
      "      `queueCapacity (${config.queueCapacity}) must be >= batchSize (${config.batchSize})`,",
      '    )',
      '  }',
      '  if (config.retry.maxDelayMs < config.retry.baseDelayMs) {',
      "    throw new Error('retry.maxDelayMs must be >= retry.baseDelayMs')",
      '  }',
      '}',
    ],
  },
])

// 11. src/events/schema.ts
const schemaBase = `import { z } from 'zod'

/** The wire schema for an ingest envelope. Versioned so decoders can migrate. */
export const EnvelopeSchema = z.object({
  id: z.string().uuid(),
  version: z.literal(1),
  source: z.string(),
  timestamp: z.number().int(),
  payload: z.record(z.string(), z.unknown()),
})

export type Envelope = z.infer<typeof EnvelopeSchema>

export function isEnvelope(value: unknown): value is Envelope {
  return EnvelopeSchema.safeParse(value).success
}
`.split('\n')

const schemaBuilt = buildPatch(schemaBase, [
  {
    remove: [
      '/** The wire schema for an ingest envelope. Versioned so decoders can migrate. */',
      'export const EnvelopeSchema = z.object({',
      '  id: z.string().uuid(),',
      '  version: z.literal(1),',
      '  source: z.string(),',
      '  timestamp: z.number().int(),',
      '  payload: z.record(z.string(), z.unknown()),',
      '})',
      '',
      'export type Envelope = z.infer<typeof EnvelopeSchema>',
    ],
    add: [
      '/** Delivery metadata the pooled path needs to route and order envelopes. */',
      'export const DeliverySchema = z.object({',
      '  partition: z.number().int().nonnegative().default(0),',
      '  offset: z.number().int().nonnegative().optional(),',
      "  priority: z.enum(['low', 'normal', 'high']).default('normal'),",
      '})',
      '',
      'export type Delivery = z.infer<typeof DeliverySchema>',
      '',
      '/** The wire schema for an ingest envelope. Versioned so decoders can migrate. */',
      'export const EnvelopeSchema = z.object({',
      '  id: z.string().uuid(),',
      '  version: z.union([z.literal(1), z.literal(2)]),',
      '  source: z.string().min(1),',
      '  timestamp: z.number().int(),',
      '  delivery: DeliverySchema.default({}),',
      '  payload: z.record(z.string(), z.unknown()),',
      '})',
      '',
      'export type Envelope = z.infer<typeof EnvelopeSchema>',
      '',
      '/** Envelopes at or above this version carry a delivery block; older ones do not. */',
      'export const DELIVERY_MIN_VERSION = 2 as const',
      '',
      '/** Narrow an unknown value to an Envelope, returning the parse error on failure. */',
      'export function parseEnvelope(',
      '  value: unknown,',
      '): { ok: true; envelope: Envelope } | { ok: false; error: string } {',
      '  const result = EnvelopeSchema.safeParse(value)',
      '  return result.success',
      '    ? { ok: true, envelope: result.data }',
      '    : { ok: false, error: result.error.message }',
      '}',
    ],
  },
  {
    remove: [
      'export function isEnvelope(value: unknown): value is Envelope {',
      '  return EnvelopeSchema.safeParse(value).success',
      '}',
    ],
    add: [
      'export function isEnvelope(value: unknown): value is Envelope {',
      '  return EnvelopeSchema.safeParse(value).success',
      '}',
      '',
      '/** A framed batch of envelopes, as the pooled path checkpoints them. */',
      'export const BatchSchema = z.object({',
      '  batchId: z.string().uuid(),',
      '  producedAt: z.number().int(),',
      '  envelopes: z.array(EnvelopeSchema).min(1),',
      '})',
      '',
      'export type Batch = z.infer<typeof BatchSchema>',
      '',
      '/**',
      ' * Upgrade a v1 envelope to v2 by attaching a default delivery block. v2 and',
      ' * later pass through untouched. Keeps the pooled router able to assume every',
      ' * envelope carries delivery metadata.',
      ' */',
      'export function migrateEnvelope(envelope: Envelope): Envelope {',
      '  if (envelope.version >= DELIVERY_MIN_VERSION) return envelope',
      '  return {',
      '    ...envelope,',
      '    version: 2,',
      "    delivery: { partition: 0, priority: 'normal' },",
      '  }',
      '}',
      '',
      '/** Fields whose values are replaced with a placeholder before logging. */',
      "const REDACTED_KEYS = new Set(['token', 'secret', 'password', 'authorization'])",
      '',
      '/**',
      ' * Return a shallow copy of an envelope with sensitive payload fields masked,',
      ' * safe to attach to a log line or an error report. The original is untouched.',
      ' */',
      'export function redactEnvelope(envelope: Envelope): Envelope {',
      '  const payload: Record<string, unknown> = {}',
      '  for (const [key, value] of Object.entries(envelope.payload)) {',
      "    payload[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : value",
      '  }',
      '  return { ...envelope, payload }',
      '}',
    ],
  },
])

// 12. src/events/decode.ts
const decodeBase = `import { unpack, pack } from 'msgpackr'
import { EnvelopeSchema, type Envelope } from './schema'

/** Decode a single msgpack-encoded envelope, validating it against the schema. */
export function decodeEnvelope(raw: Uint8Array): Envelope {
  const value = unpack(raw)
  return EnvelopeSchema.parse(value)
}

/** Encode a batch of envelopes to a single msgpack buffer. */
export function encodeBatch(batch: Envelope[]): Uint8Array {
  return pack(batch)
}
`.split('\n')

const decodeBuilt = buildPatch(decodeBase, [
  {
    remove: [
      "import { unpack, pack } from 'msgpackr'",
      "import { EnvelopeSchema, type Envelope } from './schema'",
    ],
    add: [
      "import { unpack, unpackMultiple, pack } from 'msgpackr'",
      "import { EnvelopeSchema, type Envelope } from './schema'",
      '',
      'export class DecodeError extends Error {',
      '  constructor(',
      '    detail: string,',
      '    readonly cause?: unknown,',
      '  ) {',
      '    super(`failed to decode envelope: ${detail}`)',
      "    this.name = 'DecodeError'",
      '  }',
      '}',
    ],
  },
  {
    remove: [
      'export function decodeEnvelope(raw: Uint8Array): Envelope {',
      '  const value = unpack(raw)',
      '  return EnvelopeSchema.parse(value)',
      '}',
    ],
    add: [
      'export function decodeEnvelope(raw: Uint8Array): Envelope {',
      '  let value: unknown',
      '  try {',
      '    value = unpack(raw)',
      '  } catch (error) {',
      "    throw new DecodeError('malformed msgpack frame', error)",
      '  }',
      '  const parsed = EnvelopeSchema.safeParse(value)',
      '  if (!parsed.success) {',
      '    throw new DecodeError(parsed.error.message)',
      '  }',
      '  return parsed.data',
      '}',
      '',
      '/**',
      ' * Decode a frame that packs several envelopes back-to-back, skipping and',
      ' * collecting the individual decode failures so one bad record does not lose',
      ' * the whole batch.',
      ' */',
      'export function decodeBatch(raw: Uint8Array): {',
      '  envelopes: Envelope[]',
      '  errors: DecodeError[]',
      '} {',
      '  const values = unpackMultiple(raw) as unknown[]',
      '  const envelopes: Envelope[] = []',
      '  const errors: DecodeError[] = []',
      '  for (const value of values) {',
      '    const parsed = EnvelopeSchema.safeParse(value)',
      '    if (parsed.success) {',
      '      envelopes.push(parsed.data)',
      '    } else {',
      '      errors.push(new DecodeError(parsed.error.message))',
      '    }',
      '  }',
      '  return { envelopes, errors }',
      '}',
    ],
  },
  {
    remove: [
      '/** Encode a batch of envelopes to a single msgpack buffer. */',
      'export function encodeBatch(batch: Envelope[]): Uint8Array {',
      '  return pack(batch)',
      '}',
    ],
    add: [
      '/** Encode a batch of envelopes to a single msgpack buffer. */',
      'export function encodeBatch(batch: Envelope[]): Uint8Array {',
      '  return pack(batch)',
      '}',
      '',
      '/**',
      ' * Encode a batch with a fixed-width length prefix so a reader can frame the',
      ' * payload without a separate length side-channel. The first four bytes are',
      " * the little-endian byte length of the msgpack body that follows.",
      ' */',
      'export function encodeFramedBatch(batch: Envelope[]): Uint8Array {',
      '  const body = pack(batch)',
      '  const framed = new Uint8Array(4 + body.byteLength)',
      '  const view = new DataView(framed.buffer)',
      '  view.setUint32(0, body.byteLength, true)',
      '  framed.set(body, 4)',
      '  return framed',
      '}',
      '',
      '/** Read a length-prefixed frame written by encodeFramedBatch. */',
      'export function decodeFramedBatch(framed: Uint8Array): Envelope[] {',
      '  if (framed.byteLength < 4) {',
      "    throw new DecodeError('framed batch is shorter than its length prefix')",
      '  }',
      '  const view = new DataView(framed.buffer, framed.byteOffset)',
      '  const length = view.getUint32(0, true)',
      '  const body = framed.subarray(4, 4 + length)',
      '  const value = unpack(body) as unknown[]',
      '  return value.map((v) => EnvelopeSchema.parse(v))',
      '}',
    ],
  },
])

// 13. src/ingest/pipeline.test.ts
const pipelineTestBase = `import { test, expect } from 'bun:test'
import { Pipeline } from './pipeline'
import { makeEnvelope } from '../../test/factories'

test('pipeline dedupes by envelope id', async () => {
  const pipeline = new Pipeline()
  const envelope = makeEnvelope({ id: 'dup-1' })
  await pipeline.ingest(envelope)
  await pipeline.ingest(envelope)
  await pipeline.flush()
  expect(pipeline).toBeDefined()
})

test('pipeline flushes a partial batch', async () => {
  const pipeline = new Pipeline()
  for (let i = 0; i < 3; i++) {
    await pipeline.ingest(makeEnvelope({ id: \`e-\${i}\` }))
  }
  await pipeline.flush()
  expect(pipeline).toBeDefined()
})
`.split('\n')

const pipelineTestBuilt = buildPatch(pipelineTestBase, [
  {
    remove: [
      "import { test, expect } from 'bun:test'",
      "import { Pipeline } from './pipeline'",
      "import { makeEnvelope } from '../../test/factories'",
    ],
    add: [
      "import { test, expect, mock } from 'bun:test'",
      "import { Pipeline } from './pipeline'",
      "import { makeEnvelope } from '../../test/factories'",
      '',
      'function drainingPipeline(): Pipeline {',
      '  const pipeline = new Pipeline()',
      '  return pipeline',
      '}',
    ],
  },
  {
    remove: [
      '  expect(pipeline).toBeDefined()',
      '})',
      '',
      "test('pipeline flushes a partial batch', async () => {",
      '  const pipeline = new Pipeline()',
      '  for (let i = 0; i < 3; i++) {',
      "    await pipeline.ingest(makeEnvelope({ id: `e-${i}` }))",
      '  }',
      '  await pipeline.flush()',
      '  expect(pipeline).toBeDefined()',
      '})',
    ],
    add: [
      '  expect(pipeline).toBeDefined()',
      '})',
      '',
      "test('pipeline drains the pool on flush', async () => {",
      '  const pipeline = drainingPipeline()',
      "  await pipeline.ingest(makeEnvelope({ id: 'drain-1' }))",
      '  await pipeline.flush()',
      '  expect(pipeline).toBeDefined()',
      '})',
      '',
      "test('pipeline submits distinct envelopes concurrently', async () => {",
      '  const pipeline = drainingPipeline()',
      '  const seen = new Set<string>()',
      '  const submit = mock(async (id: string) => {',
      '    seen.add(id)',
      '  })',
      '  await Promise.all(',
      "    Array.from({ length: 8 }, (_, i) => `c-${i}`).map((id) =>",
      '      pipeline.ingest(makeEnvelope({ id })).then(() => submit(id)),',
      '    ),',
      '  )',
      '  await pipeline.flush()',
      '  expect(seen.size).toBe(8)',
      '})',
      '',
      "test('pipeline flushes a partial batch', async () => {",
      '  const pipeline = new Pipeline()',
      '  for (let i = 0; i < 3; i++) {',
      "    await pipeline.ingest(makeEnvelope({ id: `e-${i}` }))",
      '  }',
      '  await pipeline.flush()',
      '  expect(pipeline).toBeDefined()',
      '})',
      '',
      "test('flush is idempotent when the buffer is empty', async () => {",
      '  const pipeline = new Pipeline()',
      '  await pipeline.flush()',
      '  await pipeline.flush()',
      '  expect(pipeline).toBeDefined()',
      '})',
      '',
      "test('stats report pool depth and dedupe size', async () => {",
      '  const pipeline = drainingPipeline()',
      '  for (let i = 0; i < 5; i++) {',
      "    await pipeline.ingest(makeEnvelope({ id: `s-${i}` }))",
      '  }',
      '  const stats = pipeline.stats()',
      '  expect(stats.dedupe).toBeGreaterThanOrEqual(5)',
      "  expect(stats.pool).toHaveProperty('queueDepth')",
      '  await pipeline.flush()',
      '})',
      '',
      "test('duplicate envelopes never reach the checkpoint stage', async () => {",
      '  const pipeline = drainingPipeline()',
      "  const env = makeEnvelope({ id: 'only-once' })",
      '  await pipeline.ingest(env)',
      '  await pipeline.ingest(env)',
      '  await pipeline.ingest(env)',
      '  await pipeline.flush()',
      '  const stats = pipeline.stats()',
      '  expect(stats.dedupe).toBe(1)',
      '})',
    ],
  },
])

// 14. src/ingest/worker-pool.test.ts
const workerPoolTestBase = `import { test, expect } from 'bun:test'

/**
 * Placeholder suite for the pooled worker implementation. Replaced wholesale
 * when the pool lands; kept here so the file exists in history.
 */
test('worker pool suite is registered', () => {
  expect(true).toBe(true)
})
`.split('\n')

const workerPoolTestBuilt = buildPatch(workerPoolTestBase, [
  {
    remove: [
      "import { test, expect } from 'bun:test'",
      '',
      '/**',
      ' * Placeholder suite for the pooled worker implementation. Replaced wholesale',
      ' * when the pool lands; kept here so the file exists in history.',
      ' */',
      "test('worker pool suite is registered', () => {",
      '  expect(true).toBe(true)',
      '})',
    ],
    add: [
      "import { test, expect } from 'bun:test'",
      'import {',
      '  createWorkerPool,',
      '  backoffDelay,',
      '  DEFAULT_RETRY,',
      '  RateLimiter,',
      '  CircuitBreaker,',
      '  CircuitOpenError,',
      '  submitBatch,',
      '  PoolSupervisor,',
      '  drainWithTimeout,',
      '  mapConcurrent,',
      "} from './worker-pool'",
      '',
      "test('backoff grows exponentially and stays capped', () => {",
      '  const noJitter = { ...DEFAULT_RETRY, jitter: 0 }',
      '  expect(backoffDelay(noJitter, 1)).toBe(50)',
      '  expect(backoffDelay(noJitter, 2)).toBe(100)',
      '  expect(backoffDelay(noJitter, 99)).toBe(noJitter.maxDelayMs)',
      '})',
      '',
      "test('pool rejects with backpressure when the queue is full', async () => {",
      '  const pool = createWorkerPool<number, number>({',
      '    maxWorkers: 1,',
      '    queueCapacity: 1,',
      '    taskTimeoutMs: 1_000,',
      '  })',
      '  const slow = () => new Promise<number>((r) => setTimeout(() => r(1), 50))',
      '  const first = pool.submit(1, slow)',
      '  const second = pool.submit(2, slow)',
      '  await expect(pool.submit(3, slow)).rejects.toThrow(/queue is full/)',
      '  await Promise.allSettled([first, second])',
      '  await pool.shutdown()',
      '})',
      '',
      "test('pool retries a flaky task then succeeds', async () => {",
      '  const pool = createWorkerPool<number, number>({',
      '    maxWorkers: 1,',
      '    queueCapacity: 4,',
      '    taskTimeoutMs: 1_000,',
      '    retry: { baseDelayMs: 1, jitter: 0 },',
      '  })',
      '  let attempts = 0',
      '  const value = await pool.submit(7, async () => {',
      '    attempts++',
      "    if (attempts < 3) throw new Error('flaky')",
      '    return 42',
      '  })',
      '  expect(value).toBe(42)',
      '  expect(attempts).toBe(3)',
      '  await pool.shutdown()',
      '})',
      '',
      "test('pool metrics count submissions, completions, and retries', async () => {",
      '  const pool = createWorkerPool<number, number>({',
      '    maxWorkers: 2,',
      '    queueCapacity: 8,',
      '    taskTimeoutMs: 1_000,',
      '    retry: { baseDelayMs: 1, jitter: 0 },',
      '  })',
      '  let flaky = 0',
      '  await submitBatch(pool, [1, 2, 3], async (n) => {',
      '    if (n === 2 && flaky++ === 0) throw new Error(\'once\')',
      '    return n',
      '  })',
      '  expect(pool.metrics.submitted).toBe(3)',
      '  expect(pool.metrics.completed).toBe(3)',
      '  expect(pool.metrics.retried).toBeGreaterThanOrEqual(1)',
      '  await pool.shutdown()',
      '})',
      '',
      "test('rate limiter hands out tokens up to capacity then refills', () => {",
      '  let clock = 0',
      '  const limiter = new RateLimiter({',
      '    capacity: 2,',
      '    ratePerSec: 10,',
      '    now: () => clock,',
      '  })',
      '  expect(limiter.tryTake()).toBe(true)',
      '  expect(limiter.tryTake()).toBe(true)',
      '  expect(limiter.tryTake()).toBe(false)',
      '  clock = 1000',
      '  expect(limiter.available).toBe(2)',
      '})',
      '',
      "test('circuit breaker opens after the failure threshold', async () => {",
      '  let clock = 0',
      '  const breaker = new CircuitBreaker({',
      '    failureThreshold: 2,',
      '    resetTimeoutMs: 100,',
      '    now: () => clock,',
      '  })',
      "  const boom = () => Promise.reject(new Error('down'))",
      '  await expect(breaker.run(boom)).rejects.toThrow(/down/)',
      '  await expect(breaker.run(boom)).rejects.toThrow(/down/)',
      "  expect(breaker.current).toBe('open')",
      '  await expect(breaker.run(boom)).rejects.toBeInstanceOf(CircuitOpenError)',
      '  clock = 200',
      '  await expect(breaker.run(async () => 1)).resolves.toBe(1)',
      "  expect(breaker.current).toBe('closed')",
      '})',
      '',
      "test('mapConcurrent preserves input order', async () => {",
      '  const pool = createWorkerPool<number, number>({',
      '    maxWorkers: 4,',
      '    queueCapacity: 16,',
      '    taskTimeoutMs: 1_000,',
      '  })',
      '  const out = await mapConcurrent(pool, [1, 2, 3, 4, 5], async (n) => {',
      '    await new Promise((r) => setTimeout(r, (6 - n) * 5))',
      '    return n * n',
      '  })',
      '  expect(out).toEqual([1, 4, 9, 16, 25])',
      '  await pool.shutdown()',
      '})',
      '',
      "test('supervisor routes to named pools and aggregates metrics', async () => {",
      '  const supervisor = new PoolSupervisor()',
      '  const decode = createWorkerPool<number, number>({',
      '    maxWorkers: 2,',
      '    queueCapacity: 8,',
      '    taskTimeoutMs: 1_000,',
      '  })',
      '  const write = createWorkerPool<number, number>({',
      '    maxWorkers: 1,',
      '    queueCapacity: 8,',
      '    taskTimeoutMs: 1_000,',
      '  })',
      "  supervisor.register('decode', decode)",
      "  supervisor.register('write', write)",
      "  await supervisor.submit('decode', 1, async (n) => n)",
      "  await supervisor.submit('write', 2, async (n) => n)",
      '  const metrics = supervisor.metricsByPool()',
      '  expect(metrics.decode.completed).toBe(1)',
      '  expect(metrics.write.completed).toBe(1)',
      "  await expect(supervisor.submit('missing', 3, async (n) => n)).rejects.toThrow(",
      '    /no pool registered/,',
      '  )',
      '  await supervisor.shutdownAll()',
      '})',
      '',
      "test('drainWithTimeout returns true when a pool drains in time', async () => {",
      '  const pool = createWorkerPool<number, number>({',
      '    maxWorkers: 2,',
      '    queueCapacity: 8,',
      '    taskTimeoutMs: 1_000,',
      '  })',
      '  await pool.submit(1, async (n) => n)',
      '  expect(await drainWithTimeout(pool, 500)).toBe(true)',
      '})',
    ],
  },
])

// 15. src/telemetry/counters.ts
const countersBase = `/**
 * A trivial in-process counter registry. Counters are created by name and
 * accumulate monotonically; a scrape reads their current values.
 */
export class Counter {
  private count = 0

  constructor(readonly name: string) {}

  inc(by = 1): void {
    this.count += by
  }

  get value(): number {
    return this.count
  }
}

export class Metrics {
  private counters = new Map<string, Counter>()

  constructor(private readonly namespace: string) {}

  increment(key: string, by = 1): void {
    this.counter(key).inc(by)
  }

  private counter(key: string): Counter {
    const name = \`\${this.namespace}_\${key}\`
    let counter = this.counters.get(name)
    if (!counter) {
      counter = new Counter(name)
      this.counters.set(name, counter)
    }
    return counter
  }
}
`.split('\n')

const countersBuilt = buildPatch(countersBase, [
  {
    remove: [
      'export class Counter {',
      '  private count = 0',
      '',
      '  constructor(readonly name: string) {}',
      '',
      '  inc(by = 1): void {',
      '    this.count += by',
      '  }',
      '',
      '  get value(): number {',
      '    return this.count',
      '  }',
      '}',
    ],
    add: [
      'export class Counter {',
      '  private count = 0',
      '  private updatedAt = 0',
      '',
      '  constructor(readonly name: string) {}',
      '',
      '  inc(by = 1): void {',
      '    this.count += by',
      '    this.updatedAt = Date.now()',
      '  }',
      '',
      '  get value(): number {',
      '    return this.count',
      '  }',
      '}',
      '',
      '/** A settable point-in-time value, unlike a monotonic counter. */',
      'export class Gauge {',
      '  private current = 0',
      '',
      '  constructor(readonly name: string) {}',
      '',
      '  set(value: number): void {',
      '    this.current = value',
      '  }',
      '',
      '  add(delta: number): void {',
      '    this.current += delta',
      '  }',
      '',
      '  get value(): number {',
      '    return this.current',
      '  }',
      '}',
      '',
      '/**',
      ' * A minimal streaming histogram: retains recent observations and answers',
      ' * approximate quantiles by sorting the retained sample. Adequate for coarse',
      ' * latency reporting without a full t-digest.',
      ' */',
      'export class Histogram {',
      '  private readonly samples: number[] = []',
      '  private total = 0',
      '  private observations = 0',
      '',
      '  constructor(',
      '    readonly name: string,',
      '    private readonly cap = 2048,',
      '  ) {}',
      '',
      '  observe(value: number): void {',
      '    this.total += value',
      '    this.observations++',
      '    this.samples.push(value)',
      '    if (this.samples.length > this.cap) this.samples.shift()',
      '  }',
      '',
      '  quantile(q: number): number {',
      '    if (this.samples.length === 0) return 0',
      '    const sorted = [...this.samples].sort((a, b) => a - b)',
      '    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length))',
      '    return sorted[idx]',
      '  }',
      '',
      '  get mean(): number {',
      '    return this.observations === 0 ? 0 : this.total / this.observations',
      '  }',
      '}',
    ],
  },
  {
    remove: ['    return counter', '  }', '}'],
    add: [
      '    return counter',
      '  }',
      '',
      '  snapshot(): Record<string, number> {',
      '    const out: Record<string, number> = {}',
      '    for (const [name, counter] of this.counters) {',
      '      out[name] = counter.value',
      '    }',
      '    return out',
      '  }',
      '}',
    ],
  },
])

// ————————————————————————————————————————————————————————————————
// Blobs. Head content is authored above (or derived by buildPatch); base is the
// pre-edit content. For added files base is null and there is no base blob.
// ————————————————————————————————————————————————————————————————

const workerPoolHead = blob(
  'src/ingest/worker-pool.ts',
  workerPoolContent,
  'pr204-worker-pool-head',
)
const lockBase = blob('bun.lock', lockBaseContent, 'pr204-lock-base')
const lockHead = blob('bun.lock', lockHeadContent, 'pr204-lock-head')
const pngBinary = binaryBlob('docs/pipeline-topology.png', 48213, 'pr204-png')

const queueBase = blob('src/queue.ts', queueBaseLines.join('\n'), 'pr204-queue-base')
const queueHead = blob(
  'src/ingest/queue.ts',
  queueBuilt.headContent,
  'pr204-queue-head',
)

const pipelineBaseBlob = blob('src/ingest/pipeline.ts', pipelineBase.join('\n'), 'pr204-pipeline-base')
const pipelineHead = blob('src/ingest/pipeline.ts', pipelineBuilt.headContent, 'pr204-pipeline-head')
const batcherBaseBlob = blob('src/ingest/batcher.ts', batcherBase.join('\n'), 'pr204-batcher-base')
const batcherHead = blob('src/ingest/batcher.ts', batcherBuilt.headContent, 'pr204-batcher-head')
const dedupeBaseBlob = blob('src/ingest/dedupe.ts', dedupeBase.join('\n'), 'pr204-dedupe-base')
const dedupeHead = blob('src/ingest/dedupe.ts', dedupeBuilt.headContent, 'pr204-dedupe-head')
const checkpointsBaseBlob = blob('src/ingest/checkpoints.ts', checkpointsBase.join('\n'), 'pr204-checkpoints-base')
const checkpointsHead = blob('src/ingest/checkpoints.ts', checkpointsBuilt.headContent, 'pr204-checkpoints-head')
const metricsBaseBlob = blob('src/ingest/metrics.ts', metricsBase.join('\n'), 'pr204-metrics-base')
const metricsHead = blob('src/ingest/metrics.ts', metricsBuilt.headContent, 'pr204-metrics-head')
const configBaseBlob = blob('src/config/ingest.ts', configBase.join('\n'), 'pr204-config-base')
const configHead = blob('src/config/ingest.ts', configBuilt.headContent, 'pr204-config-head')
const schemaBaseBlob = blob('src/events/schema.ts', schemaBase.join('\n'), 'pr204-schema-base')
const schemaHead = blob('src/events/schema.ts', schemaBuilt.headContent, 'pr204-schema-head')
const decodeBaseBlob = blob('src/events/decode.ts', decodeBase.join('\n'), 'pr204-decode-base')
const decodeHead = blob('src/events/decode.ts', decodeBuilt.headContent, 'pr204-decode-head')
const pipelineTestBaseBlob = blob('src/ingest/pipeline.test.ts', pipelineTestBase.join('\n'), 'pr204-pipeline-test-base')
const pipelineTestHead = blob('src/ingest/pipeline.test.ts', pipelineTestBuilt.headContent, 'pr204-pipeline-test-head')
const workerPoolTestBaseBlob = blob('src/ingest/worker-pool.test.ts', workerPoolTestBase.join('\n'), 'pr204-worker-pool-test-base')
const workerPoolTestHead = blob('src/ingest/worker-pool.test.ts', workerPoolTestBuilt.headContent, 'pr204-worker-pool-test-head')
const countersBaseBlob = blob('src/telemetry/counters.ts', countersBase.join('\n'), 'pr204-counters-base')
const countersHead = blob('src/telemetry/counters.ts', countersBuilt.headContent, 'pr204-counters-head')

// ————————————————————————————————————————————————————————————————
// Files list. `pullFile` derives additions/deletions from the patch; the binary
// file carries no patch and zero counts.
// ————————————————————————————————————————————————————————————————

const files: PullFile[] = [
  pullFile({
    sha: workerPoolHead.sha,
    filename: 'src/ingest/worker-pool.ts',
    status: 'added',
    patch: addedPatch(workerPoolContent),
  }),
  pullFile({
    sha: lockHead.sha,
    filename: 'bun.lock',
    status: 'modified',
    patch: lockPatch,
  }),
  pullFile({
    sha: pngBinary.sha,
    filename: 'docs/pipeline-topology.png',
    status: 'added',
    additions: 0,
    deletions: 0,
  }),
  pullFile({
    sha: queueHead.sha,
    filename: 'src/ingest/queue.ts',
    previous_filename: 'src/queue.ts',
    status: 'renamed',
    patch: queueBuilt.patch,
  }),
  pullFile({
    sha: pipelineHead.sha,
    filename: 'src/ingest/pipeline.ts',
    status: 'modified',
    patch: pipelineBuilt.patch,
  }),
  pullFile({
    sha: batcherHead.sha,
    filename: 'src/ingest/batcher.ts',
    status: 'modified',
    patch: batcherBuilt.patch,
  }),
  pullFile({
    sha: dedupeHead.sha,
    filename: 'src/ingest/dedupe.ts',
    status: 'modified',
    patch: dedupeBuilt.patch,
  }),
  pullFile({
    sha: checkpointsHead.sha,
    filename: 'src/ingest/checkpoints.ts',
    status: 'modified',
    patch: checkpointsBuilt.patch,
  }),
  pullFile({
    sha: metricsHead.sha,
    filename: 'src/ingest/metrics.ts',
    status: 'modified',
    patch: metricsBuilt.patch,
  }),
  pullFile({
    sha: configHead.sha,
    filename: 'src/config/ingest.ts',
    status: 'modified',
    patch: configBuilt.patch,
  }),
  pullFile({
    sha: schemaHead.sha,
    filename: 'src/events/schema.ts',
    status: 'modified',
    patch: schemaBuilt.patch,
  }),
  pullFile({
    sha: decodeHead.sha,
    filename: 'src/events/decode.ts',
    status: 'modified',
    patch: decodeBuilt.patch,
  }),
  pullFile({
    sha: pipelineTestHead.sha,
    filename: 'src/ingest/pipeline.test.ts',
    status: 'modified',
    patch: pipelineTestBuilt.patch,
  }),
  pullFile({
    sha: workerPoolTestHead.sha,
    filename: 'src/ingest/worker-pool.test.ts',
    status: 'modified',
    patch: workerPoolTestBuilt.patch,
  }),
  pullFile({
    sha: countersHead.sha,
    filename: 'src/telemetry/counters.ts',
    status: 'modified',
    patch: countersBuilt.patch,
  }),
]

const blobs: FileBlob[] = [
  workerPoolHead,
  lockBase,
  lockHead,
  pngBinary,
  queueBase,
  queueHead,
  pipelineBaseBlob,
  pipelineHead,
  batcherBaseBlob,
  batcherHead,
  dedupeBaseBlob,
  dedupeHead,
  checkpointsBaseBlob,
  checkpointsHead,
  metricsBaseBlob,
  metricsHead,
  configBaseBlob,
  configHead,
  schemaBaseBlob,
  schemaHead,
  decodeBaseBlob,
  decodeHead,
  pipelineTestBaseBlob,
  pipelineTestHead,
  workerPoolTestBaseBlob,
  workerPoolTestHead,
  countersBaseBlob,
  countersHead,
]

const blobIndex: Record<string, { base: string | null; head: string | null }> = {
  'src/ingest/worker-pool.ts': { base: null, head: workerPoolHead.sha },
  'bun.lock': { base: lockBase.sha, head: lockHead.sha },
  'docs/pipeline-topology.png': { base: null, head: pngBinary.sha },
  // Renamed file: base content lives at the old path, head at the new path.
  'src/ingest/queue.ts': { base: queueBase.sha, head: queueHead.sha },
  'src/ingest/pipeline.ts': { base: pipelineBaseBlob.sha, head: pipelineHead.sha },
  'src/ingest/batcher.ts': { base: batcherBaseBlob.sha, head: batcherHead.sha },
  'src/ingest/dedupe.ts': { base: dedupeBaseBlob.sha, head: dedupeHead.sha },
  'src/ingest/checkpoints.ts': { base: checkpointsBaseBlob.sha, head: checkpointsHead.sha },
  'src/ingest/metrics.ts': { base: metricsBaseBlob.sha, head: metricsHead.sha },
  'src/config/ingest.ts': { base: configBaseBlob.sha, head: configHead.sha },
  'src/events/schema.ts': { base: schemaBaseBlob.sha, head: schemaHead.sha },
  'src/events/decode.ts': { base: decodeBaseBlob.sha, head: decodeHead.sha },
  'src/ingest/pipeline.test.ts': { base: pipelineTestBaseBlob.sha, head: pipelineTestHead.sha },
  'src/ingest/worker-pool.test.ts': { base: workerPoolTestBaseBlob.sha, head: workerPoolTestHead.sha },
  'src/telemetry/counters.ts': { base: countersBaseBlob.sha, head: countersHead.sha },
}

// ————————————————————————————————————————————————————————————————
// Commits — eight over five days.
// ————————————————————————————————————————————————————————————————

function commit(
  shaLabel: string,
  message: string,
  date: string,
  parentLabel: string | null,
): CommitInfo {
  return {
    sha: shaLabel,
    commit: {
      message,
      author: { name: MARCUS.name, email: MARCUS.email, date },
      // The author block mirrors GitHub: the real commit author is the human,
      // but the PR itself is opened through the broker bot.
    },
    author: BROKER_BOT,
    parents: parentLabel ? [{ sha: parentLabel }] : [],
  }
}

const commits: CommitInfo[] = [
  commit(
    '1f0a44d9c3b27e6810fa5c9d2e4b7a03f81c6d52',
    'feat(ingest): scaffold pooled worker module',
    daysAgo(5),
    MERGE_BASE_SHA,
  ),
  commit(
    '2b1c55eae4c38f7921fb6d0a3f5c8b14a92d7e63',
    'feat(ingest): task queue with backpressure',
    daysAgo(5),
    '1f0a44d9c3b27e6810fa5c9d2e4b7a03f81c6d52',
  ),
  commit(
    '3c2d66fbf5d4907a32fc7e1b4a6d9c25ba3e8f74',
    'feat(ingest): retry with exponential backoff + jitter',
    daysAgo(4),
    '2b1c55eae4c38f7921fb6d0a3f5c8b14a92d7e63',
  ),
  commit(
    '4d3e770a06e5a18b43fd8f2c5b7ead36cb4f9085',
    'feat(ingest): worker health checks and recycle',
    daysAgo(4),
    '3c2d66fbf5d4907a32fc7e1b4a6d9c25ba3e8f74',
  ),
  commit(
    '5e4f881b17f6b29c54fe903d6c8fbe47dc5a0196',
    'refactor(ingest): move queue under ingest/ and wire the pool',
    daysAgo(3),
    '4d3e770a06e5a18b43fd8f2c5b7ead36cb4f9085',
  ),
  commit(
    '6f50992c28070a3d65ffa14e7d90cf58ed6b12a7',
    'feat(ingest): pool metrics and pipeline drain on flush',
    daysAgo(2),
    '5e4f881b17f6b29c54fe903d6c8fbe47dc5a0196',
  ),
  commit(
    '70611a3d39181b4e76fab25f8ea1d069fe7c23b8',
    'test(ingest): backoff, backpressure, and retry coverage',
    daysAgo(1),
    '6f50992c28070a3d65ffa14e7d90cf58ed6b12a7',
  ),
  commit(
    HEAD_SHA,
    'chore: regenerate lockfile and add topology diagram',
    hoursAgo(6),
    '70611a3d39181b4e76fab25f8ea1d069fe7c23b8',
  ),
]

// ————————————————————————————————————————————————————————————————
// Threads — one unresolved, from the org member dkozlov (real identity, no
// prefix), anchored on pipeline.ts at the pool-sizing line.
// ————————————————————————————————————————————————————————————————

// Anchor the review on the pool-sizing line dkozlov is questioning. Find its
// 1-based line number in the head file and the unified-diff hunk that contains
// it, so the rendered thread lands on exactly that line and its diff_hunk shows
// the surrounding change — no hand-counted anchors.
const POOL_SIZING_LINE = '      maxWorkers: config.poolSize ?? cpus().length * 2,'
const pipelineHeadLines = pipelineBuilt.headContent.split('\n')
const poolSizingHeadLine = pipelineHeadLines.indexOf(POOL_SIZING_LINE) + 1

function hunkContainingHeadLine(patch: string, headLine: number): string {
  const chunks = patch.split(/\n(?=@@ )/)
  for (const chunk of chunks) {
    const header = /^@@ -\d+,\d+ \+(\d+),(\d+) @@/.exec(chunk)
    if (!header) continue
    const start = Number(header[1])
    const count = Number(header[2])
    if (headLine >= start && headLine < start + count) return chunk
  }
  return chunks[0]
}

const pipelineDiffHunk = hunkContainingHeadLine(
  pipelineBuilt.patch,
  poolSizingHeadLine,
)

const threads: ReviewThread[] = [
  {
    id: nodeId('PRRT', 20401),
    isResolved: false,
    isOutdated: false,
    path: 'src/ingest/pipeline.ts',
    line: poolSizingHeadLine,
    originalLine: poolSizingHeadLine,
    startLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    startDiffSide: null,
    subjectType: 'LINE',
    resolvedBy: null,
    comments: [
      {
        id: 2040101,
        node_id: nodeId('PRRC', 2040101),
        pull_request_review_id: null,
        path: 'src/ingest/pipeline.ts',
        diff_hunk: pipelineDiffHunk,
        commit_id: HEAD_SHA,
        original_commit_id: HEAD_SHA,
        line: poolSizingHeadLine,
        original_line: poolSizingHeadLine,
        start_line: null,
        original_start_line: null,
        side: 'RIGHT',
        start_side: null,
        subject_type: 'line',
        user: ORG_DKOZLOV,
        body: 'pool sizing: why cores*2? measure first. Doubling core count is a guess — on the ingest boxes most of these tasks are IO-bound on the checkpoint write, so 2x cores mostly buys context-switch overhead. Can you land a bench before we commit to the default?',
        created_at: daysAgo(1),
        updated_at: daysAgo(1),
        reactions: emptyReactions(2040101),
        html_url: `https://github.com/${OWNER}/pull/204#discussion_r2040101`,
      },
    ],
  },
]

// ————————————————————————————————————————————————————————————————
// Issue comment — one, prefixed (Marcus), summarizing the migration.
// ————————————————————————————————————————————————————————————————

const issueComments: IssueComment[] = [
  {
    id: 2040900,
    node_id: nodeId('IC', 2040900),
    user: BROKER_BOT,
    body: prefixBody(
      MARCUS,
      [
        'Migration summary — the single-consumer ingest loop is replaced by a bounded worker pool.',
        '',
        '- `worker-pool.ts` is new: a fixed-size pool with a capacity-bounded queue (backpressure instead of OOM), retry with exponential backoff + jitter, idle health probes that recycle wedged workers, and cooperative drain/shutdown.',
        '- `pipeline.ts` and the renamed `ingest/queue.ts` now submit work to the pool instead of awaiting inline.',
        '- Config gains `poolSize` (defaults to `cores * 2`) and `taskTimeoutMs`.',
        '- New counters for pool tasks/retries feed the existing telemetry surface.',
        '',
        'The lockfile churn is the added `piscina`/`tinypool` dev deps and a couple of version bumps. The PNG is the updated topology diagram for the runbook.',
        '',
        'Open question from Dmitri on core*2 sizing is fair — I have a bench branch, will attach numbers before this merges.',
      ].join('\n'),
    ),
    created_at: hoursAgo(20),
    updated_at: hoursAgo(20),
    reactions: emptyReactions(2040900),
  },
]

// ————————————————————————————————————————————————————————————————
// Checks — typecheck pass, tests pass, e2e in_progress.
// ————————————————————————————————————————————————————————————————

const checks: CheckRun[] = [
  {
    id: 204010,
    name: 'ci/typecheck',
    status: 'completed',
    conclusion: 'success',
    started_at: hoursAgo(6),
    completed_at: hoursAgo(6),
    details_url: `https://github.com/${OWNER}/pull/204/checks?check_run_id=204010`,
    output: {
      title: 'tsc: no errors',
      summary: 'Type-checked 214 files in 11.2s.',
    },
  },
  {
    id: 204011,
    name: 'ci/tests',
    status: 'completed',
    conclusion: 'success',
    started_at: hoursAgo(6),
    completed_at: hoursAgo(5),
    details_url: `https://github.com/${OWNER}/pull/204/checks?check_run_id=204011`,
    output: {
      title: '186 passed',
      summary: '186 passed, 0 failed across 31 suites in 48.7s.',
    },
  },
  {
    id: 204012,
    name: 'ci/e2e',
    status: 'in_progress',
    conclusion: null,
    started_at: hoursAgo(1),
    completed_at: null,
    details_url: `https://github.com/${OWNER}/pull/204/checks?check_run_id=204012`,
    output: {
      title: 'ingest e2e running',
      summary: 'Replaying the 50k-envelope fixture through the pooled pipeline.',
    },
  },
]

// ————————————————————————————————————————————————————————————————
// Detail counts — honest sums from every file's derived counts.
// ————————————————————————————————————————————————————————————————

const additions = files.reduce((sum, f) => sum + f.additions, 0)
const deletions = files.reduce((sum, f) => sum + f.deletions, 0)

const detail: PullDetail = {
  id: 100000204,
  node_id: nodeId('PR', 204),
  number: 204,
  state: 'open',
  draft: false,
  merged_at: null,
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  title: 'feat(ingest): migrate ingestion pipeline to pooled workers',
  body: prefixBody(
    MARCUS,
    [
      'Replaces the single-consumer ingest loop with a bounded pool of workers.',
      '',
      'The pool applies backpressure at capacity rather than growing unbounded, retries transient failures with exponential backoff + jitter, and recycles workers that fail health probes. Pipeline and queue now submit into the pool; config exposes `poolSize` and `taskTimeoutMs`.',
      '',
      'Large diff: the bulk is the new `worker-pool.ts` and a regenerated lockfile. The topology PNG is for the runbook.',
    ].join('\n'),
  ),
  user: BROKER_BOT,
  labels: [
    { id: 5001, name: 'ingest', color: '3FD0B4', description: 'Ingestion pipeline' },
    { id: 5002, name: 'large', color: 'D9B44A', description: 'Large diff' },
  ],
  requested_reviewers: [],
  head: {
    ref: 'marcus/ingest-worker-pool',
    sha: HEAD_SHA,
    label: 'meridian-labs:marcus/ingest-worker-pool',
    repo: { full_name: OWNER, default_branch: REPO.default_branch },
  },
  base: {
    ref: 'main',
    sha: BASE_SHA,
    label: 'meridian-labs:main',
    repo: { full_name: OWNER, default_branch: REPO.default_branch },
  },
  merge_base_sha: MERGE_BASE_SHA,
  comments: issueComments.length,
  review_comments: threads.reduce((sum, t) => sum + t.comments.length, 0),
  commits: commits.length,
  additions,
  deletions,
  changed_files: files.length,
  created_at: daysAgo(5),
  updated_at: hoursAgo(6),
}

export const pr204: RemotePull = {
  detail,
  files,
  blobs,
  blobIndex,
  threads,
  issueComments,
  reviews: [],
  checks,
  commits,
  broker: {
    authorHumanId: 'h-marcus',
    canApprove: false,
    unresolvedThreads: 1,
    assignedReviewerHumanIds: ['h-priya'],
    compareKey: `${MERGE_BASE_SHA}...${HEAD_SHA}`,
    commitCount: commits.length,
  },
}

// ————————————————————————————————————————————————————————————————
// Seeds — a fresh snapshot synced an hour ago, plus three small files marked
// viewed by Priya at the head blob shas the snapshot carries.
// ————————————————————————————————————————————————————————————————

const seededSnapshot = buildSnapshot(pr204, hoursAgo(1), {
  syncStats: { blobsFetched: 27, blobsReused: 0, requests: 30 },
})

const viewedAt = hoursAgo(1)

export const pr204Seeds: FixtureSeeds = {
  snapshots: [seededSnapshot],
  viewed: [
    {
      humanId: 'h-priya',
      prNumber: 204,
      state: {
        'src/ingest/dedupe.ts': { viewed: true, blobSha: dedupeHead.sha, at: viewedAt },
        'src/events/schema.ts': { viewed: true, blobSha: schemaHead.sha, at: viewedAt },
        'src/events/decode.ts': { viewed: true, blobSha: decodeHead.sha, at: viewedAt },
      },
    },
  ],
}

// The counted patch totals are surfaced for any consumer that wants to assert
// file-level and detail-level sums agree without re-parsing every hunk.
export const pr204PatchTotals = files.map((f) => ({
  filename: f.filename,
  ...(f.patch ? countPatch(f.patch) : { additions: 0, deletions: 0 }),
}))
