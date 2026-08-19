import type {
  BranchRef,
  CreateLocalReviewInput,
  FileBlob,
  FileViewedState,
  HumanPreferences,
  LocalReviewSummary,
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
import { ApiError, isLocalReviewId } from '@revu/shared'
import type { CommandRunner } from './command-runner'
import type { GithubClient } from './github-client'
import type { LocalReviewSurface } from './local-surface'
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
 *
 * Every method that takes a REVIEW id serves two kinds of review: a pull
 * request, and a review of a local branch pair that has no pull request and so
 * carries a synthetic id from the reserved local band. The band is read off the
 * id before anything else happens, so the two never share a code path.
 *
 * Two id-taking surfaces are exempt, and the reasons are worth keeping.
 * `getBlob` is keyed by content, not by review: both kinds of review store
 * their bytes in the one blob table, so a SHA means the same thing on either
 * side. Preferences are keyed by the human and belong to no review at all.
 * (`listPulls` and `getRateLimit` take no review id to branch on.) Drafts DO
 * branch, but stay keyed by the session's human on both sides, so ownership
 * never depends on which band the id fell in.
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

  // ——— reviews of a local branch pair, with no pull request behind them ———

  /**
   * The branches this repository can offer as either side of a new review:
   * local branches AND remote-tracking refs, since a base is frequently tracked
   * and never checked out.
   *
   * A GIT read, never a store read. Nothing about branches is recorded in any
   * table, and the listing has to include refs no stored review has ever named
   * — so there is no row set this could be answered from, and answering it from
   * one would offer only the branches already under review.
   */
  listBranches(): Promise<BranchRef[]>

  /**
   * Record a review of `headRef` against `baseRef`, or return the review that
   * already exists for that branch pair. The refs arrive already validated and
   * fully qualified: syntax is settled at the request boundary, BEFORE any
   * value could become a git argument.
   *
   * Idempotent per branch pair, and that idempotence is a 200 carrying the
   * existing review rather than a conflict — a retried creation whose first
   * answer was lost must be safe, and a pair's identity must not depend on how
   * many times it was asked for.
   */
  createLocalReview(input: CreateLocalReviewInput): Promise<LocalReviewSummary>

  /**
   * Every local review recorded for this repository, carrying the two
   * annotations that exist only locally — `dirty` and `archivedPr`. Sync,
   * because it is a single store read.
   */
  listLocalReviews(): LocalReviewSummary[]

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

  /**
   * The operations behind reviews created from local branches. Wired when this
   * daemon serves local reviews; ABSENT otherwise, and then every id from the
   * reserved local band answers a typed `not_found` rather than being handed to
   * GitHub as if it were a pull request number — a lookup that could only fail
   * confusingly, or, far worse, succeed against an unrelated pull request.
   *
   * Like the pull list, the api holds only the operations: the store the local
   * side persists to, and the git process it drives, are opened and closed by
   * whoever assembles the surface.
   */
  localReviews?: LocalReviewSurface
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

  /**
   * The local surface to serve this review id from, or `null` when the id names
   * a real pull request and the GitHub-backed path applies.
   *
   * Every id-keyed method consults this FIRST, before it reads `deps.github` or
   * the shared write bundle, so a local id cannot reach GitHub even by way of a
   * head-guard read or a store lookup keyed on a number that means something
   * else entirely. When the id is local and no local surface is wired, this
   * throws a typed `not_found` — the same shape a missing resource always takes
   * on this surface — rather than falling through, because falling through
   * would ask GitHub about a pull request whose number was never a pull request
   * number.
   *
   * The predicate is scoped to REVIEW ids. It must never be applied to a
   * comment id: locally minted entity ids sit above the review band and would
   * satisfy it, and so would many real GitHub entity ids.
   */
  const localFor = (reviewId: number): LocalReviewSurface | null => {
    if (!isLocalReviewId(reviewId)) return null
    if (deps.localReviews === undefined) {
      throw new ApiError(
        'not_found',
        `Review #${reviewId} is in the local-review band, but this daemon does not serve local reviews.`,
      )
    }
    return deps.localReviews
  }

  /**
   * The local surface for the three operations that belong to local reviews
   * ALONE — the branch listing, creation, and the local listing. They carry no
   * review id, so there is no band to read and nothing to dispatch on: they are
   * local by construction and have no GitHub-backed twin to fall through to.
   *
   * Unwired, they answer the same typed `not_found` `listPulls` gives for the
   * broker-only live list: this instance does not serve that resource. It is
   * deliberately not `not_implemented`, which would promise the capability is
   * coming — a daemon assembled without a local surface is not going to grow
   * one mid-run.
   */
  const localSurface = (): LocalReviewSurface => {
    if (deps.localReviews === undefined) {
      throw new ApiError('not_found', 'This daemon does not serve local reviews.')
    }
    return deps.localReviews
  }

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

    // `listBranches` and `createLocalReview` are `async` so that an unwired
    // local surface surfaces as a REJECTED promise rather than a synchronous
    // throw — every caller awaits them, and a synchronous throw would escape
    // the try/catch that awaiting establishes. `listLocalReviews` is sync on
    // both sides of the seam, so its throw is synchronous too and the router
    // calls it inside its own try.
    async listBranches(): Promise<BranchRef[]> {
      return localSurface().listBranches()
    },

    async createLocalReview(input: CreateLocalReviewInput): Promise<LocalReviewSummary> {
      return localSurface().createLocalReview(input)
    },

    listLocalReviews(): LocalReviewSummary[] {
      return localSurface().listLocalReviews()
    },

    async syncPull(prNumber: number): Promise<Snapshot> {
      const local = localFor(prNumber)
      if (local !== null) return local.syncPull(prNumber)
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
      const local = localFor(prNumber)
      if (local !== null) return local.getSnapshot(prNumber)
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
      const local = localFor(prNumber)
      if (local !== null) return local.getDraft(prNumber)
      return deps.store.getDraft(humanId, prNumber)
    },

    saveDraft(draft: ReviewDraft): ReviewDraft {
      // The draft is keyed by the session's human id, never by whatever id the
      // caller put in the body — a client cannot write another human's draft.
      // Re-keying happens BEFORE the band branch, so the local and pull-request
      // sides receive an identically owned draft and neither has to re-derive
      // ownership from the body.
      const stored: ReviewDraft = { ...draft, humanId, updatedAt: now() }
      const local = localFor(stored.prNumber)
      if (local !== null) return local.saveDraft(stored)
      deps.store.putDraft(stored)
      return stored
    },

    discardDraft(prNumber: number): void {
      const local = localFor(prNumber)
      if (local !== null) {
        local.discardDraft(prNumber)
        return
      }
      deps.store.deleteDraft(humanId, prNumber)
    },

    reconcileDraft(prNumber: number): ReconcileReport {
      const local = localFor(prNumber)
      if (local !== null) return local.reconcileDraft(prNumber)
      return runReconcileDraft({ store: deps.store, humanId }, prNumber)
    },

    getFileViewed(prNumber: number): FileViewedState {
      const local = localFor(prNumber)
      if (local !== null) return local.getFileViewed(prNumber)
      return deps.store.getViewed(humanId, prNumber)
    },

    setFileViewed(
      prNumber: number,
      path: string,
      viewed: boolean,
      blobSha: string | null,
    ): FileViewedState {
      const local = localFor(prNumber)
      if (local !== null) return local.setFileViewed(prNumber, path, viewed, blobSha)
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

    // The four writes are `async` so that a local id with no local surface
    // wired surfaces as a REJECTED promise rather than a synchronous throw. The
    // declared return type is a promise, and a caller that awaits — every caller
    // does — would otherwise see the band error escape its try/catch.
    async submitReview(input: SubmitReviewInput): Promise<SubmitResult> {
      const local = localFor(input.prNumber)
      if (local !== null) return local.submitReview(input)
      return runSubmitReview(writeDeps, input)
    },

    async replyToThread(
      prNumber: number,
      threadId: string,
      body: string,
    ): Promise<ReviewComment> {
      const local = localFor(prNumber)
      if (local !== null) return local.replyToThread(prNumber, threadId, body)
      return runReplyToThread(writeDeps, prNumber, threadId, body)
    },

    async resolveThread(
      prNumber: number,
      threadId: string,
      resolved: boolean,
    ): Promise<ReviewThread> {
      const local = localFor(prNumber)
      if (local !== null) return local.resolveThread(prNumber, threadId, resolved)
      return runResolveThread(writeDeps, prNumber, threadId, resolved)
    },

    // The band branch is on the REVIEW id only. `commentId` is never classified:
    // locally minted entity ids sit above the review band and would satisfy the
    // review predicate, so the review this comment belongs to is the sole thing
    // that decides which side serves it.
    async addReaction(
      prNumber: number,
      commentId: number,
      reaction: ReactionKey,
    ): Promise<ReactionRollup> {
      const local = localFor(prNumber)
      if (local !== null) return local.addReaction(prNumber, commentId, reaction)
      return runAddReaction(writeDeps, prNumber, commentId, reaction)
    },
  }
}
