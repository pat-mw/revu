import type {
  FileBlob,
  FileViewedState,
  HumanPreferences,
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
  SubmitResult,
  SubmitReviewInput,
} from '@revu/shared'
import { ApiError } from '@revu/shared'
import type { CommandRunner } from './command-runner'
import type { GithubClient } from './github-client'
import { reconcileDraft as runReconcileDraft } from './reconcile'
import type { RepoRef } from './repo'
import type { DirectStore } from './store'
import { syncPull as runSyncPull } from './sync'
import type { WriteDecorator } from './write-decorator'
import { createDirectWriteDecorator } from './write-decorator'
import {
  addReaction as runAddReaction,
  replyToThread as runReplyToThread,
  resolveThread as runResolveThread,
  submitReview as runSubmitReview,
} from './writes'

/**
 * The direct-mode read/persist surface the router dispatches to. It is the small
 * shared core the integration guide describes — sync engine, snapshot store,
 * draft store — bound to one injected `GithubClient` (whose `TokenSource` is one
 * of the two strategies that differ by deployment mode) and one durable
 * `DirectStore`.
 *
 * The write path (submitReview, replyToThread, resolveThread, addReaction) runs
 * through the second injected strategy — a `WriteDecorator` — a passthrough in
 * direct mode (no stamping, no audit log) that a later broker mode swaps for one
 * that stamps every body and appends to the write log. The GraphQL thread READ
 * lands elsewhere. This surface covers the routes direct mode answers — sync,
 * snapshot, drafts, viewed, preferences, and the writes — plus a blob read that
 * is a store lookup (the byte-transfer path is separate).
 *
 * The session is captured once and used to key per-human state (drafts, viewed,
 * preferences) by `session.human.id` — the git-config email — never by any
 * client-supplied value.
 */
export interface DirectApi {
  /**
   * Whether this api may serve BROKER-mode writes: true ONLY when it was
   * assembled with the broker `WriteDecorator` (stamping + durable audit
   * journal — the decorator itself declares the capability). The router gates
   * the broker write routes on THIS flag, never on session shape, so a broker
   * session that carries a bot identity but sits over a passthrough api stays
   * reads-only (fail closed) — an unstamped, unjournaled write as the shared
   * bot cannot be assembled. Direct and mock surfaces report false; their
   * writes are gated by mode, not by this capability.
   */
  readonly brokerWritesEnabled: boolean

  /**
   * The conditional open-pulls list, served LIVE from the broker's ~30s poll
   * cache (never a per-request GitHub call). `ifNoneMatch` is the client's
   * `If-None-Match`; when it matches the cache's broker-level ETag the result is
   * `notModified: true` with empty items (the caller replays its last-known
   * list per the frozen 304 rule), else the full list. Present only when a poll
   * loop is wired (broker mode): direct and mock surfaces have no poll loop, so
   * their implementation throws a typed `not_implemented`, and the router keeps
   * gating the route to 501 there. Throws `broker_unreachable` when the poll has
   * no live list yet — a retriable "live data unavailable", never a fabricated
   * empty list.
   */
  listPulls(ifNoneMatch: string | null): PullListResponse

  /**
   * The shared GitHub allowance, read live from GitHub rather than accumulated
   * here.
   *
   * Worth being explicit, because the instinct is to count requests locally and
   * total them across workspaces: the bucket belongs to the CREDENTIAL. Under an
   * app installation every workspace authenticates as the same installation and
   * spends from one allowance, so GitHub is already the shared counter and each
   * caller sees the same figure. Nothing needs aggregating, and a locally
   * accumulated count would be wrong the moment a second workspace synced.
   *
   * The endpoint behind this is free — reading the allowance does not spend it.
   */
  getRateLimit(): Promise<RateLimitInfo>

  /** Run the burst sync and persist; may resolve a `partial` snapshot. */
  syncPull(prNumber: number): Promise<Snapshot>
  /** The cached snapshot, or `null` when the PR was never synced (not an error). */
  getSnapshot(prNumber: number): Snapshot | null

  /**
   * A content-addressed blob from the store. Blob bytes are provisioned during
   * `syncPull` (local git first, then the API), so a synced PR's blobs are all
   * present. A SHA absent from the store throws a typed `not_found` `ApiError` —
   * NEVER a fabricated blob — matching the mock oracle: the client must re-sync,
   * not render invented bytes.
   */
  getBlob(sha: string): FileBlob

  getDraft(prNumber: number): ReviewDraft | null
  saveDraft(draft: ReviewDraft): ReviewDraft
  discardDraft(prNumber: number): void

  /**
   * Classify the draft's pending comments against the freshly-synced snapshot:
   * `clean` / `drifted` / `lost`. A PURE READ of snapshot + draft state — no
   * writes, the draft is untouched — so the client can preview where its comments
   * landed after a force-push before resubmitting. Runs the SAME shared
   * `classifyPendingComment` the reconcile dialog previews with, so the report and
   * the preview can never disagree. A missing draft or a never-synced PR is a typed
   * `not_found`, matching the mock oracle.
   */
  reconcileDraft(prNumber: number): ReconcileReport

  getFileViewed(prNumber: number): FileViewedState
  setFileViewed(
    prNumber: number,
    path: string,
    viewed: boolean,
    blobSha: string | null,
  ): FileViewedState

  getPreferences(): HumanPreferences
  setPreferences(patch: Partial<HumanPreferences>): HumanPreferences

  // ——— the write path ———

  /**
   * Submit a review: head-guard, then one `POST /pulls/{n}/reviews`. Returns
   * `head_moved`/`forbidden` as VALUES (never throws for them); a 422 surfaces as
   * `conflict`. The store draft is deleted ONLY on a confirmed success, and a
   * retry-after-timeout short-circuits to an already-created matching review
   * rather than double-posting.
   */
  submitReview(input: SubmitReviewInput): Promise<SubmitResult>

  /** Reply to a thread by posting to its first comment; returns the new comment. */
  replyToThread(prNumber: number, threadId: string, body: string): Promise<ReviewComment>

  /** Resolve/unresolve a thread via the GraphQL mutation; returns the mutated thread. */
  resolveThread(prNumber: number, threadId: string, resolved: boolean): Promise<ReviewThread>

  /**
   * Add a reaction to a review or conversation comment (the id is classified
   * against the PR's snapshot); returns the comment's current rollup.
   */
  addReaction(prNumber: number, commentId: number, reaction: ReactionKey): Promise<ReactionRollup>
}

export interface DirectApiDeps {
  session: Session
  github: GithubClient
  repo: RepoRef
  store: DirectStore
  /** Runs `git cat-file` for the local-first blob provider. Omit to skip local git. */
  runner?: CommandRunner
  /** The git clone directory the blob provider reads from; defaults to the process cwd. */
  cwd?: string
  /** Timestamp source; injectable for deterministic tests. */
  now?: () => string
  /**
   * The write strategy — stamp+log vs passthrough. Defaults to the direct-mode
   * passthrough (`createDirectWriteDecorator`), so a direct daemon never stamps
   * and keeps no audit log; a broker daemon injects the stamping decorator here.
   */
  writeDecorator?: WriteDecorator

  /**
   * The broker's live pulls-list source, served from the ~30s poll cache. Wired
   * in broker mode; ABSENT in direct and mock, where `listPulls` has no live
   * cache and answers `not_implemented`. The api only reads from it — the loop's
   * lifecycle (start/stop) is owned by broker boot, not by the api.
   */
  pullList?: PullListSource
}

/**
 * The narrow source `DirectApi.listPulls` reads: the broker poll loop's served
 * view. Kept as a one-method interface so the api depends only on the read, not
 * on the loop's timer/lifecycle.
 */
export interface PullListSource {
  listPulls(ifNoneMatch: string | null): PullListResponse
}

/** Build the direct-mode API surface over an injected client + durable store. */
export function createDirectApi(deps: DirectApiDeps): DirectApi {
  const humanId = deps.session.human.id
  const now = deps.now ?? (() => new Date().toISOString())
  const writeDecorator =
    deps.writeDecorator ?? createDirectWriteDecorator(deps.session.human)

  /** The invariant bundle every write operation shares. */
  const writeDeps = {
    github: deps.github,
    repo: deps.repo,
    store: deps.store,
    session: deps.session,
    writeDecorator,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  }

  return {
    // The capability is read off the decorator actually injected, so it can be
    // true only when the broker stamping+journaling decorator is present —
    // never by default, and never from session or env shape.
    brokerWritesEnabled: writeDecorator.brokerWritesEnabled === true,

    listPulls(ifNoneMatch: string | null): PullListResponse {
      if (deps.pullList === undefined) {
        // No poll loop wired: the live list is a broker-only capability. In
        // direct mode the router never routes GET /api/pulls here at all — it
        // falls through to the router's own `not_implemented` (501) placeholder —
        // so this throw is reached ONLY when a broker was assembled without a
        // pull loop (a misconfiguration). It is a typed `not_found` (404): the
        // resource is not being served by this instance, not a promise to serve
        // it later.
        throw new ApiError(
          'not_found',
          'A live pull list is served only in broker mode.',
        )
      }
      return deps.pullList.listPulls(ifNoneMatch)
    },

    async syncPull(prNumber: number): Promise<Snapshot> {
      return runSyncPull(
        {
          github: deps.github,
          repo: deps.repo,
          store: deps.store,
          ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
          ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        },
        prNumber,
      )
    },

    async getRateLimit(): Promise<RateLimitInfo> {
      return deps.github.getRateLimit()
    },

    getSnapshot(prNumber: number): Snapshot | null {
      return deps.store.getSnapshot(prNumber)
    },

    getBlob(sha: string): FileBlob {
      const blob = deps.store.getBlob(sha)
      if (blob === null) {
        // Never fabricate a blob: a SHA absent from the store means the byte
        // transfer never provisioned it, so the client must re-sync. This is the
        // same typed `not_found` the mock answers with.
        throw new ApiError(
          'not_found',
          `Blob ${sha} is not in the local snapshot store — re-sync this pull request to fetch it.`,
        )
      }
      return blob
    },

    getDraft(prNumber: number): ReviewDraft | null {
      return deps.store.getDraft(humanId, prNumber)
    },

    saveDraft(draft: ReviewDraft): ReviewDraft {
      // The draft is keyed by the session's human id, never by whatever id the
      // caller put in the body — a client cannot write another human's draft.
      const stored: ReviewDraft = { ...draft, humanId, updatedAt: now() }
      deps.store.putDraft(stored)
      return stored
    },

    discardDraft(prNumber: number): void {
      deps.store.deleteDraft(humanId, prNumber)
    },

    reconcileDraft(prNumber: number): ReconcileReport {
      return runReconcileDraft({ store: deps.store, humanId }, prNumber)
    },

    getFileViewed(prNumber: number): FileViewedState {
      return deps.store.getViewed(humanId, prNumber)
    },

    setFileViewed(
      prNumber: number,
      path: string,
      viewed: boolean,
      blobSha: string | null,
    ): FileViewedState {
      const state = deps.store.getViewed(humanId, prNumber)
      state[path] = { viewed, blobSha, at: now() }
      deps.store.setViewed(humanId, prNumber, state)
      return state
    },

    getPreferences(): HumanPreferences {
      return deps.store.getPreferences(humanId)
    },

    setPreferences(patch: Partial<HumanPreferences>): HumanPreferences {
      return deps.store.setPreferences(humanId, patch)
    },

    submitReview(input: SubmitReviewInput): Promise<SubmitResult> {
      return runSubmitReview(writeDeps, input)
    },

    replyToThread(prNumber: number, threadId: string, body: string): Promise<ReviewComment> {
      return runReplyToThread(writeDeps, prNumber, threadId, body)
    },

    resolveThread(
      prNumber: number,
      threadId: string,
      resolved: boolean,
    ): Promise<ReviewThread> {
      return runResolveThread(writeDeps, prNumber, threadId, resolved)
    },

    addReaction(
      prNumber: number,
      commentId: number,
      reaction: ReactionKey,
    ): Promise<ReactionRollup> {
      return runAddReaction(writeDeps, prNumber, commentId, reaction)
    },
  }
}
