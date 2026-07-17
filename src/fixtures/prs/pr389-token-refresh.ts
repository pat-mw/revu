import type {
  CheckRun,
  CommitInfo,
  GhUser,
  Human,
  IssueComment,
  PendingComment,
  PullDetail,
  PullFile,
  ReviewComment,
  ReviewDraft,
  ReviewSummary,
  ReviewThread,
} from '@/api/types'
import { prefixBody } from '@/lib/identity'
import { BROKER_BOT, HUMANS, ORG_DKOZLOV, REPO } from '../cast'
import type { FixtureSeeds, RemotePull } from '../contract'
import {
  blob,
  buildSnapshot,
  daysAgo,
  emptyReactions,
  fakeSha,
  hoursAgo,
  minutesAgo,
  nodeId,
  pullFile,
} from '../helpers'

/**
 * PR 389 — "refactor(auth): centralize token refresh scheduling".
 *
 * The reconcile scenario, built back-to-front. Priya has a pending draft
 * written against head H1 (two commits in). Marcus then pushed three more
 * commits; the remote head is now H2. Between H1 and H2 the main file,
 * refresh-scheduler.ts, changed in exactly three ways that exercise every
 * anchor classification:
 *
 * - CLEAN: line 15 (`const REFRESH_MARGIN_MS = 90_000`) survives verbatim at
 *   the same line number in H2 — draft comment #1 re-anchors untouched.
 * - DRIFTED (+12): a 12-line retry/backoff constants section is inserted at
 *   H2 lines 21–32, pushing `startScheduler` and its `armTimer` body down by
 *   exactly 12 lines with their text unchanged. Draft comment #2 targets H1
 *   line 29; the same text now sits at H2 line 41 with identical context.
 * - LOST (line-deleted): the legacy `needsRefresh` shim (H1 lines 63–71) is
 *   deleted outright; draft comment #3 targets H1 line 70, whose text appears
 *   nowhere in H2.
 *
 * The seeded snapshot is the base...H1 compare synced a day ago, so the app
 * can render exactly what the draft was written against before a re-sync,
 * then reconcile against base...H2.
 */

const SHA_BASE = fakeSha('pr389-base')
const SHA_C1 = fakeSha('pr389-c1')
const SHA_H1 = fakeSha('pr389-head-v1')
const SHA_C3 = fakeSha('pr389-c3')
const SHA_C4 = fakeSha('pr389-c4')
const SHA_H2 = fakeSha('pr389-head-v2')

const marcus = HUMANS.find((h) => h.id === 'h-marcus')!

// ————————————————————————————————————————————————————————————————
// Blobs — base, H1 (old head) and H2 (current head)
// ————————————————————————————————————————————————————————————————

const SCHED_BASE = `import { fetchAccessToken } from './token-client'
import { tokenStore } from './token-store'

/**
 * Legacy refresh behavior: each caller that notices an expiring token kicks
 * off its own refresh. Concurrent callers race; last writer wins.
 */
export async function refreshIfExpiring(margin: number): Promise<void> {
  const token = tokenStore.current()
  if (!token) return
  const msLeft = token.expiresAt - Date.now()
  if (msLeft > margin) return
  const fresh = await fetchAccessToken(token.refreshToken)
  tokenStore.replace(fresh)
}

/** Callers poll this before every authenticated request. */
export function needsRefresh(margin: number): boolean {
  const token = tokenStore.current()
  if (!token) return false
  return token.expiresAt - Date.now() <= margin
}
`

const SCHED_H1 = `import { fetchAccessToken } from './token-client'
import { tokenStore } from './token-store'

/**
 * Central refresh scheduler: exactly one timer owns token refresh. Callers
 * never refresh directly — they subscribe and read the store.
 */
export interface SchedulerHandle {
  stop(): void
  /** Fires immediately if a refresh is already in flight. */
  forceRefresh(): Promise<void>
}

/** Refresh this many ms before expiry; jittered to avoid thundering herds. */
const REFRESH_MARGIN_MS = 90_000

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 5_000)
}

export function startScheduler(): SchedulerHandle {
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  function armTimer(): void {
    const token = tokenStore.current()
    if (!token) return
    const msLeft = token.expiresAt - Date.now()
    const fireIn = Math.max(0, msLeft - jitter(REFRESH_MARGIN_MS))
    timer = setTimeout(runRefresh, fireIn)
  }

  async function runRefresh(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = doRefresh()
    try {
      await inFlight
    } finally {
      inFlight = null
      armTimer()
    }
  }

  async function doRefresh(): Promise<void> {
    const token = tokenStore.current()
    if (!token) return
    const fresh = await fetchAccessToken(token.refreshToken)
    tokenStore.replace(fresh)
  }

  armTimer()
  return {
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
    },
    async forceRefresh() {
      await runRefresh()
    },
  }
}

/**
 * Legacy shim for call sites not yet migrated: reports whether the token is
 * inside the refresh margin. The scheduler owns the actual refresh.
 */
export function needsRefresh(margin: number = REFRESH_MARGIN_MS): boolean {
  const token = tokenStore.current()
  if (!token) return false
  return token.expiresAt - Date.now() <= margin
}
`

const SCHED_H2 = `import { fetchAccessToken } from './token-client'
import { tokenStore } from './token-store'

/**
 * Central refresh scheduler: exactly one timer owns token refresh. Callers
 * never refresh directly — they subscribe and read the store.
 */
export interface SchedulerHandle {
  stop(): void
  /** Fires immediately if a refresh is already in flight. */
  forceRefresh(): Promise<void>
}

/** Refresh this many ms before expiry; jittered to avoid thundering herds. */
const REFRESH_MARGIN_MS = 90_000

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 5_000)
}

// Backoff for failed refreshes: exponential with a hard ceiling. A refresh
// that keeps failing must never spin; the ceiling forces re-auth upstream.
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 60_000
const RETRY_JITTER_MS = 500
const RETRY_CEILING = 6

function backoffDelay(attempt: number): number {
  const exp = Math.min(attempt, RETRY_CEILING)
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exp) + Math.floor(Math.random() * RETRY_JITTER_MS)
}

export function startScheduler(): SchedulerHandle {
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  function armTimer(): void {
    const token = tokenStore.current()
    if (!token) return
    const msLeft = token.expiresAt - Date.now()
    const fireIn = Math.max(0, msLeft - jitter(REFRESH_MARGIN_MS))
    timer = setTimeout(runRefresh, fireIn)
  }

  let attempt = 0

  async function runRefresh(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = doRefresh()
    try {
      await inFlight
      attempt = 0
      armTimer()
    } catch {
      attempt += 1
      timer = setTimeout(runRefresh, backoffDelay(attempt))
    } finally {
      inFlight = null
    }
  }

  async function doRefresh(): Promise<void> {
    const token = tokenStore.current()
    if (!token) return
    const fresh = await fetchAccessToken(token.refreshToken)
    tokenStore.replace(fresh)
  }

  armTimer()
  return {
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
    },
    async forceRefresh() {
      await runRefresh()
    },
  }
}
`

const STORE_BASE = `export interface AccessToken {
  value: string
  refreshToken: string
  /** Epoch ms. */
  expiresAt: number
}

let current: AccessToken | null = null

export const tokenStore = {
  current(): AccessToken | null {
    return current
  },
  replace(next: AccessToken): void {
    current = next
  },
}
`

const STORE_HEAD = `export interface AccessToken {
  value: string
  refreshToken: string
  /** Epoch ms. */
  expiresAt: number
}

type Listener = (token: AccessToken | null) => void

let current: AccessToken | null = null
const listeners = new Set<Listener>()

export const tokenStore = {
  current(): AccessToken | null {
    return current
  },
  replace(next: AccessToken): void {
    current = next
    for (const listener of listeners) listener(current)
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
`

const RTEST_BASE = `import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshIfExpiring } from './refresh-scheduler'
import { tokenStore } from './token-store'

describe('refreshIfExpiring', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing when no token is present', async () => {
    await refreshIfExpiring(90_000)
    expect(tokenStore.current()).toBeNull()
  })
})
`

const RTEST_HEAD = `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startScheduler } from './refresh-scheduler'
import { tokenStore } from './token-store'

describe('startScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('arms no timer when the store is empty', () => {
    const handle = startScheduler()
    expect(vi.getTimerCount()).toBe(0)
    handle.stop()
  })

  it('clears the pending timer on stop', () => {
    tokenStore.replace({
      value: 't-1',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 600_000,
    })
    const handle = startScheduler()
    expect(vi.getTimerCount()).toBe(1)
    handle.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
`

const schedBase = blob('src/auth/refresh-scheduler.ts', SCHED_BASE, 'pr389-sched-base')
const schedH1 = blob('src/auth/refresh-scheduler.ts', SCHED_H1, 'pr389-sched-h1')
const schedH2 = blob('src/auth/refresh-scheduler.ts', SCHED_H2, 'pr389-sched-h2')
const storeBase = blob('src/auth/token-store.ts', STORE_BASE, 'pr389-store-base')
const storeHead = blob('src/auth/token-store.ts', STORE_HEAD, 'pr389-store-head')
const rtestBase = blob('src/auth/refresh-scheduler.test.ts', RTEST_BASE, 'pr389-rtest-base')
const rtestHead = blob('src/auth/refresh-scheduler.test.ts', RTEST_HEAD, 'pr389-rtest-head')

// ————————————————————————————————————————————————————————————————
// Patches. The three new commits touch only refresh-scheduler.ts, so
// token-store.ts and the test file share one patch across both compares.
// ————————————————————————————————————————————————————————————————

const PATCH_SCHED_V1 = `@@ -2,20 +2,69 @@ import { fetchAccessToken } from './token-client'
 import { tokenStore } from './token-store'

 /**
- * Legacy refresh behavior: each caller that notices an expiring token kicks
- * off its own refresh. Concurrent callers race; last writer wins.
+ * Central refresh scheduler: exactly one timer owns token refresh. Callers
+ * never refresh directly — they subscribe and read the store.
  */
-export async function refreshIfExpiring(margin: number): Promise<void> {
-  const token = tokenStore.current()
-  if (!token) return
-  const msLeft = token.expiresAt - Date.now()
-  if (msLeft > margin) return
-  const fresh = await fetchAccessToken(token.refreshToken)
-  tokenStore.replace(fresh)
+export interface SchedulerHandle {
+  stop(): void
+  /** Fires immediately if a refresh is already in flight. */
+  forceRefresh(): Promise<void>
+}
+
+/** Refresh this many ms before expiry; jittered to avoid thundering herds. */
+const REFRESH_MARGIN_MS = 90_000
+
+function jitter(ms: number): number {
+  return ms + Math.floor(Math.random() * 5_000)
+}
+
+export function startScheduler(): SchedulerHandle {
+  let timer: ReturnType<typeof setTimeout> | null = null
+  let inFlight: Promise<void> | null = null
+
+  function armTimer(): void {
+    const token = tokenStore.current()
+    if (!token) return
+    const msLeft = token.expiresAt - Date.now()
+    const fireIn = Math.max(0, msLeft - jitter(REFRESH_MARGIN_MS))
+    timer = setTimeout(runRefresh, fireIn)
+  }
+
+  async function runRefresh(): Promise<void> {
+    if (inFlight) return inFlight
+    inFlight = doRefresh()
+    try {
+      await inFlight
+    } finally {
+      inFlight = null
+      armTimer()
+    }
+  }
+
+  async function doRefresh(): Promise<void> {
+    const token = tokenStore.current()
+    if (!token) return
+    const fresh = await fetchAccessToken(token.refreshToken)
+    tokenStore.replace(fresh)
+  }
+
+  armTimer()
+  return {
+    stop() {
+      if (timer) clearTimeout(timer)
+      timer = null
+    },
+    async forceRefresh() {
+      await runRefresh()
+    },
+  }
 }

-/** Callers poll this before every authenticated request. */
-export function needsRefresh(margin: number): boolean {
+/**
+ * Legacy shim for call sites not yet migrated: reports whether the token is
+ * inside the refresh margin. The scheduler owns the actual refresh.
+ */
+export function needsRefresh(margin: number = REFRESH_MARGIN_MS): boolean {
   const token = tokenStore.current()
   if (!token) return false
   return token.expiresAt - Date.now() <= margin`

const PATCH_SCHED_V2 = `@@ -2,21 +2,78 @@ import { fetchAccessToken } from './token-client'
 import { tokenStore } from './token-store'

 /**
- * Legacy refresh behavior: each caller that notices an expiring token kicks
- * off its own refresh. Concurrent callers race; last writer wins.
+ * Central refresh scheduler: exactly one timer owns token refresh. Callers
+ * never refresh directly — they subscribe and read the store.
  */
-export async function refreshIfExpiring(margin: number): Promise<void> {
-  const token = tokenStore.current()
-  if (!token) return
-  const msLeft = token.expiresAt - Date.now()
-  if (msLeft > margin) return
-  const fresh = await fetchAccessToken(token.refreshToken)
-  tokenStore.replace(fresh)
+export interface SchedulerHandle {
+  stop(): void
+  /** Fires immediately if a refresh is already in flight. */
+  forceRefresh(): Promise<void>
 }

-/** Callers poll this before every authenticated request. */
-export function needsRefresh(margin: number): boolean {
-  const token = tokenStore.current()
-  if (!token) return false
-  return token.expiresAt - Date.now() <= margin
+/** Refresh this many ms before expiry; jittered to avoid thundering herds. */
+const REFRESH_MARGIN_MS = 90_000
+
+function jitter(ms: number): number {
+  return ms + Math.floor(Math.random() * 5_000)
+}
+
+// Backoff for failed refreshes: exponential with a hard ceiling. A refresh
+// that keeps failing must never spin; the ceiling forces re-auth upstream.
+const RETRY_BASE_MS = 2_000
+const RETRY_MAX_MS = 60_000
+const RETRY_JITTER_MS = 500
+const RETRY_CEILING = 6
+
+function backoffDelay(attempt: number): number {
+  const exp = Math.min(attempt, RETRY_CEILING)
+  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exp) + Math.floor(Math.random() * RETRY_JITTER_MS)
+}
+
+export function startScheduler(): SchedulerHandle {
+  let timer: ReturnType<typeof setTimeout> | null = null
+  let inFlight: Promise<void> | null = null
+
+  function armTimer(): void {
+    const token = tokenStore.current()
+    if (!token) return
+    const msLeft = token.expiresAt - Date.now()
+    const fireIn = Math.max(0, msLeft - jitter(REFRESH_MARGIN_MS))
+    timer = setTimeout(runRefresh, fireIn)
+  }
+
+  let attempt = 0
+
+  async function runRefresh(): Promise<void> {
+    if (inFlight) return inFlight
+    inFlight = doRefresh()
+    try {
+      await inFlight
+      attempt = 0
+      armTimer()
+    } catch {
+      attempt += 1
+      timer = setTimeout(runRefresh, backoffDelay(attempt))
+    } finally {
+      inFlight = null
+    }
+  }
+
+  async function doRefresh(): Promise<void> {
+    const token = tokenStore.current()
+    if (!token) return
+    const fresh = await fetchAccessToken(token.refreshToken)
+    tokenStore.replace(fresh)
+  }
+
+  armTimer()
+  return {
+    stop() {
+      if (timer) clearTimeout(timer)
+      timer = null
+    },
+    async forceRefresh() {
+      await runRefresh()
+    },
+  }
 }`

const PATCH_STORE = `@@ -5,7 +5,10 @@ export interface AccessToken {
   expiresAt: number
 }

+type Listener = (token: AccessToken | null) => void
+
 let current: AccessToken | null = null
+const listeners = new Set<Listener>()

 export const tokenStore = {
   current(): AccessToken | null {
@@ -13,5 +16,12 @@ export const tokenStore = {
   },
   replace(next: AccessToken): void {
     current = next
+    for (const listener of listeners) listener(current)
+  },
+  subscribe(listener: Listener): () => void {
+    listeners.add(listener)
+    return () => {
+      listeners.delete(listener)
+    }
   },
 }`

const PATCH_RTEST = `@@ -1,14 +1,32 @@
-import { afterEach, describe, expect, it, vi } from 'vitest'
-import { refreshIfExpiring } from './refresh-scheduler'
+import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
+import { startScheduler } from './refresh-scheduler'
 import { tokenStore } from './token-store'

-describe('refreshIfExpiring', () => {
+describe('startScheduler', () => {
+  beforeEach(() => {
+    vi.useFakeTimers()
+  })
+
   afterEach(() => {
+    vi.useRealTimers()
     vi.restoreAllMocks()
   })

-  it('does nothing when no token is present', async () => {
-    await refreshIfExpiring(90_000)
-    expect(tokenStore.current()).toBeNull()
+  it('arms no timer when the store is empty', () => {
+    const handle = startScheduler()
+    expect(vi.getTimerCount()).toBe(0)
+    handle.stop()
+  })
+
+  it('clears the pending timer on stop', () => {
+    tokenStore.replace({
+      value: 't-1',
+      refreshToken: 'r-1',
+      expiresAt: Date.now() + 600_000,
+    })
+    const handle = startScheduler()
+    expect(vi.getTimerCount()).toBe(1)
+    handle.stop()
+    expect(vi.getTimerCount()).toBe(0)
   })
 })`

// ————————————————————————————————————————————————————————————————
// Files for both compares (same merge base; only the head differs)
// ————————————————————————————————————————————————————————————————

const files: PullFile[] = [
  pullFile({
    sha: schedH2.sha,
    filename: 'src/auth/refresh-scheduler.ts',
    status: 'modified',
    patch: PATCH_SCHED_V2,
  }),
  pullFile({
    sha: storeHead.sha,
    filename: 'src/auth/token-store.ts',
    status: 'modified',
    patch: PATCH_STORE,
  }),
  pullFile({
    sha: rtestHead.sha,
    filename: 'src/auth/refresh-scheduler.test.ts',
    status: 'modified',
    patch: PATCH_RTEST,
  }),
]

const filesV1: PullFile[] = [
  pullFile({
    sha: schedH1.sha,
    filename: 'src/auth/refresh-scheduler.ts',
    status: 'modified',
    patch: PATCH_SCHED_V1,
  }),
  pullFile({
    sha: storeHead.sha,
    filename: 'src/auth/token-store.ts',
    status: 'modified',
    patch: PATCH_STORE,
  }),
  pullFile({
    sha: rtestHead.sha,
    filename: 'src/auth/refresh-scheduler.test.ts',
    status: 'modified',
    patch: PATCH_RTEST,
  }),
]

const blobIndex: RemotePull['blobIndex'] = {
  'src/auth/refresh-scheduler.ts': { base: schedBase.sha, head: schedH2.sha },
  'src/auth/token-store.ts': { base: storeBase.sha, head: storeHead.sha },
  'src/auth/refresh-scheduler.test.ts': { base: rtestBase.sha, head: rtestHead.sha },
}

const blobIndexV1: RemotePull['blobIndex'] = {
  'src/auth/refresh-scheduler.ts': { base: schedBase.sha, head: schedH1.sha },
  'src/auth/token-store.ts': { base: storeBase.sha, head: storeHead.sha },
  'src/auth/refresh-scheduler.test.ts': { base: rtestBase.sha, head: rtestHead.sha },
}

// ————————————————————————————————————————————————————————————————
// Threads — both live on files the last three commits did not touch, so
// their diff anchors are identical in the H1-era snapshot and the remote.
// ————————————————————————————————————————————————————————————————

/**
 * Slice of a unified diff from its governing hunk header through the given
 * RIGHT-side line — the exact fragment GitHub serves as `diff_hunk` on a
 * review comment. Throws when the line is not visible in the patch, so an
 * inconsistent fixture fails at module load instead of rendering wrong.
 */
function diffHunkTo(patch: string, line: number): string {
  let out: string[] = []
  let newLn = 0
  for (const row of patch.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (m) {
      out = [row]
      newLn = Number(m[1]) - 1
      continue
    }
    out.push(row)
    if (!row.startsWith('-')) newLn += 1
    if (!row.startsWith('-') && newLn === line) return out.join('\n')
  }
  throw new Error(`diffHunkTo: right line ${line} not present in patch`)
}

function reviewComment(args: {
  id: number
  reviewId?: number
  inReplyTo?: number
  path: string
  patch: string
  line: number
  user: GhUser
  body: string
  createdAt: string
}): ReviewComment {
  return {
    id: args.id,
    node_id: nodeId('PRRC', args.id),
    pull_request_review_id: args.reviewId ?? null,
    ...(args.inReplyTo !== undefined ? { in_reply_to_id: args.inReplyTo } : {}),
    path: args.path,
    diff_hunk: diffHunkTo(args.patch, args.line),
    commit_id: SHA_H2,
    original_commit_id: SHA_H1,
    line: args.line,
    original_line: args.line,
    start_line: null,
    original_start_line: null,
    side: 'RIGHT',
    start_side: null,
    subject_type: 'line',
    user: args.user,
    body: args.body,
    created_at: args.createdAt,
    updated_at: args.createdAt,
    reactions: emptyReactions(args.id),
    html_url: `https://github.com/meridian-labs/atlas/pull/389#discussion_r${args.id}`,
  }
}

const REVIEW_DKOZLOV = 8389001

const threadListeners: ReviewThread = {
  id: nodeId('PRRT', 38910),
  isResolved: true,
  isOutdated: false,
  path: 'src/auth/token-store.ts',
  line: 19,
  originalLine: 19,
  startLine: null,
  originalStartLine: null,
  diffSide: 'RIGHT',
  startDiffSide: null,
  subjectType: 'LINE',
  resolvedBy: { login: ORG_DKOZLOV.login },
  comments: [
    reviewComment({
      id: 3891001,
      reviewId: REVIEW_DKOZLOV,
      path: 'src/auth/token-store.ts',
      patch: PATCH_STORE,
      line: 19,
      user: ORG_DKOZLOV,
      body: 'If any listener throws, replace() throws mid-refresh and the fresh token is half-applied. Both current subscribers are ours, but this is a footgun worth flagging.',
      createdAt: daysAgo(2),
    }),
    reviewComment({
      id: 3891002,
      inReplyTo: 3891001,
      path: 'src/auth/token-store.ts',
      patch: PATCH_STORE,
      line: 19,
      user: BROKER_BOT,
      body: prefixBody(
        marcus,
        'Agreed it is a real hazard — both call sites wrap their handlers today, and queued listener dispatch is next on my list. Keeping it out of scope for the scheduler move.',
      ),
      createdAt: hoursAgo(45),
    }),
  ],
}

const threadFakeTimers: ReviewThread = {
  id: nodeId('PRRT', 38920),
  isResolved: false,
  isOutdated: false,
  path: 'src/auth/refresh-scheduler.test.ts',
  line: 25,
  originalLine: 25,
  startLine: null,
  originalStartLine: null,
  diffSide: 'RIGHT',
  startDiffSide: null,
  subjectType: 'LINE',
  resolvedBy: null,
  comments: [
    reviewComment({
      id: 3892001,
      reviewId: REVIEW_DKOZLOV,
      path: 'src/auth/refresh-scheduler.test.ts',
      patch: PATCH_RTEST,
      line: 25,
      user: ORG_DKOZLOV,
      body: 'These assertions still read the real Date.now() under fake timers — vi.setSystemTime(0) up front would make the fireIn math deterministic instead of racing the wall clock.',
      createdAt: daysAgo(2),
    }),
  ],
}

const threads: ReviewThread[] = [threadListeners, threadFakeTimers]

/** The same threads as they stood at the H1-era sync: anchored to H1. */
const threadsV1: ReviewThread[] = threads.map((t) => ({
  ...t,
  comments: t.comments.map((c) => ({ ...c, commit_id: SHA_H1 })),
}))

// ————————————————————————————————————————————————————————————————
// Timeline
// ————————————————————————————————————————————————————————————————

function brokerCommit(
  sha: string,
  message: string,
  human: Human,
  date: string,
  parent: string,
): CommitInfo {
  return {
    sha,
    commit: { message, author: { name: human.name, email: human.email, date } },
    author: null,
    parents: [{ sha: parent }],
  }
}

const commits: CommitInfo[] = [
  brokerCommit(SHA_C1, 'refactor(auth): extract token store with subscriptions', marcus, daysAgo(3), SHA_BASE),
  brokerCommit(SHA_H1, 'refactor(auth): central refresh scheduler owns the timer', marcus, hoursAgo(54), SHA_C1),
  brokerCommit(SHA_C3, 'feat(auth): retry failed refreshes with capped backoff', marcus, hoursAgo(20), SHA_H1),
  brokerCommit(SHA_C4, 'refactor(auth): drop legacy needsRefresh shim', marcus, hoursAgo(7), SHA_C3),
  brokerCommit(SHA_H2, 'chore(auth): tune retry jitter constants', marcus, hoursAgo(3), SHA_C4),
]

const commitsV1 = commits.slice(0, 2)

const reviews: ReviewSummary[] = [
  {
    id: REVIEW_DKOZLOV,
    node_id: nodeId('PRR', REVIEW_DKOZLOV),
    user: ORG_DKOZLOV,
    body: 'One owner for refresh is the right call. Two inline notes.',
    state: 'COMMENTED',
    submitted_at: daysAgo(2),
    commit_id: SHA_H1,
  },
]

const issueComments: IssueComment[] = [
  {
    id: 2038901,
    node_id: nodeId('IC', 2038901),
    user: ORG_DKOZLOV,
    body: 'Direction is right — one owner for refresh. Can someone on the workspace side do a detailed pass before I approve?',
    created_at: daysAgo(2),
    updated_at: daysAgo(2),
    reactions: emptyReactions(2038901),
  },
]

const checks: CheckRun[] = [
  {
    id: 5389101,
    name: 'typecheck',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(175),
    completed_at: minutesAgo(171),
    details_url: 'https://ci.meridian-labs.dev/atlas/typecheck/5389101',
    output: { title: 'tsc --noEmit', summary: 'No type errors across 214 files.' },
  },
  {
    id: 5389102,
    name: 'tests',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(175),
    completed_at: minutesAgo(168),
    details_url: 'https://ci.meridian-labs.dev/atlas/tests/5389102',
    output: { title: 'vitest', summary: '312 passed, 0 failed.' },
  },
]

const checksV1: CheckRun[] = [
  {
    id: 5389001,
    name: 'typecheck',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(3210),
    completed_at: minutesAgo(3206),
    details_url: 'https://ci.meridian-labs.dev/atlas/typecheck/5389001',
    output: { title: 'tsc --noEmit', summary: 'No type errors across 213 files.' },
  },
  {
    id: 5389002,
    name: 'tests',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(3210),
    completed_at: minutesAgo(3203),
    details_url: 'https://ci.meridian-labs.dev/atlas/tests/5389002',
    output: { title: 'vitest', summary: '309 passed, 0 failed.' },
  },
]

// ————————————————————————————————————————————————————————————————
// Assembly — current remote (base...H2)
// ————————————————————————————————————————————————————————————————

const additions = files.reduce((n, f) => n + f.additions, 0)
const deletions = files.reduce((n, f) => n + f.deletions, 0)

const detail: PullDetail = {
  id: 90389,
  node_id: nodeId('PR', 90389),
  number: 389,
  state: 'open',
  draft: false,
  merged_at: null,
  title: 'refactor(auth): centralize token refresh scheduling',
  body: prefixBody(
    marcus,
    'Every service module used to watch its own token expiry and race the others refreshing. This centralizes scheduling behind `startScheduler()`: one timer, one in-flight refresh, and subscribers read the store.\n\n- `tokenStore` grows `subscribe` so callers react to replacements instead of polling\n- refresh fires `REFRESH_MARGIN_MS` before expiry, jittered\n- failed refreshes back off exponentially with a hard ceiling',
  ),
  user: BROKER_BOT,
  labels: [
    { id: 6103, name: 'auth', color: '0e8a16', description: 'Authentication and token plumbing' },
  ],
  requested_reviewers: [],
  head: {
    ref: 'auth/refresh-scheduler',
    sha: SHA_H2,
    label: 'meridian-labs:auth/refresh-scheduler',
    repo: { ...REPO },
  },
  base: { ref: 'main', sha: SHA_BASE, label: 'meridian-labs:main', repo: { ...REPO } },
  created_at: daysAgo(3),
  updated_at: hoursAgo(3),
  merged: false,
  mergeable: true,
  mergeable_state: 'blocked',
  merge_base_sha: SHA_BASE,
  comments: issueComments.length,
  review_comments: threads.reduce((n, t) => n + t.comments.length, 0),
  commits: commits.length,
  additions,
  deletions,
  changed_files: files.length,
}

export const pr389: RemotePull = {
  detail,
  files,
  blobs: [schedBase, schedH2, storeBase, storeHead, rtestBase, rtestHead],
  blobIndex,
  threads,
  issueComments,
  reviews,
  checks,
  commits,
  broker: {
    authorHumanId: 'h-marcus',
    canApprove: false,
    unresolvedThreads: 1,
    assignedReviewerHumanIds: ['h-priya'],
    compareKey: `${SHA_BASE}...${SHA_H2}`,
    commitCount: commits.length,
  },
}

// ————————————————————————————————————————————————————————————————
// Seeds — the H1-era snapshot, Priya's pending draft, and the H1 blob
// ————————————————————————————————————————————————————————————————

/** The remote as it stood when Priya synced: two commits, head H1. */
const remoteV1: RemotePull = {
  detail: {
    ...detail,
    head: { ...detail.head, sha: SHA_H1 },
    updated_at: hoursAgo(45),
    commits: commitsV1.length,
    additions: filesV1.reduce((n, f) => n + f.additions, 0),
    deletions: filesV1.reduce((n, f) => n + f.deletions, 0),
  },
  files: filesV1,
  blobs: [schedBase, schedH1, storeBase, storeHead, rtestBase, rtestHead],
  blobIndex: blobIndexV1,
  threads: threadsV1,
  issueComments,
  reviews,
  checks: checksV1,
  commits: commitsV1,
  broker: {
    authorHumanId: 'h-marcus',
    canApprove: false,
    unresolvedThreads: 1,
    assignedReviewerHumanIds: ['h-priya'],
    compareKey: `${SHA_BASE}...${SHA_H1}`,
    commitCount: commitsV1.length,
  },
}

const H1_LINES = SCHED_H1.replace(/\n$/, '').split('\n')

/** Anchor context copied verbatim from the H1 blob around a 1-based line. */
function anchorAt(line: number): PendingComment['anchor'] {
  return {
    lineText: H1_LINES[line - 1],
    contextBefore: H1_LINES.slice(Math.max(0, line - 4), line - 1),
    contextAfter: H1_LINES.slice(line, line + 2),
  }
}

/**
 * Priya's pending review, written against H1. Comment targets, in order:
 * clean (H1:15 → H2:15), drifted (+12; H1:29 → H2:41), lost (H1:70 deleted).
 */
const draft: ReviewDraft = {
  humanId: 'h-priya',
  prNumber: 389,
  headSha: SHA_H1,
  compareKey: `${SHA_BASE}...${SHA_H1}`,
  body: 'First pass on the scheduler refactor.',
  event: 'COMMENT',
  comments: [
    {
      key: 'pc-389-margin',
      path: 'src/auth/refresh-scheduler.ts',
      side: 'RIGHT',
      start_side: null,
      line: 15,
      start_line: null,
      body: '90s of margin on every client means the whole fleet refreshes inside the same window after a deploy. Worth deriving this from the token TTL (say 10%) instead of a constant?',
      createdAt: daysAgo(1),
      updatedAt: hoursAgo(22),
      anchor: anchorAt(15),
    },
    {
      key: 'pc-389-firein',
      path: 'src/auth/refresh-scheduler.ts',
      side: 'RIGHT',
      start_side: null,
      line: 29,
      start_line: null,
      body: 'When msLeft is already inside the margin this arms a 0ms timer and refreshes immediately on startup. Intentional? A cold start with a nearly-expired token will refresh before the first request either way.',
      createdAt: daysAgo(1),
      updatedAt: hoursAgo(22),
      anchor: anchorAt(29),
    },
    {
      key: 'pc-389-shim',
      path: 'src/auth/refresh-scheduler.ts',
      side: 'RIGHT',
      start_side: null,
      line: 70,
      start_line: null,
      body: 'Can we delete this shim in the same PR? While it exists, callers can still poll-and-refresh on their own, which is exactly the race this refactor is killing.',
      createdAt: daysAgo(1),
      updatedAt: hoursAgo(22),
      anchor: anchorAt(70),
    },
  ],
  createdAt: daysAgo(1),
  updatedAt: hoursAgo(22),
}

export const pr389Seeds: FixtureSeeds = {
  snapshots: [
    buildSnapshot(remoteV1, daysAgo(1), {
      syncStats: { blobsFetched: 6, blobsReused: 0, requests: 13 },
    }),
  ],
  drafts: [draft],
  /**
   * H1-only content referenced by the seeded snapshot's blobIndex. The other
   * five blobs are shared with the current remote; only the old scheduler
   * head must be seeded so the pre-re-sync snapshot can render.
   */
  blobs: [schedH1],
}
