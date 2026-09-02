import type {
  BranchRef,
  CreateLocalReviewInput,
  FileBlob,
  FileViewedState,
  GhRef,
  HumanPreferences,
  LocalReviewSummary,
  PullListItem,
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
import { ApiError, draftHoldsText, isLocalReviewId } from '@revu/shared'
import type { CommandRunner } from './command-runner'
import type { GithubClient } from './github-client'
import type { SupersedingPullSource } from './local-archive'
import { createLocalArchiveDetector } from './local-archive'
import type { LocalReviewSurface } from './local-surface'
import { shortRefName, synthesizeLocalUser } from './local-sync'
import { reconcileDraft as runReconcileDraft } from './reconcile'
import {
  createSyncGate,
  dropPinnedRefs,
  pruneBlobs,
  pruneImmutables,
  withSyncInFlight,
  type BlobRetentionPolicy,
  type RetentionContext,
  type SyncGate,
} from './retention'
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
   * Whether this api serves a review list at all: true when a broker poll loop
   * is wired, when a local review surface is wired, or both. The router gates
   * `GET /api/pulls` on THIS capability rather than on the deployment mode,
   * mirroring how the broker write routes gate on `brokerWritesEnabled`.
   *
   * The gate is load-bearing rather than decorative, and the reason is worth
   * stating where it can be read: `listPulls` throws a typed `not_found` when
   * neither source is wired, and a route that dispatched into it unconditionally
   * would serialize that as a 404 — telling a client the list does not exist,
   * when the truth is that this daemon does not serve one. Keyed on the
   * capability, a daemon with no list to offer keeps answering the honest
   * `not_implemented` (501) it answers today.
   */
  readonly pullListEnabled: boolean

  /**
   * Whether this api has a GitHub repository to address: true only when a repo
   * and a client for it were BOTH injected. A daemon that resolved no
   * repository — a boot for reviews of local branch pairs, which needs no
   * origin, no token and no viewer — reports false.
   *
   * The router gates the GitHub-only surfaces on THIS capability, the same way
   * it gates the pull list and the broker writes on theirs. The gate is the
   * only thing standing between such a daemon and the methods below that need a
   * repository: they narrow their dependencies and throw when the half is
   * missing, which the router's terminal catch-all would render as
   * `broker_unreachable` (500) — a broker outage reported to a deployment whose
   * premise is that it has no broker.
   *
   * The capability is NOT a statement about the local band. The `:n` routes and
   * the snapshot read serve a review of a local branch pair with no GitHub
   * involved at all, so the router's refusal is decided per REVIEW rather than
   * per route.
   */
  readonly githubEnabled: boolean

  /**
   * The conditional review list, assembled from up to two sources and never
   * from a per-request GitHub call: the broker's ~30s poll cache, and the local
   * reviews this daemon records for branch pairs that have no pull request.
   * Either may be absent. When both are present the halves are MERGED — poll
   * items in their existing order, then local reviews by id descending — and the
   * ETag is derived from both, so a change in either invalidates a client's
   * cached list. An ETag over one half alone would leave an inbox 304-ing
   * forever against a change in the other.
   *
   * `ifNoneMatch` is the client's `If-None-Match`; when it matches the served
   * ETag the result is `notModified: true` with empty items (the caller replays
   * its last-known list per the frozen 304 rule), else the full list.
   *
   * Throws a typed `not_found` when NEITHER source is wired: this instance
   * serves no list, which is not a promise to serve one later. The router never
   * reaches that throw — it gates on `pullListEnabled` and answers 501 — so it
   * is the fail-closed backstop for a direct caller. `broker_unreachable`
   * propagates from the poll source when it has no live list yet, a retriable
   * "live data unavailable" and never a fabricated empty list.
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

  /**
   * Remove one local review, and everything the store and the object database
   * were holding on its behalf: its rows, the refs pinning the git objects its
   * snapshot was read from, and whatever cached half the removal has just left
   * referenced by nothing.
   *
   * Scoped to the local band, and an id outside it is refused BY NAME rather
   * than absorbed. A pull request number is a positive integer too, so a clean
   * success for one would report a pull request removed as a review of a branch
   * pair — and would hide the mistake instead of naming it.
   *
   * REFUSED, as a typed `unprocessable`, while any human's draft on the review
   * holds text — a pending comment, or a body with anything in it. The route
   * carries no flag to force it, so the refusal is the whole answer and the
   * message names the only way past it: discard the draft, then delete. That
   * is what keeps "drafts survive everything" true for a delete as well as
   * for a submit — text leaves this store only by its own human's discard or a
   * confirmed submit, so the drafts a delete can take are exactly the empty
   * ones, which destroy nothing. The check spans EVERY human's draft, because
   * the removal would take every human's draft; and it lets the empty draft an
   * editor creates on open straight through, because counting that as text
   * would make every review a human had merely looked at undeletable. It is a
   * precondition, checked before a row is touched, so a refusal never leaves a
   * review half removed.
   *
   * An id inside the band that names no review this daemon serves — never
   * created, already deleted, or belonging to a repository sharing the data
   * directory — answers a typed `not_found` scoped to this workspace, and
   * every one of those cases answers in the same words: a distinguishable
   * answer would confirm to one repository's client that an id exists
   * somewhere else. A retry of a removal whose answer was lost therefore meets
   * `not_found`, which tells the caller the review is gone; nothing is at
   * risk in that retry, because a refusal touches nothing.
   *
   * Deleting a review deletes every human's drafts on it, which the refusal
   * above guarantees are empty. That is an explicit act of removal rather than
   * a reclamation, and it is the only way a draft row is ever removed here by
   * anyone but its own human — nothing that runs on its own may reach one.
   */
  deleteLocalReview(reviewId: number): Promise<void>

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
  /**
   * The GitHub half: the repository every request path is built from, and the
   * client that addresses it. Both are present together or absent together —
   * a daemon that resolved no repository has no client to build one for.
   *
   * ABSENT when this daemon reviews local branch pairs and nothing else: such a
   * boot has no origin, no token and no viewer. The absence is a TYPE, never a
   * blank `{ owner: '', repo: '' }` stand-in — a stand-in builds request paths
   * like `/repos///pulls/204`, which GitHub answers 404 with a message blaming
   * the pull request rather than the missing repository. Every GitHub-backed
   * surface narrows instead of interpolating, and the router refuses the routes
   * that would need one before they are reached.
   */
  github?: GithubClient
  repo?: RepoRef
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
   * in broker mode; ABSENT in direct and mock, where the review list is built
   * from local reviews alone, or not served at all. The api only reads from it —
   * the loop's lifecycle (start/stop) is owned by broker boot, not by the api.
   */
  pullList?: PullListSource

  /**
   * The listing seam the local sync path consults to find out whether a pull
   * request has appeared for a local review's branch pair — the read half of
   * archiving a superseded review. Nothing is ever written to GitHub through
   * it; the write it leads to is a column on the local row.
   *
   * ABSENT in a workspace with no origin and no credential, which is the
   * deployment local reviews exist for: there is no repository to ask about, so
   * nothing is asked and every review stays live. Absent also in the mock and
   * in broker mode's non-local paths. Only the local sync path reads it, and it
   * is optional precisely so that a boot without a GitHub half needs no
   * stand-in to pass.
   */
  supersedingPulls?: SupersedingPullSource

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

  /**
   * The in-flight counter this daemon's syncs are entered into, so a retention
   * sweep running for another request can tell that a review is mid-write.
   *
   * Optional because the pairing that matters is made HERE and cannot come
   * apart by omission: this surface resolves one gate, enters every sync into
   * it, and hands that same binding to every prune it runs. A gate only guards
   * anything while the sync path and the sweep hold the SAME one — two gates
   * over one data directory each report a count the other's work never moves,
   * and both read a clean zero while the window they exist to close stands wide
   * open — so an absent field means a private gate on both sides rather than a
   * missing half.
   *
   * Inject one only to share that window with a sweep running OUTSIDE this
   * surface, and then it must be the identical instance for the same reason.
   */
  syncGate?: SyncGate

  /**
   * Whether this daemon reclaims file bytes as well as cached snapshot halves
   * when it prunes. OFF unless a deployment writes it down.
   *
   * The question is a deployment's to answer and not this surface's to infer:
   * nothing readable here distinguishes a workspace whose reviews are all
   * backed by a remote from one whose local reviews are the only copy of what
   * they were read from. Absent, the halves are reclaimed and the bytes are
   * kept — which grows the largest table in the store monotonically, and is the
   * accepted cost of never removing bytes that had no second source.
   */
  blobRetention?: BlobRetentionPolicy
}

/**
 * The narrow source `DirectApi.listPulls` reads: the broker poll loop's served
 * view. Kept as a one-method interface so the api depends only on the read, not
 * on the loop's timer/lifecycle.
 */
export interface PullListSource {
  listPulls(ifNoneMatch: string | null): PullListResponse
}

/** djb2 string hash, rendered lowercase hex — the family every list ETag here uses. */
function djb2Hex(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16)
}

/**
 * The compare key a local review row currently claims: the three-dot join of its
 * merge base and its head, the same key a snapshot is content-addressed by. A
 * review that has never been synced holds null on both sides and so joins to
 * `...` — a key no snapshot can match, which is exactly right, because there is
 * no snapshot for it to match.
 */
function localCompareKey(review: LocalReviewSummary): string {
  return `${review.mergeBaseSha ?? ''}...${review.headSha ?? ''}`
}

/**
 * The ETag served for a review list, composed from the poll source's own ETag
 * and the local rows AS SERVED. BOTH halves are always in the composition — the
 * poll half as the empty string when no loop is wired — so a local-only list
 * and a merged one cannot grow two different rules for it. A change in either
 * half moves the result, which is what stops a client replaying a matching
 * ETag from never being shown the other half's change.
 *
 * The local half hashes the whole serialized row, never a projection of it. A
 * projection invites exactly one failure: a field it omits changes — a thread
 * resolves and `unresolvedThreads` drops, a review is retitled, an archive
 * flips a row's state — while every projected field stands still, and the
 * client 304s forever on a list that is no longer what it would be served.
 * Hashing what is served makes "the ETag moved" and "the body changed"
 * equivalent by construction.
 */
function reviewListEtag(pollEtag: string, localItems: readonly PullListItem[]): string {
  return `W/"pulls+local:${djb2Hex(pollEtag)}:${djb2Hex(JSON.stringify(localItems))}"`
}

/**
 * The allowance a list assembled without touching GitHub reports. Local reviews
 * are read from the store and the workspace's own refs, so `used` is zero as a
 * measured fact rather than a field nobody filled in — the shape that makes
 * honest-error copy read "not rate limited" instead of naming an exhausted
 * bucket. The limit is deliberately NOT GitHub's own figure, which would be a
 * fabricated reading of an allowance this list never spent from, and the reset
 * instant is meaningless for a bucket that never empties.
 */
function unspentRateLimit(): RateLimitInfo {
  return {
    limit: Number.MAX_SAFE_INTEGER,
    remaining: Number.MAX_SAFE_INTEGER,
    used: 0,
    reset: new Date(0).toISOString(),
  }
}

/**
 * One local review projected into a list row: a synthesized pull summary, and
 * the meta a row carries.
 *
 * The meta half is DERIVED here rather than stored:
 *   - `authorHumanId` is null. It names the human who drove the shared App
 *     identity when a pull request was opened, and none was opened here, so no
 *     surface may claim one was.
 *   - `canApprove` is true. GitHub's refusal to let an account approve its own
 *     pull request has no local analogue, so every verdict stays available.
 *   - `unresolvedThreads` is counted from the durable thread table, the same
 *     source the snapshot's mutable half is rebuilt from, so the row and the
 *     opened review cannot disagree about how much is outstanding.
 *   - No reviewers can be assigned where there is no pull request to assign
 *     them to.
 *   - `checks` is ABSENT rather than empty. Nothing has reported on a branch
 *     that was never pushed, which is neither a pass nor a failure, and the
 *     field's absence already means precisely that.
 *
 * The two local-only annotations, `dirty` and `archivedPr`, are deliberately not
 * smuggled in: the meta shape carries no field for either, and both ride the
 * local-review summary on its own route, so no surface renders one row from two
 * sources of truth.
 */
function localPullListItem(
  surface: LocalReviewSurface,
  session: Session,
  review: LocalReviewSummary,
): PullListItem {
  const side = (ref: string, sha: string | null): GhRef => ({
    ref: shortRefName(ref),
    sha: sha ?? '',
    label: shortRefName(ref),
    // The default branch is a git read this synchronous list cannot make, and
    // the review row records none. Empty is the same "not known" a local
    // snapshot's own synthesized pull carries for a clone whose origin has no
    // symbolic HEAD — a marker nobody has, rather than one invented here.
    repo: { full_name: review.repo, default_branch: '' },
  })
  const snapshot = surface.getSnapshot(review.id)
  return {
    pull: {
      id: review.id,
      node_id: `local:${review.id}`,
      number: review.id,
      // A review superseded by a pull request has gone read-only, which is what
      // `closed` means to every surface reading this list.
      state: review.archivedPr === null ? 'open' : 'closed',
      draft: false,
      merged_at: null,
      title: review.title,
      body: null,
      // The session's human: no hosted account stands behind a local review, and
      // a display name is the only honest thing to put in the author slot.
      user: synthesizeLocalUser(session.human.name),
      labels: [],
      requested_reviewers: [],
      head: side(review.headRef, review.headSha),
      base: side(review.baseRef, review.baseSha),
      created_at: review.createdAt,
      updated_at: review.updatedAt,
    },
    broker: {
      authorHumanId: null,
      canApprove: true,
      unresolvedThreads: surface.listThreads(review.id).filter((t) => !t.isResolved).length,
      assignedReviewerHumanIds: [],
      compareKey: localCompareKey(review),
      // Zero before the first sync, when no snapshot has been assembled. That is
      // true rather than unknown: nothing has been brought under review yet.
      commitCount: snapshot?.immutable.commits.length ?? 0,
    },
  }
}

/**
 * Every local review as a list row, newest id first. The order is fixed here
 * rather than left to the store, because the served ETag is a function of this
 * sequence: an order that varied between two calls would move the ETag with
 * nothing having changed, and a client would re-fetch a list it already holds.
 */
function localPullListItems(
  surface: LocalReviewSurface,
  session: Session,
): PullListItem[] {
  return surface
    .listLocalReviews()
    .slice()
    .sort((a, b) => b.id - a.id)
    .map((review) => localPullListItem(surface, session, review))
}

/** Build the direct-mode API surface over an injected client + durable store. */
export function createDirectApi(deps: DirectApiDeps): DirectApi {
  const humanId = deps.session.human.id
  const now = deps.now ?? (() => new Date().toISOString())
  const writeDecorator =
    deps.writeDecorator ?? createDirectWriteDecorator(deps.session.human)
  const syncGate = deps.syncGate ?? createSyncGate()

  /**
   * The archive check the local sync path runs, or null when this daemon has
   * no listing seam — a workspace with no origin or no credential — and so
   * nothing to ask. Built once: the seam and the store are both fixed for the
   * life of the api, and the detector holds nothing per review.
   */
  const archiveDetector =
    deps.supersedingPulls === undefined
      ? null
      : createLocalArchiveDetector({ source: deps.supersedingPulls, store: deps.store })

  /**
   * The repository a pin drop acts in, or a refusal.
   *
   * A local review's pins are refs in a git object database, so dropping them
   * needs a command seam and a directory to run it in. Both arrive at assembly
   * or neither does, and a surface that serves local reviews without them could
   * not drop a ref at any point in its life. So this refuses BEFORE a removal
   * begins rather than part-way through one: a delete that removed the rows and
   * then discovered it had no way to reach git would leave the objects pinned
   * under an id nothing names any more, which no later call can find again.
   *
   * A plain error on purpose. Every boot that serves local reviews wires both,
   * so this is an invariant guard rather than a contract answer, and a typed
   * `ApiError` would serialize into a plausible-looking refusal and let an
   * assembly fault pass for a considered one.
   */
  const pinRepository = (): RetentionContext => {
    if (deps.runner === undefined || deps.cwd === undefined) {
      throw new Error(
        'This surface serves local reviews but was assembled without a command ' +
          'runner and a repository directory, so a review’s pinned refs could ' +
          'never be dropped; assemble it with both.',
      )
    }
    return { runner: deps.runner, cwd: deps.cwd }
  }

  /**
   * Reclaim whatever the store is now holding for nothing: the cached snapshot
   * halves no stored snapshot names, and — when a deployment has asked for it —
   * the file bytes no stored comparison names.
   *
   * The ONE place either prune is reached from, and it hands both the gate. A
   * call site that reached a prune directly would be a sweep with no opinion
   * about the syncs running beside it, and the window it would then run inside
   * is exactly the one where a review's fresh rows are referenced by nothing
   * YET. Routing every call through here closes that window by construction
   * instead of by each caller remembering to.
   *
   * Nothing here decides the outcome of the act that triggered it. A prune
   * reports what it removed as a value, and both refusals it can answer — a
   * sync in flight, a policy left off — are ordinary. What is not ordinary is a
   * store that cannot be read or written, and that arrives as a throw. Letting
   * it out would turn a sync whose snapshot is already on disk, or a removal
   * whose rows are already gone, into a reported failure for work that
   * succeeded — and would do it on the strength of a corrupt row belonging to
   * some unrelated review. Under-removal is the direction this whole path
   * prefers: it costs disk until the next attempt and loses nothing. So the
   * failure is logged rather than raised, and the corruption still surfaces,
   * loudly and in its own terms, at the next read of the row that is broken.
   */
  const reclaimUnreferenced = (): void => {
    try {
      pruneImmutables(deps.store, syncGate)
      pruneBlobs(deps.store, syncGate, deps.blobRetention)
    } catch (err) {
      // Sanitized: the error's NAME only. Stored documents carry review
      // content, and a reclamation failure is not a reason to print any of it.
      console.warn(
        'revu: could not reclaim unreferenced rows ' +
          `(${err instanceof Error ? err.name : 'unknown error'}); nothing was ` +
          'removed, and the store keeps every row it already held.',
      )
    }
  }

  /**
   * The sync of a local review, in four steps whose ORDER is the contract.
   *
   * 1. THE ROW, through the surface's ownership guard and never off the store.
   *    Ids are minted from one mark shared by every repository using the data
   *    directory, so the row an id names may belong to a repository this daemon
   *    does not serve; the guard answers that with the same typed not-found an
   *    absent id gets, and nothing below runs. Read off the store instead, a
   *    foreign row's branch pair would be carried into a question about THIS
   *    repository's pull requests.
   *
   * 2. DETECTION, for a live review with a seam to ask. It runs BEFORE the git
   *    work so that the sync which finds a pull request goes on to store a
   *    snapshot already describing the review as closed — the synthesized pull
   *    derives its state from the row's number, and the surface re-reads the
   *    row — rather than leaving one stale envelope behind that still claims
   *    open and that nothing would ever rewrite. It runs OUTSIDE the gate
   *    because it waits on a network: a sweep held off for the length of a
   *    hosted request would be held off for a window that protects nothing,
   *    since detection writes one column of one row and touches no half. An
   *    already archived review skips it: archival is one-way, and the detector
   *    would answer the standing number without asking anyway.
   *
   * 3. THE SYNC, inside the gate. The surface writes the blob bytes and then
   *    reads git three more times before its envelope lands, and on this side
   *    the bytes have no second source to be refetched from, so a sweep is
   *    held off across the whole of it. A review the surface finds archived
   *    with a snapshot that already agrees comes back FROZEN: the stored
   *    snapshot, no git, no new half, no pin, no re-stamped row.
   *
   * 4. RECLAMATION, outside the gate, and only after a sync that READ the
   *    repository. A re-synced branch pair is the event that strands a half —
   *    a rebased branch mints a fresh compare key and the envelope that lands
   *    stops naming the old one — so the moment there is something new to
   *    reclaim is the moment to reclaim it. A frozen sync minted nothing and
   *    stranded nothing, and a prune keyed on it would sweep for no reason.
   *    Outside the wrapper is the whole of the placement: the gate holds a
   *    sweep off while any sync is in flight, so a prune called from inside it
   *    would read its own sync's raised count, stand aside every time, and
   *    never remove a row — indistinguishable from a prune that keeps finding
   *    nothing to do. A sync that rejects never reaches the prune at all.
   */
  const syncLocalPull = async (local: LocalReviewSurface, localId: number): Promise<Snapshot> => {
    const review = local.getLocalReview(localId)

    if (review.archivedPr === null && archiveDetector !== null) {
      // The verdict is not read back here: the surface re-reads the row and
      // derives everything it stores from what stands on it, which is also
      // what a write-once column racing another daemon leaves there.
      await archiveDetector.detect(review)
    }

    const outcome = await withSyncInFlight(syncGate, () => local.syncLocalReview(localId))

    if (!outcome.frozen) reclaimUnreferenced()
    return outcome.snapshot
  }

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

  /**
   * The GitHub client, or a refusal. A rate-limit read is scoped to the
   * CREDENTIAL and names no repository, so it needs this half alone.
   *
   * Unreachable by construction: the router refuses every route that lands here
   * before dispatching, keyed on `githubEnabled`. It is therefore an invariant
   * guard rather than a contract answer, and it throws a plain error on purpose
   * — a typed `ApiError` would serialize into a plausible-looking contract
   * response and let a hole in the router's gate pass for a considered answer.
   */
  const githubClient = (): GithubClient => {
    if (deps.github === undefined) {
      throw new Error(
        'This daemon was assembled without a GitHub client; the router must ' +
          'refuse every GitHub-backed route before it reaches this surface.',
      )
    }
    return deps.github
  }

  /**
   * The repository and the client together — what every request path against
   * GitHub is built from. Guarded for the same reason, and in the same way, as
   * the client alone.
   */
  const githubTarget = (): { github: GithubClient; repo: RepoRef } => {
    const repo = deps.repo
    if (repo === undefined) {
      throw new Error(
        'This daemon resolved no GitHub repository; the router must refuse ' +
          'every GitHub-backed route before it reaches this surface.',
      )
    }
    return { github: githubClient(), repo }
  }

  /**
   * The invariant bundle every write operation shares. Built per call rather
   * than once, so a daemon with no repository can be assembled at all: the
   * local band never reads it, and the GitHub band cannot be reached without
   * one.
   *
   * A viewer identity is a precondition here, alongside the repository and the
   * client — for writes ONLY, never for reads. The self-review gate and the
   * submit idempotency re-check both compare against `session.viewerLogin`,
   * and both silently invert on an absent one: every verdict is refused with a
   * reason that blames the author, and no prior review can ever match, so a
   * retried submit double-posts. No supported assembly reaches this guard —
   * direct mode probes the viewer whenever it keeps a repository, a
   * write-enabled broker carries the bot login as its viewer, and a reads-only
   * broker's GitHub-band writes are refused by the router before dispatch — so
   * like the two guards above it throws a plain error rather than a typed
   * `ApiError` that would dress an assembly hole up as a considered answer.
   * Reads are deliberately exempt: a reads-only broker legitimately serves
   * sync and snapshots over a GitHub half with no viewer at all.
   */
  const writeDeps = (): {
    github: GithubClient
    repo: RepoRef
    store: DirectStore
    session: Session
    writeDecorator: WriteDecorator
    now?: () => string
  } => {
    const target = githubTarget()
    if (deps.session.viewerLogin === undefined) {
      throw new Error(
        'This daemon holds a GitHub repository but no viewer identity; a ' +
          'GitHub-bound write must not run, because the self-review gate and ' +
          'the submit idempotency re-check compare against the viewer login ' +
          'and silently invert on an absent one.',
      )
    }
    return {
      ...target,
      store: deps.store,
      session: deps.session,
      writeDecorator,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    }
  }

  return {
    // The capability is read off the decorator actually injected, so it can be
    // true only when the broker stamping+journaling decorator is present —
    // never by default, and never from session or env shape.
    brokerWritesEnabled: writeDecorator.brokerWritesEnabled === true,

    // The list capability is read off the sources actually injected, so a daemon
    // wired with neither keeps the honest 501 the router answers for it instead
    // of the misleading 404 the throw below would become.
    pullListEnabled: deps.pullList !== undefined || deps.localReviews !== undefined,

    // Read off the halves actually injected, and off BOTH of them: a client
    // with no repository can address nothing, and a repository with no client
    // cannot be asked about. Either alone would let the router dispatch into a
    // surface that then fails on the other.
    githubEnabled: deps.github !== undefined && deps.repo !== undefined,

    listPulls(ifNoneMatch: string | null): PullListResponse {
      const local = deps.localReviews
      const pollSource = deps.pullList
      if (local === undefined) {
        if (pollSource === undefined) {
          // Neither source: this instance serves no list. A typed `not_found`
          // (404) rather than `not_implemented`, which would promise the
          // capability is coming — a daemon assembled without either source is
          // not going to grow one mid-run. The router gates the route on
          // `pullListEnabled` and never reaches here.
          throw new ApiError(
            'not_found',
            'This daemon serves no review list: it has neither a broker poll ' +
              'loop nor a local review surface.',
          )
        }
        // The poll cache IS the served view, its ETag included, so the
        // conditional read is delegated whole rather than re-derived around it.
        return pollSource.listPulls(ifNoneMatch)
      }

      // The ETag hashes these BUILT rows rather than anything recomputed from
      // the store, so the value the ETag is composed from and the value the
      // client renders are the same object by construction.
      const localItems = localPullListItems(local, deps.session)

      if (pollSource === undefined) {
        const etag = reviewListEtag('', localItems)
        if (ifNoneMatch !== null && ifNoneMatch === etag) {
          return { items: [], etag, notModified: true, rateLimit: unspentRateLimit() }
        }
        return { items: localItems, etag, notModified: false, rateLimit: unspentRateLimit() }
      }

      // The client's `If-None-Match` is deliberately NOT forwarded: it conditions
      // on the MERGED ETag, a value the poll source has never issued and could
      // only fail to match. Asking unconditionally is what makes the poll half
      // available to compose the merged ETag from — and composing it from both is
      // the only thing that stops a new pull request from sitting behind a 304
      // forever while the local half stands still.
      const poll = pollSource.listPulls(null)
      const etag = reviewListEtag(poll.etag, localItems)
      if (ifNoneMatch !== null && ifNoneMatch === etag) {
        return { items: [], etag, notModified: true, rateLimit: poll.rateLimit }
      }
      return {
        items: [...poll.items, ...localItems],
        etag,
        notModified: false,
        // The live allowance, not the unspent one: the poll half really did
        // spend from the shared bucket, and only a purely local list may claim
        // otherwise.
        rateLimit: poll.rateLimit,
      }
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

    async deleteLocalReview(reviewId: number): Promise<void> {
      // The same band dispatch every other id-keyed method opens with, so this
      // route carries no rule of its own about which reviews it may remove. A
      // local id with no local surface wired refuses inside it; a pull request
      // number falls out as `null` and is refused here, because a delete has no
      // GitHub-backed twin to fall through to and a clean success would report
      // a pull request removed as a review of a branch pair.
      const local = localFor(reviewId)
      if (local === null) {
        throw new ApiError(
          'not_found',
          `Review #${reviewId} is not in the local-review band; this removes reviews of local branch pairs alone.`,
        )
      }

      // Resolved with every row still in place, so an assembly that could never
      // reach git refuses before it has removed anything.
      const repository = pinRepository()

      // Scoped to the reviews THIS daemon serves. Ids are minted from one
      // monotonic mark shared by every repository using the data directory, and
      // the row delete is keyed by the id alone — so an id can name a review
      // belonging to a repository this daemon knows nothing about, with
      // branches, a worktree and a clock that are not its own. Such an id gets
      // EXACTLY the answer an id carrying no review at all gets — the same
      // typed `not_found`, scoped to this workspace, in the same words —
      // because any distinguishable answer would confirm to one repository's
      // client that the id exists somewhere else. A review deleted a moment
      // ago is the third member of that set and answers the same way: a
      // removal is a named act on a review that exists, so an absent one is a
      // missing resource, never a success to report twice.
      //
      // Thrown before anything is touched, the refs included. A drop over this
      // id's namespace would be idempotent, and would tidy up after a drop that
      // once failed part-way — but an answer of "not found" must have no side
      // effect at all, so that clean-up belongs to an explicit operator action
      // rather than to a refusal.
      if (!local.listLocalReviews().some((review) => review.id === reviewId)) {
        throw new ApiError(
          'not_found',
          `No local review with id ${reviewId} exists in this workspace.`,
        )
      }

      // REFUSED while any human's draft on the review holds text. The rows
      // below go together, every human's draft among them, and text a human
      // has not submitted leaves this store only by that human's own discard
      // or a confirmed submit — so the delete has to turn away rather than be
      // the one path that takes it. Every human's draft, not the session's:
      // two reviewers of one branch pair hold two rows and the removal would
      // take both. The empty draft an editor creates the moment a review is
      // opened passes, because a check that counted it as text would make
      // every review a human had merely looked at undeletable.
      //
      // `unprocessable` is the exact code: the review exists, nothing moved
      // underneath the caller, and the caller can put the review into a state
      // that honors the identical request — the message says how.
      //
      // Read and acted on with no await between this check and the row removal
      // below. Nothing else on this surface can write a draft in that gap, so
      // the precondition cannot hold here and have stopped holding by the time
      // the rows go.
      if (deps.store.listLocalDrafts(reviewId).some(draftHoldsText)) {
        throw new ApiError(
          'unprocessable',
          `Local review ${reviewId} still holds an unsubmitted draft with text in it — ` +
            'discard that draft, then delete the review.',
        )
      }

      // ——— The order below is the correctness, not a preference. ———
      //
      // Rows first. A prune run before them still reads the doomed review's
      // snapshot envelope, so its compare key is LIVE and the half about to
      // become an orphan is proposed by nothing — and no later sweep has any
      // reason to look at that review again, because the row that named it is
      // gone. Pruning early therefore does not merely miss the reclamation, it
      // strands the half permanently.
      //
      // Refs second, and never after the prune. A pin holds git objects
      // reachable on behalf of data the store still has; between a prune and a
      // drop that followed it, the object database is pinned for a review that
      // no longer exists, and a drop that then fails leaves it that way with
      // nothing left to say what the pins were for.
      //
      // The prune last, when the rows are gone and the halves they were the
      // only reference to have finally become unreferenced.
      deps.store.deleteLocalReview(reviewId)

      // A drop discovers its refs rather than reconstructing them, so a review
      // whose pins were never written costs one listing here and nothing more.
      const dropped = await dropPinnedRefs(repository, reviewId)
      if (!dropped.ok) {
        // A value, not a throw, and the rows are already gone — so this is
        // reported rather than raised. Objects left pinned cost disk and lose
        // nothing, whereas answering a failure for a removal that succeeded
        // would invite a retry that finds the review already absent.
        console.warn(
          `revu: dropped ${dropped.count} of review #${reviewId}'s pinned refs ` +
            `before failing (${dropped.reason}: ${dropped.detail}); the objects ` +
            'behind the rest stay reachable until the refs are removed.',
        )
      }

      reclaimUnreferenced()
    },

    async syncPull(prNumber: number): Promise<Snapshot> {
      // The dispatch sits AHEAD of the gate rather than inside it. Its one
      // refusal — an id from the local band on a daemon that serves no local
      // reviews — is raised before any count is taken, so there is nothing to
      // release on the way out; and the local path has work to do before its
      // git work that must not hold a sweep off while it waits on a network.
      const local = localFor(prNumber)
      if (local !== null) return syncLocalPull(local, prNumber)

      // The hosted engine puts the immutable half down and lands its envelope
      // several awaits later; the gate holds a sweep off across that window.
      return withSyncInFlight(syncGate, () =>
        runSyncPull(
          {
            ...githubTarget(),
            store: deps.store,
            ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
            ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
            ...(deps.now !== undefined ? { now: deps.now } : {}),
          },
          prNumber,
        ),
      )
    },

    async getRateLimit(): Promise<RateLimitInfo> {
      return githubClient().getRateLimit()
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
      return runSubmitReview(writeDeps(), input)
    },

    async replyToThread(
      prNumber: number,
      threadId: string,
      body: string,
    ): Promise<ReviewComment> {
      const local = localFor(prNumber)
      if (local !== null) return local.replyToThread(prNumber, threadId, body)
      return runReplyToThread(writeDeps(), prNumber, threadId, body)
    },

    async resolveThread(
      prNumber: number,
      threadId: string,
      resolved: boolean,
    ): Promise<ReviewThread> {
      const local = localFor(prNumber)
      if (local !== null) return local.resolveThread(prNumber, threadId, resolved)
      return runResolveThread(writeDeps(), prNumber, threadId, resolved)
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
      return runAddReaction(writeDeps(), prNumber, commentId, reaction)
    },
  }
}
