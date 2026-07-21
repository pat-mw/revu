import type { CheckRun, CommitInfo, GhUser, Human, IssueComment, PullDetail, PullFile, ReviewComment, ReviewSummary, ReviewThread } from '@revu/shared'
import { prefixBody } from '@revu/shared'
import { BROKER_BOT, HUMANS, ORG_DKOZLOV, ORG_JFERRIS, REPO } from '../cast'
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
 * PR 415 — "fix(webhooks): constant-time signature validation".
 *
 * The mutable-drift scenario: head, merge base and compareKey are IDENTICAL
 * between the seeded snapshot and the current remote — only mutable state
 * moved. Since the snapshot was synced, dkozlov replied on thread T1 and
 * resolved it on github.com; no commit landed.
 *
 * The stale snapshot still renders T1 as unresolved with two comments,
 * while the broker's poll loop already reports `unresolvedThreads: 1`
 * (remote truth: only T2 is open) — that mismatch between the inbox row
 * and the opened PR is the honest cost of an offline snapshot. A re-sync
 * refetches the mutable half unconditionally but reuses every blob: the
 * compare key is unchanged and blobs are content-addressed, so
 * `syncStats.blobsReused` equals the blob count and `blobsFetched` is zero.
 *
 * It is also the only pull request NOT aimed at the default branch: a timing
 * oracle has to reach the shipped line, so this one targets the release branch.
 * That makes it the second root of the inbox tree, which is what proves the
 * tree groups by base branch at all rather than drawing one list under `main`.
 */

const SHA_BASE = fakeSha('pr415-base')
const SHA_C1 = fakeSha('pr415-c1')
const SHA_HEAD = fakeSha('pr415-head')

const marcus = HUMANS.find((h) => h.id === 'h-marcus')!
const alice2 = HUMANS.find((h) => h.id === 'h-alice2')!

// ————————————————————————————————————————————————————————————————
// Blobs
// ————————————————————————————————————————————————————————————————

const VERIFY_BASE = `import { createHmac } from 'node:crypto'

/**
 * Verify the X-Atlas-Signature header on inbound webhooks. The header is
 * sha256=<hex hmac> computed over the raw request body.
 */
export function verifySignature(
  secret: string,
  rawBody: string,
  header: string | null,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  return header.slice('sha256='.length) === expected
}
`

const VERIFY_HEAD = `import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verify the X-Atlas-Signature header on inbound webhooks. The header is
 * sha256=<hex hmac> computed over the raw request body. Comparison is
 * constant-time: a plain === leaks how many leading bytes matched.
 */
export function verifySignature(
  secret: string,
  rawBody: string,
  header: string | null,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const provided = Buffer.from(header.slice('sha256='.length), 'hex')
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}
`

const VTEST_BASE = `import { describe, expect, it } from 'vitest'
import { verifySignature } from './verify'

const SECRET = 'whsec_test'

describe('verifySignature', () => {
  it('rejects a missing header', () => {
    expect(verifySignature(SECRET, '{}', null)).toBe(false)
  })
})
`

const VTEST_HEAD = `import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifySignature } from './verify'

const SECRET = 'whsec_test'

function sign(body: string): string {
  return \`sha256=\${createHmac('sha256', SECRET).update(body).digest('hex')}\`
}

describe('verifySignature', () => {
  it('rejects a missing header', () => {
    expect(verifySignature(SECRET, '{}', null)).toBe(false)
  })

  it('accepts a correctly signed body', () => {
    expect(verifySignature(SECRET, '{"ok":true}', sign('{"ok":true}'))).toBe(true)
  })

  it('rejects a signature for a different body', () => {
    expect(verifySignature(SECRET, '{"ok":false}', sign('{"ok":true}'))).toBe(false)
  })
})
`

const verifyBase = blob('src/webhooks/verify.ts', VERIFY_BASE, 'pr415-verify-base')
const verifyHead = blob('src/webhooks/verify.ts', VERIFY_HEAD, 'pr415-verify-head')
const vtestBase = blob('src/webhooks/verify.test.ts', VTEST_BASE, 'pr415-vtest-base')
const vtestHead = blob('src/webhooks/verify.test.ts', VTEST_HEAD, 'pr415-vtest-head')

// ————————————————————————————————————————————————————————————————
// Patches
// ————————————————————————————————————————————————————————————————

const PATCH_VERIFY = `@@ -1,8 +1,9 @@
-import { createHmac } from 'node:crypto'
+import { createHmac, timingSafeEqual } from 'node:crypto'

 /**
  * Verify the X-Atlas-Signature header on inbound webhooks. The header is
- * sha256=<hex hmac> computed over the raw request body.
+ * sha256=<hex hmac> computed over the raw request body. Comparison is
+ * constant-time: a plain === leaks how many leading bytes matched.
  */
 export function verifySignature(
   secret: string,
@@ -10,6 +11,8 @@ export function verifySignature(
   header: string | null,
 ): boolean {
   if (!header || !header.startsWith('sha256=')) return false
-  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
-  return header.slice('sha256='.length) === expected
+  const expected = createHmac('sha256', secret).update(rawBody).digest()
+  const provided = Buffer.from(header.slice('sha256='.length), 'hex')
+  if (provided.length !== expected.length) return false
+  return timingSafeEqual(provided, expected)
 }`

const PATCH_VTEST = `@@ -1,10 +1,23 @@
+import { createHmac } from 'node:crypto'
 import { describe, expect, it } from 'vitest'
 import { verifySignature } from './verify'

 const SECRET = 'whsec_test'

+function sign(body: string): string {
+  return \`sha256=\${createHmac('sha256', SECRET).update(body).digest('hex')}\`
+}
+
 describe('verifySignature', () => {
   it('rejects a missing header', () => {
     expect(verifySignature(SECRET, '{}', null)).toBe(false)
   })
+
+  it('accepts a correctly signed body', () => {
+    expect(verifySignature(SECRET, '{"ok":true}', sign('{"ok":true}'))).toBe(true)
+  })
+
+  it('rejects a signature for a different body', () => {
+    expect(verifySignature(SECRET, '{"ok":false}', sign('{"ok":true}'))).toBe(false)
+  })
 })`

const files: PullFile[] = [
  pullFile({
    sha: verifyHead.sha,
    filename: 'src/webhooks/verify.ts',
    status: 'modified',
    patch: PATCH_VERIFY,
  }),
  pullFile({
    sha: vtestHead.sha,
    filename: 'src/webhooks/verify.test.ts',
    status: 'modified',
    patch: PATCH_VTEST,
  }),
]

const blobIndex: RemotePull['blobIndex'] = {
  'src/webhooks/verify.ts': { base: verifyBase.sha, head: verifyHead.sha },
  'src/webhooks/verify.test.ts': { base: vtestBase.sha, head: vtestHead.sha },
}

// ————————————————————————————————————————————————————————————————
// Threads
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
  originalLine?: number
  originalCommitId: string
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
    commit_id: SHA_HEAD,
    original_commit_id: args.originalCommitId,
    line: args.line,
    original_line: args.originalLine ?? args.line,
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
    html_url: `https://github.com/meridian-labs/atlas/pull/415#discussion_r${args.id}`,
  }
}

const REVIEW_DKOZLOV = 8415001
const REVIEW_JFERRIS = 8415002

/**
 * T1 — resolved on the REMOTE only. The seeded snapshot below carries this
 * same thread unresolved and without dkozlov's final reply.
 */
const t1: ReviewThread = {
  id: nodeId('PRRT', 41510),
  isResolved: true,
  isOutdated: false,
  path: 'src/webhooks/verify.ts',
  line: 17,
  originalLine: 14,
  startLine: null,
  originalStartLine: null,
  diffSide: 'RIGHT',
  startDiffSide: null,
  subjectType: 'LINE',
  resolvedBy: { login: ORG_DKOZLOV.login },
  comments: [
    reviewComment({
      id: 4151001,
      reviewId: REVIEW_DKOZLOV,
      path: 'src/webhooks/verify.ts',
      patch: PATCH_VERIFY,
      line: 17,
      originalLine: 14,
      originalCommitId: SHA_C1,
      user: ORG_DKOZLOV,
      body: 'This is still a plain === on the hex strings — the exact timing oracle the PR is meant to close. timingSafeEqual over the raw digest buffers, please.',
      createdAt: hoursAgo(30),
    }),
    reviewComment({
      id: 4151002,
      inReplyTo: 4151001,
      path: 'src/webhooks/verify.ts',
      patch: PATCH_VERIFY,
      line: 17,
      originalLine: 14,
      originalCommitId: SHA_C1,
      user: BROKER_BOT,
      body: prefixBody(
        marcus,
        "Switched to timingSafeEqual over the raw digest in the latest push, with a length guard so truncated headers can't throw before the compare.",
      ),
      createdAt: hoursAgo(27),
    }),
    reviewComment({
      id: 4151003,
      inReplyTo: 4151001,
      path: 'src/webhooks/verify.ts',
      patch: PATCH_VERIFY,
      line: 17,
      originalLine: 14,
      originalCommitId: SHA_C1,
      user: ORG_DKOZLOV,
      body: 'fixed in the constant-time compare, resolving',
      createdAt: hoursAgo(5),
    }),
  ],
}

/** T2 — unresolved in both the snapshot and the remote. */
const t2: ReviewThread = {
  id: nodeId('PRRT', 41520),
  isResolved: false,
  isOutdated: false,
  path: 'src/webhooks/verify.test.ts',
  line: 17,
  originalLine: 17,
  startLine: null,
  originalStartLine: null,
  diffSide: 'RIGHT',
  startDiffSide: null,
  subjectType: 'LINE',
  resolvedBy: null,
  comments: [
    reviewComment({
      id: 4152001,
      reviewId: REVIEW_JFERRIS,
      path: 'src/webhooks/verify.test.ts',
      patch: PATCH_VTEST,
      line: 17,
      originalCommitId: SHA_HEAD,
      user: ORG_JFERRIS,
      body: 'Happy path looks good — can we also pin the legacy sha1= prefix as rejected? verify.ts treats it as a missing header rather than an invalid one, and a test would freeze that contract.',
      createdAt: hoursAgo(26),
    }),
    // Authored through the broker by a contractor whose display name is a Coder
    // username carrying a digit. The smuggled prefix must parse back to this
    // human so the reply renders as her, not the bare bot.
    reviewComment({
      id: 4152002,
      inReplyTo: 4152001,
      path: 'src/webhooks/verify.test.ts',
      patch: PATCH_VTEST,
      line: 17,
      originalCommitId: SHA_HEAD,
      user: BROKER_BOT,
      body: prefixBody(
        alice2,
        'Good call — added a case asserting an sha1= header is rejected, alongside the sha256= happy path.',
      ),
      createdAt: hoursAgo(22),
    }),
  ],
}

const threads: ReviewThread[] = [t1, t2]

/**
 * T1 as the snapshot saw it a day ago: still unresolved, final reply absent.
 * Everything else about the thread — id, anchor, first two comments — is
 * byte-identical to the remote's copy.
 */
const t1Snapshot: ReviewThread = {
  ...t1,
  isResolved: false,
  resolvedBy: null,
  comments: t1.comments.slice(0, 2),
}

const threadsSnapshot: ReviewThread[] = [t1Snapshot, t2]

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

/** Identical in snapshot and remote — resolution needed zero commits. */
const commits: CommitInfo[] = [
  brokerCommit(SHA_C1, 'fix(webhooks): validate signature header shape before comparing', marcus, hoursAgo(52), SHA_BASE),
  brokerCommit(SHA_HEAD, 'fix(webhooks): constant-time compare with length guard', marcus, hoursAgo(28), SHA_C1),
]

const reviews: ReviewSummary[] = [
  {
    id: REVIEW_DKOZLOV,
    node_id: nodeId('PRR', REVIEW_DKOZLOV),
    user: ORG_DKOZLOV,
    body: 'Flagged the compare inline.',
    state: 'COMMENTED',
    submitted_at: hoursAgo(30),
    commit_id: SHA_C1,
  },
  {
    id: REVIEW_JFERRIS,
    node_id: nodeId('PRR', REVIEW_JFERRIS),
    user: ORG_JFERRIS,
    body: 'One test-coverage note.',
    state: 'COMMENTED',
    submitted_at: hoursAgo(26),
    commit_id: SHA_HEAD,
  },
]

const issueComments: IssueComment[] = []

const checks: CheckRun[] = [
  {
    id: 5415001,
    name: 'typecheck',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(1678),
    completed_at: minutesAgo(1674),
    details_url: 'https://ci.meridian-labs.dev/atlas/typecheck/5415001',
    output: { title: 'tsc --noEmit', summary: 'No type errors across 212 files.' },
  },
  {
    id: 5415002,
    name: 'tests',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(1678),
    completed_at: minutesAgo(1671),
    details_url: 'https://ci.meridian-labs.dev/atlas/tests/5415002',
    output: { title: 'vitest', summary: '306 passed, 0 failed.' },
  },
]

// ————————————————————————————————————————————————————————————————
// Assembly — current remote
// ————————————————————————————————————————————————————————————————

const additions = files.reduce((n, f) => n + f.additions, 0)
const deletions = files.reduce((n, f) => n + f.deletions, 0)

const detail: PullDetail = {
  id: 90415,
  node_id: nodeId('PR', 90415),
  number: 415,
  state: 'open',
  draft: false,
  merged_at: null,
  title: 'fix(webhooks): constant-time signature validation',
  body: prefixBody(
    marcus,
    "verifySignature compared hex digests with ===, which leaks a byte-position timing oracle to anyone who can send webhooks. Now: `timingSafeEqual` over the raw digests, with an explicit length guard (Buffer.from(_, 'hex') silently drops a trailing odd nibble). Tests cover match and mismatch.",
  ),
  user: BROKER_BOT,
  labels: [
    { id: 6104, name: 'security', color: 'd93f0b', description: 'Security-relevant change' },
  ],
  requested_reviewers: [],
  head: {
    ref: 'webhooks/constant-time-verify',
    sha: SHA_HEAD,
    label: 'meridian-labs:webhooks/constant-time-verify',
    repo: { ...REPO },
  },
  base: {
    ref: 'release/0.41',
    sha: SHA_BASE,
    label: 'meridian-labs:release/0.41',
    repo: { ...REPO },
  },
  created_at: hoursAgo(52),
  updated_at: hoursAgo(5),
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

export const pr415: RemotePull = {
  detail,
  files,
  blobs: [verifyBase, verifyHead, vtestBase, vtestHead],
  blobIndex,
  threads,
  issueComments,
  reviews,
  checks,
  commits,
  broker: {
    authorHumanId: 'h-marcus',
    canApprove: false,
    /** Remote truth: only T2 is open — while the stale snapshot renders T1 unresolved. */
    unresolvedThreads: 1,
    assignedReviewerHumanIds: ['h-priya'],
    compareKey: `${SHA_BASE}...${SHA_HEAD}`,
    commitCount: commits.length,
  },
}

// ————————————————————————————————————————————————————————————————
// Seeds — the day-old snapshot whose only lie is mutable state
// ————————————————————————————————————————————————————————————————

/**
 * The remote as it stood at sync time. Immutable half is byte-identical to
 * the current remote (same compareKey, same files, same blobs); the mutable
 * half predates dkozlov's final reply and the resolution.
 */
const remoteAtSync: RemotePull = {
  detail: {
    ...detail,
    updated_at: hoursAgo(26),
    review_comments: threadsSnapshot.reduce((n, t) => n + t.comments.length, 0),
  },
  files,
  blobs: [verifyBase, verifyHead, vtestBase, vtestHead],
  blobIndex,
  threads: threadsSnapshot,
  issueComments,
  reviews,
  checks,
  commits,
  broker: {
    authorHumanId: 'h-marcus',
    canApprove: false,
    unresolvedThreads: 2,
    assignedReviewerHumanIds: ['h-priya'],
    compareKey: `${SHA_BASE}...${SHA_HEAD}`,
    commitCount: commits.length,
  },
}

/**
 * No seeded blobs: every blob the snapshot references is already present on
 * the current remote, so a re-sync spends zero blob fetches — the mock's
 * content-addressed store reuses all four (`blobsReused: 4`), which is the
 * whole demonstration of this fixture.
 */
export const pr415Seeds: FixtureSeeds = {
  snapshots: [
    buildSnapshot(remoteAtSync, daysAgo(1), {
      syncStats: { blobsFetched: 4, blobsReused: 0, requests: 11 },
    }),
  ],
}
