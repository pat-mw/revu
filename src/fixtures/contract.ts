import type {
  BrokerPullMeta,
  CheckRun,
  CommitInfo,
  FileBlob,
  FileViewedState,
  Human,
  GhUser,
  IssueComment,
  PullDetail,
  PullFile,
  ReviewDraft,
  ReviewSummary,
  ReviewThread,
  Snapshot,
} from '@/api/types'

/**
 * Fixture vocabulary. A fixture describes the REMOTE side — what GitHub +
 * the broker would answer right now. The mock adapter owns the cached side
 * (snapshots, drafts, viewed state) and copies remote → cache on sync.
 *
 * That split is what makes the awkward scenarios honest instead of faked:
 * a stale snapshot is a seeded cache entry whose head lags the remote; a
 * thread resolved on github.com is a remote thread whose seeded-snapshot twin
 * is still unresolved. The UI never knows fixtures exist.
 *
 * Shape fidelity rules for fixture authors:
 * - Every GitHub-shaped object matches real response fields exactly:
 *   `diff_hunk`, `original_line`, `side`, `start_side`, `in_reply_to_id`,
 *   `PRRT_` / `PRRC_` / `PR_` node-id prefixes, ISO timestamps.
 * - `PullFile.patch` is a real unified-diff fragment (`@@ -a,b +c,d @@` hunks)
 *   that is CONSISTENT with the base/head blobs for that path — context
 *   expansion reads the blobs, and drift is visible on screen.
 * - Comments written "through revu" have broker-bot `user` and a
 *   `**Name** (role)\n\n` body prefix (use `prefixBody` from lib/identity).
 *   Comments from org members carry their real GitHub user and NO prefix.
 */

export interface ScenarioFlags {
  /** Sync dies after this many blobs have transferred (network gone). */
  failSyncAfterBlobs?: number
}

export interface RemotePull {
  detail: PullDetail
  files: PullFile[]
  /** Both sides of every file (except binaries), keyed into blobIndex. */
  blobs: FileBlob[]
  /** path → blob SHA on each side; null = absent (added/deleted file). */
  blobIndex: Record<string, { base: string | null; head: string | null }>
  threads: ReviewThread[]
  issueComments: IssueComment[]
  reviews: ReviewSummary[]
  checks: CheckRun[]
  commits: CommitInfo[]
  broker: BrokerPullMeta
  scenario?: ScenarioFlags
}

export interface SeededViewed {
  humanId: string
  prNumber: number
  state: FileViewedState
}

/** What a single PR fixture module may seed alongside its remote state. */
export interface FixtureSeeds {
  snapshots?: Snapshot[]
  drafts?: ReviewDraft[]
  viewed?: SeededViewed[]
  blobs?: FileBlob[]
}

export interface FixtureDB {
  repo: { full_name: string; default_branch: string }
  humans: Human[]
  /** The human driving the workspace when the demo starts. */
  defaultHumanId: string
  orgMembers: GhUser[]
  brokerBot: GhUser
  pulls: RemotePull[]
  /** Pre-synced snapshots (some deliberately behind the remote). */
  seededSnapshots: Snapshot[]
  /** Broker-side drafts that exist before the app ever loads. */
  seededDrafts: ReviewDraft[]
  seededViewed: SeededViewed[]
  /**
   * Blobs referenced by seeded snapshots but absent from any current remote —
   * old-head content that must still render before a re-sync (the blob store
   * is content-addressed; these seed it alongside remote blobs).
   */
  seededBlobs: FileBlob[]
}
