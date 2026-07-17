import type {
  FileBlob,
  FileViewedState,
  PullListResponse,
  RateLimitInfo,
  ReactionKey,
  ReactionRollup,
  ReconcileReport,
  ReviewComment,
  ReviewDraft,
  ReviewThread,
  Session,
  Snapshot,
  SubmitReviewInput,
  SubmitResult,
} from './types'

/**
 * The one boundary between UI and transport. `src/api/mock/` implements it
 * against fixtures; a real implementation (broker HTTP + GitHub REST/GraphQL)
 * is a sibling directory and nothing else changes.
 *
 * Contract notes that the real transport imposes and the mock must honor:
 *
 * - `listPulls` is REST with `If-None-Match`; a 304 is free against the shared
 *   rate bucket, so the list is the only genuinely live surface in the app.
 * - `syncPull` is the burst read: diff + threads + blobs in one shot, cached.
 *   Everything after sync is local — `getSnapshot`, `getBlob`,
 *   `listReviewThreads` never touch the network for a synced PR.
 * - Blobs are content-addressed by git SHA (cache forever); the diff is keyed
 *   by `merge_base...head`, never by head alone. Mutable state (threads,
 *   checks, mergeability) is refetched on every sync unconditionally.
 * - Drafts and viewed state are broker-side, keyed by the human. They must
 *   survive a page reload and a workspace rebuild; they are invisible to GitHub.
 * - Writes are cheap (one call per review regardless of comment count); reads
 *   are the shared cost.
 */
export interface RevuApi {
  /** Identity injected at startup — the app's own session, not GitHub's. */
  getSession(): Promise<Session>

  /** Live PR list. Safe to poll: 304s are free. */
  listPulls(opts?: { etag?: string }): Promise<PullListResponse>

  /** One burst: pull the PR down whole and cache it. May resolve partial. */
  syncPull(prNumber: number, opts?: { signal?: AbortSignal }): Promise<Snapshot>

  /** Cached snapshot, no network. Null if this PR was never synced. */
  getSnapshot(prNumber: number): Promise<Snapshot | null>

  /** Content-addressed blob from the snapshot store. No network for synced PRs. */
  getBlob(sha: string): Promise<FileBlob>

  /** Threads from the cached snapshot (mutable half). */
  listReviewThreads(prNumber: number): Promise<ReviewThread[]>

  /** Single-comment reply to an existing thread — an immediate write, not drafted. */
  replyToThread(
    prNumber: number,
    threadId: string,
    body: string,
  ): Promise<ReviewComment>

  /** GraphQL resolve/unresolve mutation. */
  resolveThread(
    prNumber: number,
    threadId: string,
    resolved: boolean,
  ): Promise<ReviewThread>

  addReaction(
    prNumber: number,
    commentId: number,
    reaction: ReactionKey,
  ): Promise<ReactionRollup>

  /**
   * The atomic submit: one call carrying every pending comment.
   * Returns `head_moved` (never throws for that case) so the UI can route
   * through reconcile instead of failing.
   */
  submitReview(input: SubmitReviewInput): Promise<SubmitResult>

  /**
   * After a re-sync, classify each pending comment against the fresh snapshot:
   * clean / drifted / lost. Pure read of broker + snapshot state.
   */
  reconcileDraft(prNumber: number): Promise<ReconcileReport>

  // ——— per-human state (broker-side; would be lost forever if kept in the browser) ———

  getDraft(prNumber: number): Promise<ReviewDraft | null>
  saveDraft(draft: ReviewDraft): Promise<ReviewDraft>
  discardDraft(prNumber: number): Promise<void>

  getFileViewed(prNumber: number): Promise<FileViewedState>
  setFileViewed(
    prNumber: number,
    path: string,
    viewed: boolean,
    blobSha: string | null,
  ): Promise<FileViewedState>

  /** Current shared-bucket status, for honest error copy. */
  getRateLimit(): Promise<RateLimitInfo>
}
