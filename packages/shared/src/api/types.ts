/**
 * Shared type layer for revu.
 *
 * Two vocabularies live here, deliberately separated:
 *
 * 1. GitHub-shaped types (`Gh*`, `PullSummary`, `ReviewComment`, …) — field names
 *    and shapes match real GitHub REST/GraphQL responses exactly, so the mock
 *    adapter and an eventual real adapter serialize identically. Do not add
 *    convenience fields to these.
 *
 * 2. Broker-shaped types (`Session`, `Snapshot`, `ReviewDraft`, `BrokerPullMeta`, …)
 *    — state that cannot live on GitHub because every API call authenticates as
 *    the same GitHub App. These are keyed by the human (Coder identity), not by
 *    any GitHub login.
 */

// ————————————————————————————————————————————————————————————————
// GitHub-shaped primitives
// ————————————————————————————————————————————————————————————————

export interface GhUser {
  login: string
  id: number
  node_id: string
  avatar_url: string
  html_url: string
  type: 'User' | 'Bot' | 'Organization'
}

export interface GhLabel {
  id: number
  name: string
  color: string
  description: string | null
}

export type ReactionKey =
  | '+1'
  | '-1'
  | 'laugh'
  | 'hooray'
  | 'confused'
  | 'heart'
  | 'rocket'
  | 'eyes'

export interface ReactionRollup {
  url: string
  total_count: number
  '+1': number
  '-1': number
  laugh: number
  hooray: number
  confused: number
  heart: number
  rocket: number
  eyes: number
}

export interface GhRef {
  ref: string
  sha: string
  label: string
  repo: { full_name: string; default_branch: string }
}

/** Shape of an item from `GET /repos/{owner}/{repo}/pulls` (list — no diff counts). */
export interface PullSummary {
  id: number
  node_id: string
  number: number
  state: 'open' | 'closed'
  draft: boolean
  merged_at: string | null
  title: string
  body: string | null
  user: GhUser
  labels: GhLabel[]
  requested_reviewers: GhUser[]
  head: GhRef
  base: GhRef
  created_at: string
  updated_at: string
}

/** Shape of `GET /repos/{owner}/{repo}/pulls/{n}` (detail — adds counts + mergeability). */
export interface PullDetail extends PullSummary {
  merged: boolean
  mergeable: boolean | null
  mergeable_state: 'clean' | 'dirty' | 'unstable' | 'blocked' | 'unknown'
  merge_base_sha: string
  comments: number
  review_comments: number
  commits: number
  additions: number
  deletions: number
  changed_files: number
}

/** Shape of an item from `GET /repos/{owner}/{repo}/pulls/{n}/files`. */
export interface PullFile {
  sha: string
  filename: string
  previous_filename?: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
  additions: number
  deletions: number
  changes: number
  /** Unified diff hunks. Absent for binary files and files GitHub deems too large. */
  patch?: string
}

/**
 * Shape of a review comment (`GET /repos/{owner}/{repo}/pulls/{n}/comments`).
 * `user.login` is always the broker bot for comments written through revu;
 * the human author is smuggled in the body prefix (see lib/identity.ts).
 */
export interface ReviewComment {
  id: number
  node_id: string
  pull_request_review_id: number | null
  in_reply_to_id?: number
  path: string
  diff_hunk: string
  commit_id: string
  original_commit_id: string
  line: number | null
  original_line: number | null
  start_line: number | null
  original_start_line: number | null
  side: 'LEFT' | 'RIGHT'
  start_side: 'LEFT' | 'RIGHT' | null
  subject_type: 'line' | 'file'
  user: GhUser
  body: string
  created_at: string
  updated_at: string
  reactions: ReactionRollup
  html_url: string
}

/**
 * Review thread, GraphQL vocabulary (`reviewThreads` connection) — thread
 * grouping, isResolved and isOutdated exist nowhere in REST. The broker
 * normalizes nested comment nodes to the REST `ReviewComment` shape so the
 * client has one comment vocabulary.
 */
export interface ReviewThread {
  /** GraphQL node id, `PRRT_…` */
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  /** Line in the current diff; null when the thread is outdated. */
  line: number | null
  originalLine: number | null
  startLine: number | null
  originalStartLine: number | null
  diffSide: 'LEFT' | 'RIGHT'
  startDiffSide: 'LEFT' | 'RIGHT' | null
  subjectType: 'LINE' | 'FILE'
  resolvedBy: { login: string } | null
  comments: ReviewComment[]
}

/** Issue-level (Conversation tab) comment, REST shape. */
export interface IssueComment {
  id: number
  node_id: string
  user: GhUser
  body: string
  created_at: string
  updated_at: string
  reactions: ReactionRollup
}

/** A submitted review (timeline entry), REST shape. */
export interface ReviewSummary {
  id: number
  node_id: string
  user: GhUser
  body: string
  state: 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED' | 'PENDING'
  submitted_at: string
  commit_id: string
}

export interface CommitInfo {
  sha: string
  commit: {
    message: string
    author: { name: string; email: string; date: string }
  }
  author: GhUser | null
  parents: { sha: string }[]
}

export interface CheckRun {
  id: number
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'timed_out'
    | 'skipped'
    | null
  started_at: string
  completed_at: string | null
  details_url: string
  output: { title: string | null; summary: string | null; text?: string | null }
}

export interface RateLimitInfo {
  limit: number
  remaining: number
  used: number
  /** ISO timestamp when the shared bucket resets. */
  reset: string
}

// ————————————————————————————————————————————————————————————————
// Broker-shaped: identity
// ————————————————————————————————————————————————————————————————

/** A human behind the shared bot identity, keyed by Coder workspace identity. */
export interface Human {
  id: string
  name: string
  role: 'contractor' | 'lead'
  email: string
}

/** Injected at app startup. There is no `viewer` — GitHub doesn't know who you are. */
export interface Session {
  human: Human
  brokerLogin: string
  workspace: string
  /**
   * The viewer's own GitHub login, present only when the client talks to GitHub
   * directly rather than through the broker. In broker mode every write posts as
   * the shared bot, so own-comment detection reads the broker's write log
   * (`SnapshotMutable.commentAuthors`) instead; in direct mode there is no write
   * log, so "yours" is `comment.user.login === viewerLogin`. Absent under the
   * broker, where it would be meaningless.
   */
  viewerLogin?: string
}

/** Broker-side annotations that ride alongside a pure GitHub list item. */
export interface BrokerPullMeta {
  /** Which human drove the App when the PR was opened; null if a real org member opened it. */
  authorHumanId: string | null
  /** False when the App authored the PR (GitHub refuses self-review). */
  canApprove: boolean
  /** Unresolved review thread count, from the broker's poll loop. */
  unresolvedThreads: number
  /** Humans the broker has assigned as reviewers (GitHub only sees the bot). */
  assignedReviewerHumanIds: string[]
  /**
   * Current `merge_base...head` compare key from the broker's poll loop.
   * Lets the client detect a base-branch advance (diff changed, head didn't)
   * without spending a sync.
   */
  compareKey: string
  /** Total commits on the PR right now — snapshot delta gives "N new commits". */
  commitCount: number
}

export interface PullListItem {
  pull: PullSummary
  broker: BrokerPullMeta
}

export interface PullListResponse {
  items: PullListItem[]
  /** ETag of the underlying REST list call — a 304 costs nothing against the shared bucket. */
  etag: string
  notModified: boolean
  rateLimit: RateLimitInfo
}

// ————————————————————————————————————————————————————————————————
// Broker-shaped: the snapshot (two halves, cached differently)
// ————————————————————————————————————————————————————————————————

export interface FileBlob {
  /** Git blob SHA — the content address. Identical SHA ⇒ identical bytes, cache forever. */
  sha: string
  path: string
  content: string
  size: number
  binary: boolean
}

/**
 * Immutable half. Content-addressed by `merge_base…head` — NOT by head alone.
 * GitHub PR diffs are three-dot compares: the diff changes when the base branch
 * advances even though head didn't. Never invalidated, no TTL.
 */
export interface SnapshotImmutable {
  /** `${merge_base_sha}...${head_sha}` — the cache key for this comparison. */
  compareKey: string
  mergeBaseSha: string
  headSha: string
  files: PullFile[]
  /** path → blob SHAs on each side (null = file absent on that side). */
  blobIndex: Record<string, { base: string | null; head: string | null }>
  commits: CommitInfo[]
}

/**
 * Mutable half. None of this is a function of head SHA — a thread can be
 * resolved on github.com with zero commits landing. Refetched on every sync,
 * unconditionally.
 */
export interface SnapshotMutable {
  fetchedAt: string
  pull: PullDetail
  threads: ReviewThread[]
  issueComments: IssueComment[]
  reviews: ReviewSummary[]
  checks: CheckRun[]
  /**
   * The broker's write log, carried into the snapshot: comment id → the id of
   * the human who authored it (`Human.id`, the stable key that survives a Coder
   * username rename). Every comment written through the broker posts as the same
   * bot with the author's display name smuggled into the body, so this map is
   * the only ground truth for "who wrote this" — a rename or a reused username
   * leaves the map correct while the smuggled name goes stale.
   *
   * Optional and broker-only: it covers the comments the broker authored, and is
   * absent under a direct GitHub connection (no write log exists) and for any
   * comment the broker did not write. Own-comment detection consults it first
   * and falls back to matching the smuggled name when a comment is not listed.
   *
   * Values are human ids, used only for detection — never rendered into a
   * comment body, which would leak an audit identity onto github.com.
   */
  commentAuthors?: Record<number, string>
}

export interface Snapshot {
  prNumber: number
  syncedAt: string
  /** Present when a sync died partway (network gone). Names what's missing. */
  partial: { missingBlobShas: string[]; reason: string } | null
  /**
   * What the last sync actually cost. `blobsReused` counts content-addressed
   * cache hits — a re-sync after upstream-only mutable changes reuses every blob.
   */
  syncStats: { blobsFetched: number; blobsReused: number; requests: number } | null
  immutable: SnapshotImmutable
  mutable: SnapshotMutable
}

/** What the live list knows that the snapshot might not — staleness, computed client-side. */
export interface StalenessInfo {
  stale: boolean
  newCommits: number
  /** True when head is unchanged but the base advanced — the diff still changed. */
  baseMoved: boolean
  snapshotHeadSha: string
  currentHeadSha: string
  syncedAt: string
}

// ————————————————————————————————————————————————————————————————
// Broker-shaped: the draft (invisible to GitHub until one atomic submit)
// ————————————————————————————————————————————————————————————————

export interface PendingComment {
  /** Local key, stable across edits — never sent to GitHub. */
  key: string
  path: string
  side: 'LEFT' | 'RIGHT'
  start_side: 'LEFT' | 'RIGHT' | null
  /** Anchors in the diff the draft was written against (draft.headSha). */
  line: number
  start_line: number | null
  body: string
  createdAt: string
  updatedAt: string
  /** Captured at write time so reconcile can re-anchor after head moves. */
  anchor: {
    lineText: string
    contextBefore: string[]
    contextAfter: string[]
  }
}

export interface ReviewDraft {
  humanId: string
  prNumber: number
  /** Head SHA the draft was written against. Submit checks this. */
  headSha: string
  compareKey: string
  body: string
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
  comments: PendingComment[]
  createdAt: string
  updatedAt: string
}

/** Per-human, per-PR viewed state; `blobSha` records which version was viewed. */
export type FileViewedState = Record<
  string,
  { viewed: boolean; blobSha: string | null; at: string }
>

// ————————————————————————————————————————————————————————————————
// Submit & reconcile — the most important error path in the app
// ————————————————————————————————————————————————————————————————

export interface SubmitReviewInput {
  prNumber: number
  /** Guard: the head SHA this review believes it targets. */
  expectedHeadSha: string
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
  body: string
  comments: PendingComment[]
}

export type SubmitResult =
  | { status: 'ok'; review: ReviewSummary }
  | { status: 'head_moved'; currentHeadSha: string; newCommits: number }
  | { status: 'forbidden'; reason: string }

export type AnchorResult =
  | { kind: 'clean'; comment: PendingComment }
  | {
      kind: 'drifted'
      comment: PendingComment
      newLine: number
      newStartLine: number | null
      delta: number
    }
  | {
      kind: 'lost'
      comment: PendingComment
      reason: 'line-deleted' | 'file-deleted' | 'file-renamed'
    }

export interface ReconcileReport {
  prNumber: number
  draftHeadSha: string
  currentHeadSha: string
  newCommits: CommitInfo[]
  results: AnchorResult[]
}

// ————————————————————————————————————————————————————————————————
// Errors the UI is expected to name honestly
// ————————————————————————————————————————————————————————————————

export type ApiErrorCode =
  | 'network'
  | 'rate_limited'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'broker_unreachable'

export class ApiError extends Error {
  code: ApiErrorCode
  /** For rate_limited: ISO timestamp when the bucket resets. */
  resetAt?: string
  constructor(code: ApiErrorCode, message: string, resetAt?: string) {
    super(message)
    this.code = code
    this.resetAt = resetAt
  }
}
