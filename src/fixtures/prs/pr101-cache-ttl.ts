import type { CheckRun, CommitInfo, Human, PullDetail, PullFile } from '@/api/types'
import { prefixBody } from '@/lib/identity'
import type { RemotePull } from '../contract'
import { BROKER_BOT, HUMANS, REPO } from '../cast'
import { blob, fakeSha, hoursAgo, minutesAgo, nodeId, pullFile } from '../helpers'

/**
 * PR #101 — the happy path. A small, finished fix authored by a contractor
 * (so GitHub sees only the broker bot): green checks, no review activity yet,
 * cleanly mergeable. Deliberately NOT pre-synced — this PR is the first-sync
 * demonstration, so it seeds nothing beyond its remote state.
 */

function human(id: string): Human {
  const h = HUMANS.find((x) => x.id === id)
  if (!h) throw new Error(`fixture cast has no human ${id}`)
  return h
}

const alice = human('h-alice')

const MERGE_BASE_SHA = fakeSha('pr101/merge-base')
const HEAD_SHA = fakeSha('pr101/c1')
const MAIN_TIP_SHA = fakeSha('atlas/main/tip')

// ————— src/cache/invalidation.ts —————

const invalidationBaseContent = `import type { CacheStore } from './store'
import { metrics } from '../observability/metrics'

export interface SweepOptions {
  /** Base interval between invalidation sweeps, in milliseconds. */
  intervalMs: number
  /** Maximum entries examined per sweep before yielding to the event loop. */
  batchSize: number
}

export const DEFAULT_SWEEP_OPTIONS: SweepOptions = {
  intervalMs: 30_000,
  batchSize: 500,
}

export function startSweep(
  store: CacheStore,
  options: SweepOptions = DEFAULT_SWEEP_OPTIONS,
): () => void {
  let cursor = 0
  const timer = setInterval(() => {
    const now = Date.now()
    const keys = store.keys()
    const slice = keys.slice(cursor, cursor + options.batchSize)
    cursor = cursor + options.batchSize >= keys.length ? 0 : cursor + options.batchSize
    let evicted = 0
    for (const key of slice) {
      const entry = store.peek(key)
      if (entry && entry.writtenAt + entry.ttlMs <= now) {
        store.evict(key)
        evicted++
      }
    }
    metrics.gauge('cache.sweep.evicted', evicted)
  }, options.intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}`

const invalidationHeadContent = `import type { CacheStore } from './store'
import { metrics } from '../observability/metrics'

export interface SweepOptions {
  /** Base interval between invalidation sweeps, in milliseconds. */
  intervalMs: number
  /** Maximum entries examined per sweep before yielding to the event loop. */
  batchSize: number
  /** Fraction of the TTL used as the ± jitter window; 0 disables jitter. */
  jitterRatio: number
}

export const DEFAULT_SWEEP_OPTIONS: SweepOptions = {
  intervalMs: 30_000,
  batchSize: 500,
  jitterRatio: 0.1,
}

/**
 * Spreads a TTL by a deterministic per-key offset so entries written in the
 * same burst (deploy warm-up, bulk import) do not all expire in the same
 * sweep. The offset derives from the key hash, so re-writing a key keeps a
 * stable expiry and cache nodes agree without coordination.
 */
export function jitteredTtl(key: string, ttlMs: number, ratio: number): number {
  if (ratio <= 0) return ttlMs
  const spread = Math.floor(ttlMs * ratio)
  if (spread === 0) return ttlMs
  const offset = (hashKey(key) % (2 * spread + 1)) - spread
  return Math.max(1, ttlMs + offset)
}

function hashKey(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h = ((h ^ key.charCodeAt(i)) * 16777619) >>> 0
  }
  return h
}

export function startSweep(
  store: CacheStore,
  options: SweepOptions = DEFAULT_SWEEP_OPTIONS,
): () => void {
  let cursor = 0
  const timer = setInterval(() => {
    const now = Date.now()
    const keys = store.keys()
    const slice = keys.slice(cursor, cursor + options.batchSize)
    cursor = cursor + options.batchSize >= keys.length ? 0 : cursor + options.batchSize
    let evicted = 0
    for (const key of slice) {
      const entry = store.peek(key)
      if (!entry) continue
      const ttl = jitteredTtl(key, entry.ttlMs, options.jitterRatio)
      if (entry.writtenAt + ttl <= now) {
        store.evict(key)
        evicted++
      }
    }
    metrics.gauge('cache.sweep.evicted', evicted)
  }, options.intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}`

const invalidationPatch = `@@ -6,13 +6,38 @@ export interface SweepOptions {
   intervalMs: number
   /** Maximum entries examined per sweep before yielding to the event loop. */
   batchSize: number
+  /** Fraction of the TTL used as the ± jitter window; 0 disables jitter. */
+  jitterRatio: number
 }

 export const DEFAULT_SWEEP_OPTIONS: SweepOptions = {
   intervalMs: 30_000,
   batchSize: 500,
+  jitterRatio: 0.1,
 }

+/**
+ * Spreads a TTL by a deterministic per-key offset so entries written in the
+ * same burst (deploy warm-up, bulk import) do not all expire in the same
+ * sweep. The offset derives from the key hash, so re-writing a key keeps a
+ * stable expiry and cache nodes agree without coordination.
+ */
+export function jitteredTtl(key: string, ttlMs: number, ratio: number): number {
+  if (ratio <= 0) return ttlMs
+  const spread = Math.floor(ttlMs * ratio)
+  if (spread === 0) return ttlMs
+  const offset = (hashKey(key) % (2 * spread + 1)) - spread
+  return Math.max(1, ttlMs + offset)
+}
+
+function hashKey(key: string): number {
+  let h = 2166136261
+  for (let i = 0; i < key.length; i++) {
+    h = ((h ^ key.charCodeAt(i)) * 16777619) >>> 0
+  }
+  return h
+}
+
 export function startSweep(
   store: CacheStore,
   options: SweepOptions = DEFAULT_SWEEP_OPTIONS,
@@ -26,7 +51,9 @@ export function startSweep(
     let evicted = 0
     for (const key of slice) {
       const entry = store.peek(key)
-      if (entry && entry.writtenAt + entry.ttlMs <= now) {
+      if (!entry) continue
+      const ttl = jitteredTtl(key, entry.ttlMs, options.jitterRatio)
+      if (entry.writtenAt + ttl <= now) {
         store.evict(key)
         evicted++
       }`

// ————— src/cache/invalidation.test.ts —————

const testBaseContent = `import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SWEEP_OPTIONS, startSweep } from './invalidation'
import { MemoryStore } from './store'

describe('invalidation sweep', () => {
  it('evicts entries whose TTL has elapsed', () => {
    vi.useFakeTimers()
    const store = new MemoryStore()
    store.set('tenant:42', { plan: 'growth' }, 1_000)
    const stop = startSweep(store, { ...DEFAULT_SWEEP_OPTIONS, intervalMs: 100 })
    vi.advanceTimersByTime(1_500)
    expect(store.peek('tenant:42')).toBeUndefined()
    stop()
    vi.useRealTimers()
  })
})`

const testHeadContent = `import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SWEEP_OPTIONS, jitteredTtl, startSweep } from './invalidation'
import { MemoryStore } from './store'

describe('invalidation sweep', () => {
  it('evicts entries whose TTL has elapsed', () => {
    vi.useFakeTimers()
    const store = new MemoryStore()
    store.set('tenant:42', { plan: 'growth' }, 1_000)
    const stop = startSweep(store, { ...DEFAULT_SWEEP_OPTIONS, intervalMs: 100 })
    vi.advanceTimersByTime(1_500)
    expect(store.peek('tenant:42')).toBeUndefined()
    stop()
    vi.useRealTimers()
  })
})

describe('jitteredTtl', () => {
  it('is deterministic per key', () => {
    expect(jitteredTtl('tenant:42', 60_000, 0.1)).toBe(jitteredTtl('tenant:42', 60_000, 0.1))
  })

  it('stays within the ± ratio window', () => {
    for (const key of ['a', 'tenant:7', 'usage:2026-07']) {
      const ttl = jitteredTtl(key, 60_000, 0.1)
      expect(ttl).toBeGreaterThanOrEqual(54_000)
      expect(ttl).toBeLessThanOrEqual(66_000)
    }
  })

  it('returns the TTL untouched when the ratio is zero', () => {
    expect(jitteredTtl('tenant:42', 60_000, 0)).toBe(60_000)
  })
})`

const testPatch = `@@ -1,5 +1,5 @@
 import { describe, expect, it, vi } from 'vitest'
-import { DEFAULT_SWEEP_OPTIONS, startSweep } from './invalidation'
+import { DEFAULT_SWEEP_OPTIONS, jitteredTtl, startSweep } from './invalidation'
 import { MemoryStore } from './store'

 describe('invalidation sweep', () => {
@@ -14,3 +14,21 @@ describe('invalidation sweep', () => {
     vi.useRealTimers()
   })
 })
+
+describe('jitteredTtl', () => {
+  it('is deterministic per key', () => {
+    expect(jitteredTtl('tenant:42', 60_000, 0.1)).toBe(jitteredTtl('tenant:42', 60_000, 0.1))
+  })
+
+  it('stays within the ± ratio window', () => {
+    for (const key of ['a', 'tenant:7', 'usage:2026-07']) {
+      const ttl = jitteredTtl(key, 60_000, 0.1)
+      expect(ttl).toBeGreaterThanOrEqual(54_000)
+      expect(ttl).toBeLessThanOrEqual(66_000)
+    }
+  })
+
+  it('returns the TTL untouched when the ratio is zero', () => {
+    expect(jitteredTtl('tenant:42', 60_000, 0)).toBe(60_000)
+  })
+})`

// ————— blobs, files, commits, checks —————

const invalidationBase = blob(
  'src/cache/invalidation.ts',
  invalidationBaseContent,
  'pr101:base:src/cache/invalidation.ts',
)
const invalidationHead = blob(
  'src/cache/invalidation.ts',
  invalidationHeadContent,
  'pr101:head:src/cache/invalidation.ts',
)
const testBase = blob(
  'src/cache/invalidation.test.ts',
  testBaseContent,
  'pr101:base:src/cache/invalidation.test.ts',
)
const testHead = blob(
  'src/cache/invalidation.test.ts',
  testHeadContent,
  'pr101:head:src/cache/invalidation.test.ts',
)

const files: PullFile[] = [
  pullFile({
    sha: testHead.sha,
    filename: 'src/cache/invalidation.test.ts',
    status: 'modified',
    patch: testPatch,
  }),
  pullFile({
    sha: invalidationHead.sha,
    filename: 'src/cache/invalidation.ts',
    status: 'modified',
    patch: invalidationPatch,
  }),
]

const additions = files.reduce((n, f) => n + f.additions, 0)
const deletions = files.reduce((n, f) => n + f.deletions, 0)

const commits: CommitInfo[] = [
  {
    sha: HEAD_SHA,
    commit: {
      message:
        'fix: add jitter to cache TTL invalidation sweep\n\nDeploy warm-up writes the whole config cache in one burst, so every\nentry expired in the same sweep and the DB took a thundering-herd read\nspike. Expiry now carries a deterministic ±10% per-key offset.',
      author: {
        name: 'Alice Nguyen',
        email: 'alice.nguyen@acme.dev',
        date: minutesAgo(368),
      },
    },
    author: BROKER_BOT,
    parents: [{ sha: MERGE_BASE_SHA }],
  },
]

const checks: CheckRun[] = [
  {
    id: 88101001,
    name: 'ci/typecheck',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(352),
    completed_at: minutesAgo(349),
    details_url: 'https://ci.meridianlabs.io/atlas/runs/88101001',
    output: { title: 'tsc --noEmit', summary: '0 errors across 412 files', text: null },
  },
  {
    id: 88101002,
    name: 'ci/tests',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(352),
    completed_at: minutesAgo(346),
    details_url: 'https://ci.meridianlabs.io/atlas/runs/88101002',
    output: { title: 'vitest', summary: '321 passed, 0 failed, 0 skipped', text: null },
  },
]

const detail: PullDetail = {
  id: 2841101,
  node_id: nodeId('PR', 101),
  number: 101,
  state: 'open',
  draft: false,
  merged_at: null,
  title: 'fix: add jitter to cache TTL invalidation sweep',
  body: prefixBody(
    alice,
    [
      '## Why',
      '',
      'Deploy warm-up writes land the whole config cache in one burst, so every entry expires in the same sweep ~30s later and the DB takes a thundering-herd read spike (the 09:40 UTC spike on the 15th was exactly this).',
      '',
      '## What',
      '',
      '- `jitteredTtl(key, ttl, ratio)` — deterministic ±10% spread derived from the key hash, so a given key keeps a stable expiry across nodes and re-writes.',
      '- The sweep loop evicts on jittered expiry; `jitterRatio: 0` restores the exact old behavior.',
      '',
      '## Testing',
      '',
      'Unit tests cover determinism, the ± window bounds, and the zero-ratio escape hatch.',
    ].join('\n'),
  ),
  user: BROKER_BOT,
  labels: [
    { id: 9001, name: 'area/cache', color: 'c2e0c6', description: 'Cache subsystem' },
    { id: 9002, name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  ],
  requested_reviewers: [],
  head: {
    ref: 'fix/cache-ttl-jitter',
    sha: HEAD_SHA,
    label: 'meridian-labs:fix/cache-ttl-jitter',
    repo: { full_name: REPO.full_name, default_branch: REPO.default_branch },
  },
  base: {
    ref: 'main',
    sha: MAIN_TIP_SHA,
    label: 'meridian-labs:main',
    repo: { full_name: REPO.full_name, default_branch: REPO.default_branch },
  },
  created_at: hoursAgo(6),
  updated_at: minutesAgo(346),
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  merge_base_sha: MERGE_BASE_SHA,
  comments: 0,
  review_comments: 0,
  commits: commits.length,
  additions,
  deletions,
  changed_files: files.length,
}

export const pr101: RemotePull = {
  detail,
  files,
  blobs: [invalidationBase, invalidationHead, testBase, testHead],
  blobIndex: {
    'src/cache/invalidation.ts': { base: invalidationBase.sha, head: invalidationHead.sha },
    'src/cache/invalidation.test.ts': { base: testBase.sha, head: testHead.sha },
  },
  threads: [],
  issueComments: [],
  reviews: [],
  checks,
  commits,
  broker: {
    authorHumanId: 'h-alice',
    canApprove: false,
    unresolvedThreads: 0,
    assignedReviewerHumanIds: ['h-priya'],
    compareKey: `${MERGE_BASE_SHA}...${HEAD_SHA}`,
    commitCount: commits.length,
  },
}
