import type { CheckRun, CommitInfo, Human, IssueComment, PullDetail, PullFile, ReviewComment, ReviewSummary, ReviewThread } from '@revu/shared'
import { prefixBody } from '@revu/shared'
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
 * PR 410 — "feat(storage): retention sweep for expired artifacts".
 *
 * The base-advanced scenario: between the seeded snapshot and the current
 * remote, the head did NOT move — the merge base did (MB1 → MB2, the branch
 * this work was stacked on landed in main). GitHub PR diffs are three-dot
 * compares against the merge base, so the same head SHA now yields a
 * different diff:
 *
 * - sweep.ts's patch SHRINKS: main already contains the isExpired half of
 *   the change, so only the sweep function remains PR-side.
 * - gc-config.ts APPEARS in the compare: main modified it after MB1, so
 *   MB2's tree and head's tree disagree on a file this PR never touched.
 *
 * This is exactly why immutable snapshot content is keyed by
 * `merge_base...head` and never by head SHA alone: a head-keyed cache would
 * serve the MB1-era diff as current (same head, zero new commits — every
 * head-only staleness signal stays quiet), while the compare key changes and
 * honestly names the new comparison. The broker meta below carries the
 * MB2-era compareKey with a commitCount identical to the snapshot's, which
 * is the only remote signal that the diff moved.
 */

const SHA_MB1 = fakeSha('pr410-mb1')
const SHA_MB2 = fakeSha('pr410-mb2')
const SHA_MAIN_TIP = fakeSha('pr410-main-tip')
const SHA_C1 = fakeSha('pr410-c1')
const SHA_C2 = fakeSha('pr410-c2')
const SHA_HEAD = fakeSha('pr410-head')

const alice = HUMANS.find((h) => h.id === 'h-alice')!

// ————————————————————————————————————————————————————————————————
// Blobs. sweep.ts has TWO base-side versions (MB1 and MB2); the head side
// is one blob shared by both compares. gc-config.ts exists only in the
// MB2 compare: its "base" is main's new copy, its "head" the untouched one.
// ————————————————————————————————————————————————————————————————

const SWEEP_MB1 = `import { listArtifacts } from './artifact-index'

/**
 * Storage sweeping. Only reporting exists today: expired artifacts are
 * counted and logged, never deleted.
 */
export interface SweepReport {
  scanned: number
  expired: number
}

export async function reportExpired(now: number): Promise<SweepReport> {
  const artifacts = await listArtifacts()
  let expired = 0
  for (const artifact of artifacts) {
    if (artifact.expiresAt !== null && artifact.expiresAt <= now) expired += 1
  }
  return { scanned: artifacts.length, expired }
}
`

const SWEEP_MB2 = `import { listArtifacts } from './artifact-index'
import { retentionPolicyFor } from './retention-policy'

/**
 * Storage sweeping. Only reporting exists today: expired artifacts are
 * counted and logged, never deleted.
 */
export interface SweepReport {
  scanned: number
  expired: number
}

/** An artifact is expired when policy TTL or explicit expiry has passed. */
export function isExpired(
  artifact: { expiresAt: number | null; storageClass: string; createdAt: number },
  now: number,
): boolean {
  if (artifact.expiresAt !== null) return artifact.expiresAt <= now
  const policy = retentionPolicyFor(artifact.storageClass)
  if (policy.ttlMs === null) return false
  return artifact.createdAt + policy.ttlMs <= now
}

export async function reportExpired(now: number): Promise<SweepReport> {
  const artifacts = await listArtifacts()
  let expired = 0
  for (const artifact of artifacts) {
    if (isExpired(artifact, now)) expired += 1
  }
  return { scanned: artifacts.length, expired }
}
`

const SWEEP_HEAD = `import { deleteArtifact, listArtifacts } from './artifact-index'
import { retentionPolicyFor } from './retention-policy'

/**
 * Storage sweeping. The sweep deletes expired artifacts in bounded batches;
 * reporting stays available for dry runs.
 */
export interface SweepReport {
  scanned: number
  expired: number
}

export interface SweepResult extends SweepReport {
  deleted: number
  /** Artifact ids that failed to delete; retried on the next sweep. */
  failed: string[]
}

/** An artifact is expired when policy TTL or explicit expiry has passed. */
export function isExpired(
  artifact: { expiresAt: number | null; storageClass: string; createdAt: number },
  now: number,
): boolean {
  if (artifact.expiresAt !== null) return artifact.expiresAt <= now
  const policy = retentionPolicyFor(artifact.storageClass)
  if (policy.ttlMs === null) return false
  return artifact.createdAt + policy.ttlMs <= now
}

export async function reportExpired(now: number): Promise<SweepReport> {
  const artifacts = await listArtifacts()
  let expired = 0
  for (const artifact of artifacts) {
    if (isExpired(artifact, now)) expired += 1
  }
  return { scanned: artifacts.length, expired }
}

/** Delete expired artifacts, capped at limit artifacts per run. */
export async function sweepExpiredArtifacts(
  now: number,
  limit: number,
): Promise<SweepResult> {
  const artifacts = await listArtifacts()
  const expired = artifacts.filter((artifact) => isExpired(artifact, now))
  const batch = expired.slice(0, limit)
  const failed: string[] = []
  for (const artifact of batch) {
    try {
      await deleteArtifact(artifact.id)
    } catch {
      failed.push(artifact.id)
    }
  }
  return {
    scanned: artifacts.length,
    expired: expired.length,
    deleted: batch.length - failed.length,
    failed,
  }
}
`

const POLICY_BASE = `export interface RetentionPolicy {
  /** Milliseconds an artifact may live without an explicit expiry; null = keep forever. */
  ttlMs: number | null
}

const DEFAULT_POLICY: RetentionPolicy = { ttlMs: null }

export function retentionPolicyFor(storageClass: string): RetentionPolicy {
  void storageClass
  return DEFAULT_POLICY
}
`

const POLICY_HEAD = `export interface RetentionPolicy {
  /** Milliseconds an artifact may live without an explicit expiry; null = keep forever. */
  ttlMs: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Per-storage-class retention. Classes absent here keep artifacts forever. */
const POLICIES: Record<string, RetentionPolicy> = {
  'build-cache': { ttlMs: 7 * DAY_MS },
  'preview-bundle': { ttlMs: 14 * DAY_MS },
  'log-archive': { ttlMs: 90 * DAY_MS },
}

const DEFAULT_POLICY: RetentionPolicy = { ttlMs: null }

export function retentionPolicyFor(storageClass: string): RetentionPolicy {
  return POLICIES[storageClass] ?? DEFAULT_POLICY
}
`

const STEST_HEAD = `import { describe, expect, it } from 'vitest'
import { isExpired } from './sweep'

const artifact = {
  expiresAt: null as number | null,
  storageClass: 'build-cache',
  createdAt: 0,
}

describe('isExpired', () => {
  it('honors explicit expiry over policy', () => {
    expect(isExpired({ ...artifact, expiresAt: 10 }, 11)).toBe(true)
    expect(isExpired({ ...artifact, expiresAt: 10 }, 9)).toBe(false)
  })

  it('falls back to storage-class ttl', () => {
    const eightDays = 8 * 24 * 60 * 60 * 1000
    expect(isExpired(artifact, eightDays)).toBe(true)
  })
})
`

const GC_MB2 = `/** Garbage-collection cadence shared by storage maintenance jobs. */
export const GC_CONFIG = {
  /** How often the maintenance loop wakes up. */
  intervalMs: 5 * 60 * 1000,
  /** Max artifacts any single job may delete per wake-up. */
  deleteLimit: 500,
  /** Emergency brake: set in ops overrides to halt all deletion. */
  paused: false,
}
`

const GC_HEAD = `/** Garbage-collection cadence shared by storage maintenance jobs. */
export const GC_CONFIG = {
  /** How often the maintenance loop wakes up. */
  intervalMs: 15 * 60 * 1000,
  /** Max artifacts any single job may delete per wake-up. */
  deleteLimit: 200,
}
`

const sweepMb1 = blob('src/storage/sweep.ts', SWEEP_MB1, 'pr410-sweep-mb1')
const sweepMb2 = blob('src/storage/sweep.ts', SWEEP_MB2, 'pr410-sweep-mb2')
const sweepHead = blob('src/storage/sweep.ts', SWEEP_HEAD, 'pr410-sweep-head')
const policyBase = blob('src/storage/retention-policy.ts', POLICY_BASE, 'pr410-policy-base')
const policyHead = blob('src/storage/retention-policy.ts', POLICY_HEAD, 'pr410-policy-head')
const stestHead = blob('src/storage/sweep.test.ts', STEST_HEAD, 'pr410-stest-head')
const gcMb2 = blob('src/storage/gc-config.ts', GC_MB2, 'pr410-gc-mb2')
const gcHead = blob('src/storage/gc-config.ts', GC_HEAD, 'pr410-gc-head')

// ————————————————————————————————————————————————————————————————
// Patches — one pair for sweep.ts (old large / new small), one shared for
// retention-policy.ts and the added test, and the drift-only gc-config diff.
// ————————————————————————————————————————————————————————————————

/** Unified diff for a newly added file: one hunk, every line a plus. */
function addedPatch(content: string): string {
  const lines = content.replace(/\n$/, '').split('\n')
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n')
}

/** MB1-era compare: the PR still carries both isExpired and the sweep. */
const PATCH_SWEEP_OLD = `@@ -1,19 +1,61 @@
-import { listArtifacts } from './artifact-index'
+import { deleteArtifact, listArtifacts } from './artifact-index'
+import { retentionPolicyFor } from './retention-policy'

 /**
- * Storage sweeping. Only reporting exists today: expired artifacts are
- * counted and logged, never deleted.
+ * Storage sweeping. The sweep deletes expired artifacts in bounded batches;
+ * reporting stays available for dry runs.
  */
 export interface SweepReport {
   scanned: number
   expired: number
 }

+export interface SweepResult extends SweepReport {
+  deleted: number
+  /** Artifact ids that failed to delete; retried on the next sweep. */
+  failed: string[]
+}
+
+/** An artifact is expired when policy TTL or explicit expiry has passed. */
+export function isExpired(
+  artifact: { expiresAt: number | null; storageClass: string; createdAt: number },
+  now: number,
+): boolean {
+  if (artifact.expiresAt !== null) return artifact.expiresAt <= now
+  const policy = retentionPolicyFor(artifact.storageClass)
+  if (policy.ttlMs === null) return false
+  return artifact.createdAt + policy.ttlMs <= now
+}
+
 export async function reportExpired(now: number): Promise<SweepReport> {
   const artifacts = await listArtifacts()
   let expired = 0
   for (const artifact of artifacts) {
-    if (artifact.expiresAt !== null && artifact.expiresAt <= now) expired += 1
+    if (isExpired(artifact, now)) expired += 1
   }
   return { scanned: artifacts.length, expired }
 }
+
+/** Delete expired artifacts, capped at limit artifacts per run. */
+export async function sweepExpiredArtifacts(
+  now: number,
+  limit: number,
+): Promise<SweepResult> {
+  const artifacts = await listArtifacts()
+  const expired = artifacts.filter((artifact) => isExpired(artifact, now))
+  const batch = expired.slice(0, limit)
+  const failed: string[] = []
+  for (const artifact of batch) {
+    try {
+      await deleteArtifact(artifact.id)
+    } catch {
+      failed.push(artifact.id)
+    }
+  }
+  return {
+    scanned: artifacts.length,
+    expired: expired.length,
+    deleted: batch.length - failed.length,
+    failed,
+  }
+}`

/** MB2-era compare: main caught up with isExpired; only the sweep is left. */
const PATCH_SWEEP_NEW = `@@ -1,15 +1,21 @@
-import { listArtifacts } from './artifact-index'
+import { deleteArtifact, listArtifacts } from './artifact-index'
 import { retentionPolicyFor } from './retention-policy'

 /**
- * Storage sweeping. Only reporting exists today: expired artifacts are
- * counted and logged, never deleted.
+ * Storage sweeping. The sweep deletes expired artifacts in bounded batches;
+ * reporting stays available for dry runs.
  */
 export interface SweepReport {
   scanned: number
   expired: number
 }

+export interface SweepResult extends SweepReport {
+  deleted: number
+  /** Artifact ids that failed to delete; retried on the next sweep. */
+  failed: string[]
+}
+
 /** An artifact is expired when policy TTL or explicit expiry has passed. */
 export function isExpired(
   artifact: { expiresAt: number | null; storageClass: string; createdAt: number },
@@ -29,3 +35,27 @@ export async function reportExpired(now: number): Promise<SweepReport> {
   }
   return { scanned: artifacts.length, expired }
 }
+
+/** Delete expired artifacts, capped at limit artifacts per run. */
+export async function sweepExpiredArtifacts(
+  now: number,
+  limit: number,
+): Promise<SweepResult> {
+  const artifacts = await listArtifacts()
+  const expired = artifacts.filter((artifact) => isExpired(artifact, now))
+  const batch = expired.slice(0, limit)
+  const failed: string[] = []
+  for (const artifact of batch) {
+    try {
+      await deleteArtifact(artifact.id)
+    } catch {
+      failed.push(artifact.id)
+    }
+  }
+  return {
+    scanned: artifacts.length,
+    expired: expired.length,
+    deleted: batch.length - failed.length,
+    failed,
+  }
+}`

const PATCH_POLICY = `@@ -3,9 +3,17 @@ export interface RetentionPolicy {
   ttlMs: number | null
 }

+const DAY_MS = 24 * 60 * 60 * 1000
+
+/** Per-storage-class retention. Classes absent here keep artifacts forever. */
+const POLICIES: Record<string, RetentionPolicy> = {
+  'build-cache': { ttlMs: 7 * DAY_MS },
+  'preview-bundle': { ttlMs: 14 * DAY_MS },
+  'log-archive': { ttlMs: 90 * DAY_MS },
+}
+
 const DEFAULT_POLICY: RetentionPolicy = { ttlMs: null }

 export function retentionPolicyFor(storageClass: string): RetentionPolicy {
-  void storageClass
-  return DEFAULT_POLICY
+  return POLICIES[storageClass] ?? DEFAULT_POLICY
 }`

/**
 * The drift artifact: this PR never edited gc-config.ts. Main did (after
 * MB1), so the MB2...head compare shows head "reverting" main's new values.
 * Base side = main's copy at MB2; head side = the untouched original.
 */
const PATCH_GC = `@@ -1,9 +1,7 @@
 /** Garbage-collection cadence shared by storage maintenance jobs. */
 export const GC_CONFIG = {
   /** How often the maintenance loop wakes up. */
-  intervalMs: 5 * 60 * 1000,
+  intervalMs: 15 * 60 * 1000,
   /** Max artifacts any single job may delete per wake-up. */
-  deleteLimit: 500,
-  /** Emergency brake: set in ops overrides to halt all deletion. */
-  paused: false,
+  deleteLimit: 200,
 }`

const PATCH_STEST = addedPatch(STEST_HEAD)

const files: PullFile[] = [
  pullFile({
    sha: sweepHead.sha,
    filename: 'src/storage/sweep.ts',
    status: 'modified',
    patch: PATCH_SWEEP_NEW,
  }),
  pullFile({
    sha: policyHead.sha,
    filename: 'src/storage/retention-policy.ts',
    status: 'modified',
    patch: PATCH_POLICY,
  }),
  pullFile({
    sha: stestHead.sha,
    filename: 'src/storage/sweep.test.ts',
    status: 'added',
    patch: PATCH_STEST,
  }),
  pullFile({
    sha: gcHead.sha,
    filename: 'src/storage/gc-config.ts',
    status: 'modified',
    patch: PATCH_GC,
  }),
]

/** MB1-era files: larger sweep patch, no gc-config.ts. */
const filesV1: PullFile[] = [
  pullFile({
    sha: sweepHead.sha,
    filename: 'src/storage/sweep.ts',
    status: 'modified',
    patch: PATCH_SWEEP_OLD,
  }),
  pullFile({
    sha: policyHead.sha,
    filename: 'src/storage/retention-policy.ts',
    status: 'modified',
    patch: PATCH_POLICY,
  }),
  pullFile({
    sha: stestHead.sha,
    filename: 'src/storage/sweep.test.ts',
    status: 'added',
    patch: PATCH_STEST,
  }),
]

const blobIndex: RemotePull['blobIndex'] = {
  'src/storage/sweep.ts': { base: sweepMb2.sha, head: sweepHead.sha },
  'src/storage/retention-policy.ts': { base: policyBase.sha, head: policyHead.sha },
  'src/storage/sweep.test.ts': { base: null, head: stestHead.sha },
  'src/storage/gc-config.ts': { base: gcMb2.sha, head: gcHead.sha },
}

const blobIndexV1: RemotePull['blobIndex'] = {
  'src/storage/sweep.ts': { base: sweepMb1.sha, head: sweepHead.sha },
  'src/storage/retention-policy.ts': { base: policyBase.sha, head: policyHead.sha },
  'src/storage/sweep.test.ts': { base: null, head: stestHead.sha },
}

// ————————————————————————————————————————————————————————————————
// Thread + timeline. The review arrived AFTER the old sync, so the seeded
// snapshot legitimately has no threads at all.
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

const REVIEW_DKOZLOV = 8410001

const orderingComment: ReviewComment = {
  id: 4101001,
  node_id: nodeId('PRRC', 4101001),
  pull_request_review_id: REVIEW_DKOZLOV,
  path: 'src/storage/sweep.ts',
  diff_hunk: diffHunkTo(PATCH_SWEEP_NEW, 46),
  commit_id: SHA_HEAD,
  original_commit_id: SHA_HEAD,
  line: 46,
  original_line: 46,
  start_line: null,
  original_start_line: null,
  side: 'RIGHT',
  start_side: null,
  subject_type: 'line',
  user: ORG_DKOZLOV,
  body: 'expired keeps whatever order listArtifacts returns, which is not guaranteed oldest-first — under sustained pressure the same recent artifacts can win every batch while old debt starves. Sort by createdAt before slicing?',
  created_at: daysAgo(1),
  updated_at: daysAgo(1),
  reactions: emptyReactions(4101001),
  html_url: 'https://github.com/meridian-labs/atlas/pull/410#discussion_r4101001',
}

const threads: ReviewThread[] = [
  {
    id: nodeId('PRRT', 41010),
    isResolved: false,
    isOutdated: false,
    path: 'src/storage/sweep.ts',
    line: 46,
    originalLine: 46,
    startLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    startDiffSide: null,
    subjectType: 'LINE',
    resolvedBy: null,
    comments: [orderingComment],
  },
]

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

/** Identical in snapshot and remote — no new commits is the whole point. */
const commits: CommitInfo[] = [
  brokerCommit(SHA_C1, 'feat(storage): retention policy table for storage classes', alice, daysAgo(4), SHA_MB1),
  brokerCommit(SHA_C2, 'feat(storage): expiry check with policy fallback', alice, hoursAgo(80), SHA_C1),
  brokerCommit(SHA_HEAD, 'feat(storage): bounded sweep with failure retry', alice, hoursAgo(74), SHA_C2),
]

const reviews: ReviewSummary[] = [
  {
    id: REVIEW_DKOZLOV,
    node_id: nodeId('PRR', REVIEW_DKOZLOV),
    user: ORG_DKOZLOV,
    body: 'Sweep shape is good — one ordering question inline.',
    state: 'COMMENTED',
    submitted_at: daysAgo(1),
    commit_id: SHA_HEAD,
  },
]

const issueComments: IssueComment[] = []

/** Same head in both eras ⇒ the same check runs are honest in both. */
const checks: CheckRun[] = [
  {
    id: 5410001,
    name: 'typecheck',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(4440),
    completed_at: minutesAgo(4436),
    details_url: 'https://ci.meridian-labs.dev/atlas/typecheck/5410001',
    output: { title: 'tsc --noEmit', summary: 'No type errors across 212 files.' },
  },
  {
    id: 5410002,
    name: 'tests',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(4440),
    completed_at: minutesAgo(4433),
    details_url: 'https://ci.meridian-labs.dev/atlas/tests/5410002',
    output: { title: 'vitest', summary: '304 passed, 0 failed.' },
  },
]

// ————————————————————————————————————————————————————————————————
// Assembly — current remote (MB2...head)
// ————————————————————————————————————————————————————————————————

const additions = files.reduce((n, f) => n + f.additions, 0)
const deletions = files.reduce((n, f) => n + f.deletions, 0)

const detail: PullDetail = {
  id: 90410,
  node_id: nodeId('PR', 90410),
  number: 410,
  state: 'open',
  draft: false,
  merged_at: null,
  title: 'feat(storage): retention sweep for expired artifacts',
  body: prefixBody(
    alice,
    'Adds `sweepExpiredArtifacts`: policy-driven expiry (explicit `expiresAt` wins, storage-class TTL as fallback), bounded batches per run, failed deletes retried on the next sweep. Dry-run reporting stays as-is.\n\nStacked on the retention-policy groundwork; the sweep is wired to the maintenance loop in a follow-up.',
  ),
  user: BROKER_BOT,
  labels: [
    { id: 6105, name: 'storage', color: '5319e7', description: 'Artifact storage and lifecycle' },
  ],
  requested_reviewers: [],
  head: {
    ref: 'storage/retention-sweep',
    sha: SHA_HEAD,
    label: 'meridian-labs:storage/retention-sweep',
    repo: { ...REPO },
  },
  base: { ref: 'main', sha: SHA_MAIN_TIP, label: 'meridian-labs:main', repo: { ...REPO } },
  created_at: daysAgo(4),
  updated_at: daysAgo(1),
  merged: false,
  mergeable: true,
  mergeable_state: 'blocked',
  merge_base_sha: SHA_MB2,
  comments: issueComments.length,
  review_comments: threads.reduce((n, t) => n + t.comments.length, 0),
  commits: commits.length,
  additions,
  deletions,
  changed_files: files.length,
}

export const pr410: RemotePull = {
  detail,
  files,
  blobs: [sweepMb2, sweepHead, policyBase, policyHead, stestHead, gcMb2, gcHead],
  blobIndex,
  threads,
  issueComments,
  reviews,
  checks,
  commits,
  broker: {
    authorHumanId: 'h-alice',
    canApprove: false,
    unresolvedThreads: 1,
    assignedReviewerHumanIds: ['h-priya'],
    compareKey: `${SHA_MB2}...${SHA_HEAD}`,
    commitCount: commits.length,
  },
}

// ————————————————————————————————————————————————————————————————
// Seeds — the MB1-era snapshot and the MB1-only base blob
// ————————————————————————————————————————————————————————————————

/**
 * The remote as it stood two days ago: same head, same commits, merge base
 * still MB1. The review and its thread arrived later, so the mutable half
 * is honestly empty of them.
 */
const remoteV1: RemotePull = {
  detail: {
    ...detail,
    base: { ...detail.base, sha: SHA_MB1 },
    merge_base_sha: SHA_MB1,
    updated_at: hoursAgo(74),
    comments: 0,
    review_comments: 0,
    additions: filesV1.reduce((n, f) => n + f.additions, 0),
    deletions: filesV1.reduce((n, f) => n + f.deletions, 0),
    changed_files: filesV1.length,
  },
  files: filesV1,
  blobs: [sweepMb1, sweepHead, policyBase, policyHead, stestHead],
  blobIndex: blobIndexV1,
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
    compareKey: `${SHA_MB1}...${SHA_HEAD}`,
    commitCount: commits.length,
  },
}

export const pr410Seeds: FixtureSeeds = {
  snapshots: [
    buildSnapshot(remoteV1, daysAgo(2), {
      syncStats: { blobsFetched: 5, blobsReused: 0, requests: 12 },
    }),
  ],
  /**
   * MB1-era base content referenced by the seeded snapshot's blobIndex; the
   * other four blobs it needs are shared with the current remote.
   */
  blobs: [sweepMb1],
}
