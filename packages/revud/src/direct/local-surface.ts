import type {
  BranchRef,
  CreateLocalReviewInput,
  FileViewedState,
  LocalReviewSummary,
  ReactionKey,
  ReactionRollup,
  ReconcileReport,
  ReviewComment,
  ReviewDraft,
  ReviewThread,
  Snapshot,
  SubmitResult,
  SubmitReviewInput,
} from '@revu/shared'

/**
 * The operations a locally created review supports, as one narrow interface the
 * direct API surface depends on.
 *
 * A review of a branch pair that has no pull request behind it takes a
 * synthetic id from the reserved local band, so every id-keyed method on the
 * direct surface has two implementations: the GitHub-backed one, and the one
 * here. Each method below mirrors — name for name, argument for argument, and
 * crucially SYNC-or-ASYNC for sync-or-async — the `DirectApi` method it backs,
 * so routing an id to the local side is a single branch that forwards, never a
 * shape adaptation. A method that returned a promise here while its GitHub twin
 * returned a value would force the branch to reconcile the two, and the
 * reconciliation is exactly where a difference in error or null semantics would
 * hide.
 *
 * Deliberately the OPERATIONS only. The store that backs them, the git command
 * runner they drive, and the lifecycle that opens and closes both are owned by
 * whoever assembles this — the api reads through this interface and never holds
 * the machinery, which is what lets a test drive every branch with a fake and
 * no repository on disk.
 *
 * There is deliberately no delete. Removing a local review means deciding what
 * becomes of its snapshot, its cached blobs, every human's draft and viewed
 * marks on it, and its threads — a retention policy, not a row deletion. A bare
 * row delete added here would have to be withdrawn the moment that policy is
 * written, so the operation is left off until it can be defined once.
 */
export interface LocalReviewSurface {
  /**
   * Record a new review over a base/head branch pair and return the row as
   * stored, including the minted id from the local band. Async because the refs
   * are validated against the real repository before anything is written.
   */
  createLocalReview(input: CreateLocalReviewInput): Promise<LocalReviewSummary>

  /**
   * Every local review recorded for this repository. Sync because it is a
   * single store read, and because the pull list it feeds is itself sync.
   */
  listLocalReviews(): LocalReviewSummary[]

  /**
   * The branches the repository can offer as either side of a new review —
   * local branches and remote-tracking refs both, since a base is often tracked
   * rather than checked out.
   */
  listBranches(): Promise<BranchRef[]>

  /** Recompute the diff between the pair's current tips and persist a snapshot. */
  syncPull(localId: number): Promise<Snapshot>

  /**
   * The stored snapshot, or `null` when this review has never been synced.
   *
   * Sync, and nullable rather than throwing: a review that exists but has no
   * snapshot yet is a normal state, answered as a JSON `null` at 200, never a
   * 404. A 404 there would be indistinguishable from "no such review" and would
   * push the client into re-creating a review it already has.
   */
  getSnapshot(localId: number): Snapshot | null

  /** The caller's draft on this review, or `null` when none has been started. */
  getDraft(localId: number): ReviewDraft | null

  /**
   * Persist the draft and return it as stored. The draft arrives already keyed
   * to the session's human by the caller, exactly as on the pull-request side,
   * so this never re-derives ownership from the body.
   */
  saveDraft(draft: ReviewDraft): ReviewDraft

  /** Delete the caller's draft on this review; deleting nothing is not an error. */
  discardDraft(localId: number): void

  /**
   * Classify the draft's pending comments against the current snapshot —
   * `clean` / `drifted` / `lost` — as a pure read that leaves the draft
   * untouched.
   */
  reconcileDraft(localId: number): ReconcileReport

  /** The caller's per-file viewed marks on this review. */
  getFileViewed(localId: number): FileViewedState

  /** Set one file's viewed mark and return the whole resulting state. */
  setFileViewed(
    localId: number,
    path: string,
    viewed: boolean,
    blobSha: string | null,
  ): FileViewedState

  /**
   * Submit the draft as a review. Async to mirror the GitHub-backed twin even
   * though nothing leaves the machine: a local review's submit still writes
   * several tables, and matching the twin's shape keeps the dispatch a forward.
   */
  submitReview(input: SubmitReviewInput): Promise<SubmitResult>

  /** Append a reply to an existing thread and return the new comment. */
  replyToThread(localId: number, threadId: string, body: string): Promise<ReviewComment>

  /** Set a thread's resolved flag and return the mutated thread. */
  resolveThread(localId: number, threadId: string, resolved: boolean): Promise<ReviewThread>

  /** Toggle a reaction on one comment and return that comment's current rollup. */
  addReaction(
    localId: number,
    commentId: number,
    reaction: ReactionKey,
  ): Promise<ReactionRollup>

  /**
   * Every thread on this review.
   *
   * Backs NO route. A thread listing endpoint stays unimplemented because local
   * threads ride the mutable half of the snapshot, and a second, separately
   * served read of them could disagree with the snapshot the client is already
   * rendering — two sources of truth for one set of threads. This exists for the
   * pull list's unresolved-thread count, and is sync because that list is sync.
   */
  listThreads(localId: number): ReviewThread[]
}
