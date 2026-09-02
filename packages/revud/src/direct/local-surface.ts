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
  Session,
  Snapshot,
  SubmitResult,
  SubmitReviewInput,
} from '@revu/shared'
import { ApiError, isValidRefName, normalizeRefName } from '@revu/shared'
import { provisionBlobs } from './blobs'
import type { CommandRunner } from './command-runner'
import { checkRefFormat, listBranches as listGitBranches, runGit } from './local-git'
import type {
  CommitLogFailed,
  DiffFailed,
  LocalRangeFailure,
  MalformedCommitLog,
  MalformedDiff,
} from './local-sync'
import type { PinFailureReason } from './local-pins'
import { pinSnapshotObjects } from './local-pins'
import {
  detectDirtyWorktree,
  readLocalAuthorName,
  readLocalSnapshotImmutable,
  resolveLocalRange,
  shortRefName,
  synthesizeLocalPullDetail,
} from './local-sync'
import type { LocalWriteDeps } from './local-writes'
import {
  addLocalReaction,
  replyToLocalThread,
  resolveLocalThread,
  submitLocalReview,
} from './local-writes'
import type { ReconcileStore } from './reconcile'
import { reconcileDraft as runReconcileDraft } from './reconcile'
import type { DirectStore } from './store'
import { StoreUnreadableError } from './store'

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
   * One review row, owned by this repository, or the typed not-found an absent
   * id answers. The row is what says whether a pull request has superseded the
   * review, and a caller deciding whether to ask the hosted repository about
   * a review must read it HERE rather than off the store: the store reads by id
   * alone, so a row belonging to another repository would come back with its
   * own branch pair, and that pair would then be asked about against this
   * repository's pull requests.
   */
  getLocalReview(localId: number): LocalReviewSummary

  /**
   * The branches the repository can offer as either side of a new review —
   * local branches and remote-tracking refs both, since a base is often tracked
   * rather than checked out.
   */
  listBranches(): Promise<BranchRef[]>

  /**
   * Recompute the diff between the pair's current tips and persist a snapshot.
   *
   * The contract-shaped verb: it answers with exactly the wire type and nothing
   * beside it. Anything a sync learns that the wire type has no field for is
   * reached through `syncLocalReview`.
   */
  syncPull(localId: number): Promise<Snapshot>

  /**
   * The same sync, plus what it learned that the snapshot shape cannot carry.
   *
   * The snapshot is a frozen wire type shared with the hosted path, so a local
   * detail cannot be added to it — and the pin outcome is exactly such a detail.
   * It is deliberately not folded into `partial`, which means content is
   * missing: an unpinned snapshot is complete, it simply has no guarantee that
   * it will still be readable after the branch moves. Collapsing the two would
   * make a retention failure and an unreadable object indistinguishable.
   */
  syncLocalReview(localId: number): Promise<LocalSyncOutcome>

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

/**
 * Everything the assembled surface holds. The store and the runner are the two
 * real capabilities; the rest is identity and a clock.
 *
 * There is deliberately NO hosted client here, and that absence is the whole
 * guarantee rather than a default nobody set. Blob bytes are provisioned with
 * the client omitted, so an object this clone can no longer produce is reported
 * by name instead of being bought back over a network — and no code path below
 * has a client to mis-call even if one were wanted.
 */
/**
 * Whether a sync managed to pin the objects it read.
 *
 * A pin failure is not a sync failure. The objects are present right now — that
 * is how the snapshot was built — and the pin only decides whether they survive
 * the branch moving. So the sync completes, the snapshot is stored, and the
 * outcome travels here for a caller that has somewhere to put it. Nothing
 * renders it yet, which is why it is a record of what happened rather than a
 * classification of what to do about it.
 */
export interface LocalPinOutcome {
  readonly ok: boolean
  /** Present only on failure, naming the class of failure rather than its text. */
  readonly reason?: PinFailureReason
}

/** A sync that read the repository: the snapshot it stored, and the pin it attempted. */
export interface LocalSyncPerformed {
  readonly frozen: false
  readonly snapshot: Snapshot
  readonly pin: LocalPinOutcome
}

/**
 * A sync that read nothing, because the review is archived and already holds
 * the snapshot it froze at. The snapshot is the stored one, byte for byte; no
 * pin was attempted, so none is reported — `null` rather than a vacuous
 * success, because the objects behind a frozen snapshot were pinned, or not, by
 * the sync that stored it, and that outcome was reported then.
 */
export interface LocalSyncFrozen {
  readonly frozen: true
  readonly snapshot: Snapshot
  readonly pin: null
}

/**
 * A completed local sync, discriminated on whether it read the repository.
 *
 * `frozen` is what a caller that prunes after a sync reads: a frozen sync
 * stranded no half and minted no compare key, so there is nothing new to
 * reclaim and a prune keyed on it would sweep for no reason.
 */
export type LocalSyncOutcome = LocalSyncPerformed | LocalSyncFrozen

export interface LocalReviewSurfaceDeps {
  store: DirectStore
  runner: CommandRunner
  /**
   * The repository's discovered toplevel — never a bare process working
   * directory. Every git read below runs here, so a daemon started in some
   * unrelated directory still acts on the repository it was pointed at.
   */
  toplevel: string
  /**
   * The repository identity the reviews are scoped to. Two repositories can
   * share one data directory, and branch names collide across them far more
   * readily than pull-request numbers do, so the listing is keyed on this.
   */
  repo: string
  session: Session
  /** Timestamp source; injectable so stored documents are deterministic in tests. */
  now?: () => string
}

/** A full-length object name. Anything shorter or differently spelled is not one. */
const OBJECT_NAME = /^[0-9a-f]{40}$/

/** A decimal count, in the form `git rev-list --count` prints one. */
const DECIMAL_COUNT = /^\d+$/

/** The one clock every document a single call stamps is read from. */
function clockOf(deps: LocalReviewSurfaceDeps): () => string {
  return deps.now ?? ((): string => new Date().toISOString())
}

/**
 * The review row, or the typed not-found naming an id nothing carries. Every
 * id-keyed operation on the surface goes through this FIRST, so an unknown id
 * answers identically wherever it arrives.
 *
 * OWNED BY THIS REPOSITORY, not merely present. The store read is keyed by the
 * id alone, and ids are minted from one monotonic mark shared by every
 * repository using the data directory, so the row that comes back can belong to
 * a repository other than the one this surface serves. Such a row is refused
 * with the SAME code and the SAME sentence an absent id answers: any
 * distinguishable answer would confirm to one repository's caller that the id
 * exists somewhere else, and a check that passed it would let every read and
 * write behind it act on another repository's review with this repository's
 * branches, worktree, clock and session.
 */
function requireReview(deps: LocalReviewSurfaceDeps, localId: number): LocalReviewSummary {
  const review = deps.store.getLocalReview(localId)
  if (review === null || review.repo !== deps.repo) {
    throw new ApiError('not_found', `No local review carries the id ${localId}.`)
  }
  return review
}

/**
 * The current head of one local review, and the number of commits in the SAME
 * COMPARE its stored snapshot was built from.
 *
 * THE SCOPE IS THE POINT. The count is taken over `merge base..head` and never
 * over the head alone, because the only consumer subtracts the stored compare's
 * commit list from it. Counted over the whole of the current head, that
 * subtraction would take one range's worth of commits away from the branch's
 * entire history and report the repository's age as new work on the branch — a
 * number wrong by however old the base branch is, and one that looks exactly
 * like a number somebody computed on purpose.
 *
 * Both revisions travel behind the hardened git seam rather than a spawn of this
 * module's own, so ref-name hardening stays in one place; and the head is
 * screened as a full-length object name before it is joined into a range, since
 * a clean exit whose output is not an object name would otherwise build a range
 * expression out of whatever git happened to print.
 *
 * FAILURES HERE SPLIT ON WHOSE FAULT THEY ARE, and the split decides the type.
 * A missing row, a row another repository owns, and a null merge base are WIRING
 * failures: every verb that awaits this first resolves its review through the
 * ownership-checking guard and refuses a never-synced one, so arriving here in
 * any of those states means something called this outside those guards — each
 * throws a plain error, because a typed code would dress an internal miswiring
 * up as an answer the caller could act on. A head ref that no longer resolves
 * and a range that can no longer be counted are ORDINARY REPOSITORY STATES — a
 * branch deleted after its review was created, a merge base rewritten or pruned
 * away between two syncs — and each throws a typed `ApiError`, because a bare
 * error escaping to the transport's terminal catch-all is answered as an
 * unreachable broker on a daemon that has no broker at all.
 */
async function resolveLocalHead(
  deps: LocalReviewSurfaceDeps,
  localId: number,
): Promise<{ sha: string; commitCount: number }> {
  const review = deps.store.getLocalReview(localId)
  if (review === null || review.repo !== deps.repo) {
    throw new Error(
      `local review ${localId} has no row in this surface's repository to resolve a head against`,
    )
  }
  const { mergeBaseSha } = review
  if (mergeBaseSha === null) {
    throw new Error(
      `local review ${localId} has no recorded merge base, so its reviewed range cannot be counted`,
    )
  }

  const tip = await runGit(deps.runner, deps.toplevel, {
    args: ['rev-parse', '--verify'],
    revs: [review.headRef],
  })
  const sha = tip.stdout.trim()
  if (!tip.ok || !OBJECT_NAME.test(sha)) {
    throw new ApiError(
      'not_found',
      `The head ref ${review.headRef} of local review ${localId} did not resolve to a commit ` +
        `(git rev-parse exited ${tip.code}). The branch has been deleted or renamed since the ` +
        `review was created; fetch or recreate it, then try again.`,
    )
  }

  const counted = await runGit(deps.runner, deps.toplevel, {
    args: ['rev-list', '--count'],
    revs: [`${mergeBaseSha}..${sha}`],
  })
  const printed = counted.stdout.trim()
  if (!counted.ok || !DECIMAL_COUNT.test(printed)) {
    throw new ApiError(
      'unprocessable',
      `The commits in ${mergeBaseSha}..${sha} for local review ${localId} could not be counted ` +
        `(git rev-list exited ${counted.code}). The recorded merge base may no longer be ` +
        `reachable in this clone; sync the review again, then retry.`,
    )
  }
  return { sha, commitCount: Number.parseInt(printed, 10) }
}

/**
 * The local write port, assembled ONE MEMBER AT A TIME for a single review.
 *
 * Never a spread of the store, and the reason is not style. Two members are
 * named differently on the two sides — the port's `putLocalReviewSummary` is the
 * store's `putLocalSubmittedReview`, and its `nextEntityId` is the store's
 * `nextLocalEntityId` — so a spread type-checks while silently leaving both port
 * members unimplemented. It would also carry the store's whole surface onto a
 * port that deliberately excludes most of it: a draft WRITER, whose absence is
 * what makes "a draft is deleted only on confirmed success" enforceable by shape
 * rather than by discipline; the append-only audit journal, which a local write
 * must never enter because nothing it does reaches a forge; and the
 * pull-request keyspace, whose snapshots and drafts a local review must never be
 * able to touch. The port's whole value is being a short, pinnable list of
 * names, and only writing the names out preserves it.
 *
 * Built per call rather than once per surface because head resolution is scoped
 * to one review: it needs that review's head ref and its recorded merge base.
 */
export function buildLocalWriteDeps(
  deps: LocalReviewSurfaceDeps,
  localId: number,
): LocalWriteDeps {
  const { store } = deps
  return {
    // The one member here that is translated, and translating it is what makes
    // the four write verbs answer a data directory that lost its content the way
    // the read verbs already do — a `not_found` naming the re-sync that rebuilds
    // it — instead of the store's corruption error, which the transport reports
    // as a broken daemon. All four reach the snapshot through this member, a
    // submit twice and the other three once each, so there is one place to
    // translate rather than four that must be kept in step.
    //
    // ONLY THE READ IS WRAPPED, and a wrapper around a whole verb would look
    // equivalent without being it. The durable store re-raises an unreadable row
    // out of a WRITE unchanged, on the ground that a corrupt row is not the same
    // failure as a mutation that never reached disk — so a snapshot write refused
    // because the immutable row it has to carry forward is corrupt would be
    // translated too. Answering "not found, re-sync to rebuild" there is false
    // twice over: a submit has already written its threads and its summary by
    // that point, and a reader told nothing was found resubmits and gets both a
    // second time.
    getLocalSnapshot: (id) => rebuildable(id, () => store.getLocalSnapshot(id)),
    // Untranslated: the row is not content a re-sync rebuilds, and the sink
    // reads it for one field — whether a pull request has superseded the
    // review — ahead of every mutation. Ownership was settled by the guard
    // that let the verb reach the sink at all, so the id here names a row this
    // repository owns.
    getLocalReview: (id) => store.getLocalReview(id),
    putLocalSnapshot: (snapshot) => {
      store.putLocalSnapshot(snapshot)
    },
    putLocalThread: (id, thread) => {
      store.putLocalThread(id, thread)
    },
    putLocalReviewSummary: (id, review) => {
      store.putLocalSubmittedReview(id, review)
    },
    getLocalDraft: (who, id) => store.getLocalDraft(who, id),
    deleteLocalDraft: (who, id) => {
      store.deleteLocalDraft(who, id)
    },
    session: deps.session,
    resolveHead: () => resolveLocalHead(deps, localId),
    nextEntityId: () => store.nextLocalEntityId(),
    now: clockOf(deps),
  }
}

/**
 * The typed refusal a branch pair that cannot be resolved answers with. Each one
 * names the specific cause and, where a fix exists, the fix.
 *
 * TWO CODES, AND THE LINE BETWEEN THEM. A ref that resolves to nothing is a
 * not-found: the thing being named does not exist, and no state the caller could
 * put this repository into makes the same request satisfiable without first
 * bringing that branch into being. The other three are unprocessable, which is
 * the code for a target that DOES exist in a state the request cannot be
 * satisfied against — one ref given twice, two histories with no ancestor
 * between them, an ancestor that a shallow clone simply has not fetched — and
 * for each of those the caller can reach a state where the identical request
 * succeeds. Collapsing the two would leave a client unable to tell "that branch
 * is gone" from "that pair cannot be compared".
 */
function rangeRefusal(localId: number, failure: LocalRangeFailure): ApiError {
  switch (failure.reason) {
    case 'ref_not_found':
      return new ApiError(
        'not_found',
        `Local review ${localId} names ${failure.refs.join(' and ')}, which did not resolve to ` +
          `a commit in this repository (git exited ${failure.code}). Fetch or create the branch, ` +
          `then sync again.`,
      )
    case 'same_ref':
      return new ApiError(
        'unprocessable',
        `Local review ${localId} compares ${failure.baseRef} against ${failure.headRef}, and ` +
          `both are at ${failure.sha} — there is nothing to review.`,
      )
    case 'unrelated_histories':
      return new ApiError(
        'unprocessable',
        `${failure.baseRef} and ${failure.headRef} share no common ancestor, so there is no ` +
          `range for local review ${localId} to cover.`,
      )
    case 'shallow_clone':
      return new ApiError(
        'unprocessable',
        `${failure.baseRef} and ${failure.headRef} have no common ancestor in this SHALLOW ` +
          `clone, which most likely means the ancestor was never fetched. Deepen the clone, ` +
          `then sync local review ${localId} again.`,
      )
  }
}

/** The typed refusal a git read that produced nothing usable answers with. */
function readRefusal(
  localId: number,
  failure: MalformedDiff | DiffFailed | MalformedCommitLog | CommitLogFailed,
): ApiError {
  const detail = 'detail' in failure ? failure.detail : `the command exited ${failure.code}`
  return new ApiError(
    'unprocessable',
    `Local review ${localId} could not be read from this repository (${failure.reason}): ${detail}.`,
  )
}

/**
 * The default branch this repository's synthesized pull reports on both sides,
 * or the empty string when the repository marks none.
 *
 * A REPOSITORY WITH NO ORIGIN MARKS NOTHING, and that is the ordinary state of
 * the clone this whole path exists for: the marker is derived from origin's
 * symbolic HEAD, a ref that simply does not exist without an origin. The empty
 * string is therefore the answer rather than a fallback of any kind — it is the
 * same spelling the hosted mappers use for a default branch they were not told,
 * so nothing downstream has to tell two flavours of "unknown" apart. Guessing
 * the base ref, or a conventional name, would put a branch name in front of a
 * reader that nothing in the repository actually claims.
 *
 * The first marked entry wins rather than exactly one being required: the
 * listing applies its marker by exact ref match, and taking the first keeps this
 * honest even if a listing ever came back with more than one marked.
 */
async function readDefaultBranchName(deps: LocalReviewSurfaceDeps): Promise<string> {
  let branches: BranchRef[]
  try {
    branches = await listGitBranches(deps.runner, deps.toplevel)
  } catch (cause) {
    // Translated rather than propagated raw: a bare error escaping a sync
    // reaches the transport's terminal catch-all, which reports that a broker
    // could not be reached — a claim about infrastructure this daemon does not
    // have. Not degraded to the empty string either: an unreadable repository is
    // a different fact from a repository that marks no default, and the sync it
    // is failing has already read the range it was going to describe.
    throw new ApiError(
      'unprocessable',
      `The default branch of ${deps.toplevel} could not be read, because its branches could ` +
        `not be listed. (${cause instanceof Error ? cause.message : String(cause)})`,
    )
  }
  return branches.find((branch) => branch.isDefault)?.name ?? ''
}

/**
 * Validate one side of a requested branch pair and return it fully qualified.
 *
 * Three screens in a fixed order, and the order is what makes them meaningful.
 * The shared syntactic check runs FIRST, because it is the one that rejects a
 * dash-leading name — a value git would read as a flag, and which no later check
 * can safely be handed. Qualification comes next, producing a `refs/…` name that
 * cannot begin with a dash whatever it started as. Real git is asked last and is
 * the authority: a handful of its rules are not checkable without it, and it is
 * only safe to ask once the value in hand is qualified.
 */
async function qualifyRef(
  deps: LocalReviewSurfaceDeps,
  side: 'base' | 'head',
  input: string,
): Promise<string> {
  if (!isValidRefName(input)) {
    throw new ApiError(
      'unprocessable',
      `The ${side} ref ${JSON.stringify(input)} is not a valid git ref name.`,
    )
  }
  const ref = normalizeRefName(input)
  const verdict = await checkRefFormat(deps.runner, deps.toplevel, ref)
  if (!verdict.ok) {
    throw new ApiError(
      'unprocessable',
      `git rejected the ${side} ref ${JSON.stringify(ref)} as malformed ` +
        `(check-ref-format exited ${verdict.code}).`,
    )
  }
  return ref
}

/**
 * Assemble the operations a locally created review supports over one repository,
 * one store and one session.
 *
 * WHAT THIS OWNS THAT NOTHING ELSE DOES. Two values have a declared field, a
 * consumer, and no other producer anywhere: the head resolution the write sink
 * awaits, and the default branch the synthesized pull reports on both sides.
 * Both are built here, and for both the SCOPE of the answer is part of its
 * meaning rather than an implementation detail — the two helpers above state
 * what each scope is and what the wrong one would silently claim.
 *
 * THE READ AND WRITE HALVES SHARE NO MACHINERY BEYOND THE STORE AND THE RUNNER.
 * The write half never sees the runner: head resolution reaches it as an already
 * resolved function, so the sink spawns nothing and cannot grow a code path that
 * does. The read half never sees a hosted client, because none exists in this
 * object to pass on.
 *
 * EVERY ID-KEYED VERB RESOLVES ITS REVIEW THROUGH THE SAME OWNERSHIP GUARD
 * BEFORE TOUCHING ANYTHING ELSE. The store is shared by every repository using
 * the data directory and every id-keyed store method reads by id alone, so a
 * verb that went to the store directly would answer for a review some OTHER
 * repository owns — resolve that review's refs against this repository's
 * toplevel, stamp this repository's SHAs onto its row, and land durable threads
 * under its id. The guard is one function and the rule is that nothing below
 * bypasses it: reads and writes alike, including the verbs whose store read
 * would happen to come back empty anyway, because "empty for the wrong
 * repository" and "empty for this one" must not be distinguishable answers.
 */
/**
 * Runs a SNAPSHOT read and turns the store's corruption error into an answer the
 * reader can act on: a `not_found` naming the re-sync that rebuilds it.
 *
 * The store is right to throw. Its envelope names a compare key with no
 * immutable row, and returning a snapshot with an empty immutable half would
 * report a broken store as an ordinary one — so it must not be softened, and a
 * test asserts it still throws when called directly.
 *
 * But the two states that produce that throw are not equally hopeless. A
 * genuinely corrupt row and a data directory that was moved, restored from a
 * partial backup, or pruned out from under a review are indistinguishable at
 * the store, and the second is repaired completely by syncing again. Answering
 * a 500 for both tells the reader their daemon is broken when their review is
 * one command from working. So the throw is kept and translated here, at the
 * edge, where "re-sync to rebuild" is a thing a client can render and act on.
 *
 * WRAP ONLY A READ OF CONTENT A RE-SYNC CAN REBUILD. The message this helper
 * mints makes two promises, and both are false the moment it is widened past
 * that: it names re-syncing as the remedy, and it promises that drafts, threads
 * and viewed marks were not touched. A snapshot read earns both — a sync
 * upserts the envelope row and the immutable half it names, and neither is
 * anything a human typed. A draft read earns neither: nothing reconstructs
 * unsubmitted text from a repository, and the message would be reassuring the
 * reader about the very row that is corrupt. A blob read fails the first
 * promise on its own, since provisioning skips SHAs already present and the
 * insert does nothing on conflict, so a corrupt blob row outlives every sync.
 * Those failures are honest `StoreUnreadableError`s: the store really is
 * corrupt and the operator has to repair the row.
 *
 * The same rule excludes WRITES, for a reason of its own. The store re-raises
 * an unreadable row out of a write unchanged — a corrupt row and a mutation
 * that never reached disk are different failures and a caller answers them
 * differently — so a write refused on that ground would be turned into "nothing
 * was found here" for a verb that may already have persisted part of what it
 * was asked to write.
 *
 * WRAP THE READ, NEVER THE VERB THAT MAKES IT. A verb reads several things, and
 * a wrapper placed outside it cannot tell which read failed — it would re-label
 * a draft or a blob failure with the snapshot's remedy. Wrapped around the read
 * itself, whether that read sits in a verb or behind a port another module
 * calls through, the translation reaches exactly what it is about.
 */
function rebuildable<T>(localId: number, read: () => T): T {
  try {
    return read()
  } catch (cause) {
    if (cause instanceof StoreUnreadableError) {
      throw new ApiError(
        'not_found',
        `The stored content for local review #${localId} is no longer in this data directory, ` +
          'so it cannot be opened. Re-sync it to rebuild from the repository. Nothing written ' +
          'against it — drafts, threads, viewed marks — has been touched.',
      )
    }
    throw cause
  }
}

export function createLocalReviewSurface(deps: LocalReviewSurfaceDeps): LocalReviewSurface {
  const { store } = deps
  const humanId = deps.session.human.id
  const now = clockOf(deps)

  /**
   * The stored snapshot, or null when there is none OR when the store cannot
   * read the one it has. Used by the freeze alone, which is the one reader for
   * whom an unreadable snapshot and a missing one call for the same move — a
   * full sync that rebuilds it — rather than for the not-found that every
   * other snapshot read translates the corruption into.
   */
  const storedIfReadable = (localId: number): Snapshot | null => {
    try {
      return store.getLocalSnapshot(localId)
    } catch (cause) {
      if (cause instanceof StoreUnreadableError) return null
      throw cause
    }
  }

  /**
   * Reconcile's three reads, re-pointed at the local keyspace.
   *
   * The classification itself is NOT reimplemented here. It is the same module a
   * review of a pull request runs, reached through this adapter, because a
   * second copy of that logic would be the worst divergence this codebase could
   * carry: the report it produces is what a human reads before deciding whether
   * their unsubmitted comments still say what they meant, and two
   * implementations would disagree in exactly the cases hardest to notice.
   */
  const reconcileStore: ReconcileStore = {
    // Untranslated, and that is the point: this read is the DRAFT, and a draft
    // is the one thing in this store nothing can rebuild. Telling a reader whose
    // draft row is corrupt to re-sync would name a remedy that does not exist —
    // no sync reconstructs unsubmitted text from a repository — and the same
    // message goes on to promise that drafts were not touched, which is exactly
    // backwards when the draft is the corrupt thing. A corrupt draft row is a
    // genuinely corrupt store, so it travels as `StoreUnreadableError` and the
    // operator is told to repair the row.
    getDraft: (who, localId) => store.getLocalDraft(who, localId),
    // Translated, because this read is the SNAPSHOT: derived content that one
    // sync rewrites in full — both the envelope row and the immutable half it
    // names are upserted — so "re-sync to rebuild" is advice that works. The
    // same wiring the write port and the snapshot verb already carry: each of
    // the three places this store's snapshot read leaves the surface wraps that
    // read alone, and nothing wider.
    getSnapshot: (localId) => rebuildable(localId, () => store.getLocalSnapshot(localId)),
    // Untranslated for the same reason as the draft, arrived at differently: a
    // blob row that is present but unparseable survives a sync untouched,
    // because provisioning skips every SHA already in the content-addressed
    // table and the insert that would replace it does nothing on conflict.
    // Re-syncing is not a remedy for it, so it must not be offered as one.
    getBlob: (sha) => store.getBlob(sha),
    // The same content-addressed table `getBlob` reads. Blobs are shared
    // between both producers, so there is one existence question and one
    // answer to it.
    hasBlob: (sha) => store.hasBlob(sha),
  }

  return {
    async createLocalReview(input: CreateLocalReviewInput): Promise<LocalReviewSummary> {
      const baseRef = await qualifyRef(deps, 'base', input.baseRef)
      const headRef = await qualifyRef(deps, 'head', input.headRef)
      // Compared AFTER qualification, so a bare name and its fully qualified
      // spelling are recognised as one ref rather than recorded as a pair with
      // nothing between its two sides.
      if (baseRef === headRef) {
        throw new ApiError(
          'unprocessable',
          `The base and head refs both resolve to ${headRef} — a review needs two different sides.`,
        )
      }
      const requested = input.title?.trim() ?? ''
      // No SHA is resolved here. A review records a branch PAIR, and the commits
      // behind that pair are whatever they are at each sync; resolving them now
      // would record a range the review does not yet claim to cover. Creation is
      // idempotent per pair in the store, so a retried request returns the
      // review that already exists rather than minting a second.
      return store.createLocalReview({
        repo: deps.repo,
        baseRef,
        headRef,
        title: requested.length > 0 ? requested : shortRefName(headRef),
      })
    },

    listLocalReviews(): LocalReviewSummary[] {
      return store.listLocalReviews(deps.repo)
    },

    getLocalReview(localId: number): LocalReviewSummary {
      return requireReview(deps, localId)
    },

    async listBranches(): Promise<BranchRef[]> {
      // A git read, never a store read: the store records reviews, and a branch
      // that has never been reviewed still has to be offerable as a side.
      //
      // A failure is TRANSLATED, never swallowed. The git layer refuses an
      // unreadable repository with a bare error, and a bare error escaping this
      // surface reaches the transport's terminal catch-all, which answers that a
      // broker could not be reached — on a daemon that has neither a broker nor
      // a hosted repository, the single most misleading thing this path could
      // say. What the translation must NOT do is turn the failure into an empty
      // list: an unreadable repository and a repository with no branches at all
      // are different facts, and the empty list is the truthful answer to only
      // one of them.
      try {
        return await listGitBranches(deps.runner, deps.toplevel)
      } catch (cause) {
        throw new ApiError(
          'unprocessable',
          `The branches of ${deps.toplevel} could not be listed. Check that the path is a ` +
            `readable git repository, then ask again. (${
              cause instanceof Error ? cause.message : String(cause)
            })`,
        )
      }
    },

    async syncPull(localId: number): Promise<Snapshot> {
      return (await this.syncLocalReview(localId)).snapshot
    },

    async syncLocalReview(localId: number): Promise<LocalSyncOutcome> {
      const review = requireReview(deps, localId)

      // THE FREEZE. A review a pull request has superseded stands at its last
      // sync: the stored snapshot is answered as it is, no git is run, no half
      // is minted, no pin is written and the row is not re-stamped. What a
      // reader sees is the branch pair as it stood when the pull request was
      // found, not as it stands now.
      //
      // The freeze keys on the stored snapshot AGREEING with the row — an
      // envelope whose synthesized pull already reads `closed` — and not on
      // the row alone. The pull's state is derived from the archive number at
      // the moment the envelope is built, so `closed` says precisely that the
      // snapshot postdates the archive. A row marked while the stored snapshot
      // still reads `open` has therefore been archived SINCE its last sync —
      // by the detection that runs ahead of this call, by another daemon over
      // the same data directory, or by hand — and gets exactly one more full
      // sync so that the snapshot it freezes at describes the review as the
      // row does; the sync after that is frozen. Keying on the row alone would
      // freeze such a review onto a snapshot still claiming `open`, with
      // nothing left to ever rewrite it.
      //
      // A stored snapshot that cannot be read counts as absent here for the
      // same reason an absent one does: the repair every snapshot read names
      // is re-syncing, and a freeze that served nothing readable would take
      // that repair away from exactly the reviews that can never be re-synced
      // by hand.
      if (review.archivedPr !== null) {
        const stored = storedIfReadable(localId)
        if (stored !== null && stored.mutable.pull.state === 'closed') {
          return { frozen: true, snapshot: stored, pin: null }
        }
      }

      const resolved = await resolveLocalRange(deps.runner, deps.toplevel, {
        baseRef: review.baseRef,
        headRef: review.headRef,
      })
      if (!resolved.ok) throw rangeRefusal(localId, resolved)
      const { range } = resolved

      // Pinned BEFORE the first object is read, and the ordering is the whole
      // point. The diff produces the blob names and the cat-file reads fetch
      // their bytes; a collection landing between the two turns every one of
      // those names into a missing entry, with no hosted tier able to supply
      // them. Pinning first closes that window. Pinning afterwards would leave
      // it exactly as wide as it is now.
      //
      // The outcome is carried, never thrown: the objects are demonstrably
      // present — the snapshot below is built from them — so a review whose pin
      // failed is completely readable today and merely unguaranteed tomorrow.
      const pinned = await pinSnapshotObjects(deps.runner, deps.toplevel, localId, {
        mergeBaseSha: range.mergeBaseSha,
        headSha: range.headSha,
      })
      const pin: LocalPinOutcome = pinned.ok
        ? { ok: true }
        : { ok: false, reason: pinned.reason }

      const built = await readLocalSnapshotImmutable(deps.runner, deps.toplevel, range)
      if (!built.ok) throw readRefusal(localId, built)
      const { immutable } = built.snapshot

      // The hosted client and the repository it would address are OMITTED, not
      // passed as undefined values a branch might later read: with no hosted
      // tier present at all, an object the clone cannot produce is reported by
      // name in `partial` instead of being fetched over a network this path must
      // never touch.
      const blobs = await provisionBlobs(
        { store, runner: deps.runner, cwd: deps.toplevel },
        immutable.blobIndex,
      )

      const worktree = await detectDirtyWorktree(deps.runner, deps.toplevel)
      const defaultBranch = await readDefaultBranchName(deps)
      // The repository's own display name when it records one. The session's is
      // the fallback rather than a fabricated string, because this value is
      // rendered and an invented name is indistinguishable from a real one.
      const authorName =
        (await readLocalAuthorName(deps.runner, deps.toplevel)) ?? deps.session.human.name

      // Read AFTER every await above, so a write that landed while git was being
      // read is not republished away by the envelope written below.
      // The authorship map is read on its own rather than off a whole snapshot.
      // A re-sync is the documented repair for a data directory that lost its
      // immutable rows, and the full read throws in exactly that state — so
      // taking the map from it would make the repair impossible to perform, or,
      // if softened, would make it destroy the one field it cannot rebuild.
      const previousCommentAuthors = store.getLocalCommentAuthors(localId)
      const threads = store.listLocalThreads(localId)
      const reviewComments = threads.reduce((total, thread) => total + thread.comments.length, 0)

      const pull = synthesizeLocalPullDetail({
        review: {
          id: review.id,
          repo: review.repo,
          defaultBranch,
          baseRef: review.baseRef,
          headRef: review.headRef,
          title: review.title,
          archivedPr: review.archivedPr,
          createdAt: review.createdAt,
          updatedAt: review.updatedAt,
        },
        authorName,
        range,
        immutable,
        reviewComments,
      })

      const syncedAt = now()
      const snapshot: Snapshot = {
        prNumber: localId,
        syncedAt,
        partial:
          blobs.missing.length === 0
            ? null
            : {
                missingBlobShas: [...blobs.missing],
                reason:
                  `${blobs.missing.length} blob(s) could not be produced by this git clone, ` +
                  'and nothing else can supply them; re-sync once the objects are reachable again.',
              },
        // Not one request is spent anywhere on this path, so the count is zero
        // as a measured fact rather than as a field nobody filled in.
        syncStats: {
          blobsFetched: blobs.stats.blobsFetched,
          blobsReused: blobs.stats.blobsReused,
          requests: 0,
        },
        immutable,
        mutable: {
          fetchedAt: syncedAt,
          pull,
          // The durable thread table is the source: threads outlive any one
          // snapshot, and rebuilding the list from anywhere else would drop
          // every thread written since the previous envelope.
          threads,
          // Both permanently empty on a local review. A submitted summary is
          // stored in its own table and never appended here, and there is no
          // conversation tab for an issue comment to live on. Several surfaces
          // read these two being empty as "this review has only threads".
          issueComments: [],
          reviews: [],
          checks: [],
          // Carried forward, because this map has no other durable home. It is
          // the only signal that can decide whether a local comment is the
          // reader's own — nothing is stamped into a body, and no forge login
          // stands behind a synthesized author — so a comment whose entry is
          // dropped here can never be attributed by anything again.
          commentAuthors: previousCommentAuthors,
        },
      }

      store.putLocalSnapshot(snapshot)
      store.patchLocalReviewSync(localId, {
        baseSha: range.baseSha,
        mergeBaseSha: range.mergeBaseSha,
        headSha: range.headSha,
        // The column holds a flag while the reading has three states, so the
        // collapse is decided here in the open: only a positive reading sets it.
        // The claim the flag makes is "there is work here the review does not
        // cover", and a probe that could not be answered is not evidence for
        // that claim — asserting it would raise the warning on every repository
        // whose worktree cannot be inspected at all.
        dirty: worktree === 'dirty',
        lastSyncedAt: syncedAt,
      })
      return { frozen: false, snapshot, pin }
    },

    getSnapshot(localId: number): Snapshot | null {
      // The null below is reserved for a review THIS repository owns that has
      // never been synced; an id it does not own is refused before the read,
      // exactly as an absent one is.
      requireReview(deps, localId)
      return rebuildable(localId, () => store.getLocalSnapshot(localId))
    },

    getDraft(localId: number): ReviewDraft | null {
      requireReview(deps, localId)
      return store.getLocalDraft(humanId, localId)
    },

    saveDraft(draft: ReviewDraft): ReviewDraft {
      requireReview(deps, draft.prNumber)
      // Rebuilt around the session's human rather than stored as it arrived.
      // Ownership never comes from the body: a draft is the single most private
      // thing this store holds, and a client-supplied id that survived to here
      // would write into somebody else's key.
      const stored: ReviewDraft = { ...draft, humanId }
      store.putLocalDraft(stored)
      return stored
    },

    discardDraft(localId: number): void {
      // Deleting an absent DRAFT stays a no-op; an absent or foreign REVIEW is
      // still refused, so the id space this verb will touch at all is exactly
      // the one every other verb answers for.
      requireReview(deps, localId)
      store.deleteLocalDraft(humanId, localId)
    },

    reconcileDraft(localId: number): ReconcileReport {
      requireReview(deps, localId)
      // Undecorated on purpose. Reconcile reads the snapshot too, so it meets
      // the same absence and owes the same answer — but the translation belongs
      // to that one read and is wired into `reconcileStore.getSnapshot`, not
      // wrapped around the delegate. Reconcile reads the DRAFT first and blobs
      // after, and neither is content a re-sync rebuilds; a wrapper out here
      // could not tell those failures apart from the snapshot's and would answer
      // all three with a remedy that works for only one.
      return runReconcileDraft({ store: reconcileStore, humanId }, localId)
    },

    getFileViewed(localId: number): FileViewedState {
      requireReview(deps, localId)
      return store.getLocalViewed(humanId, localId)
    },

    setFileViewed(
      localId: number,
      path: string,
      viewed: boolean,
      blobSha: string | null,
    ): FileViewedState {
      requireReview(deps, localId)
      const state = store.getLocalViewed(humanId, localId)
      state[path] = { viewed, blobSha, at: now() }
      store.setLocalViewed(humanId, localId, state)
      return state
    },

    // The four write verbs check ownership HERE, before the sink runs: the
    // write port deliberately carries no repository identity, so the sink
    // cannot make this check and must never be handed an id that failed it.
    // Each is `async` so the guard's refusal arrives as a rejection, the only
    // failure shape a promise-returning method's callers are set up to catch.
    async submitReview(input: SubmitReviewInput): Promise<SubmitResult> {
      requireReview(deps, input.prNumber)
      return submitLocalReview(buildLocalWriteDeps(deps, input.prNumber), input)
    },

    async replyToThread(localId: number, threadId: string, body: string): Promise<ReviewComment> {
      requireReview(deps, localId)
      return replyToLocalThread(buildLocalWriteDeps(deps, localId), localId, threadId, body)
    },

    async resolveThread(
      localId: number,
      threadId: string,
      resolved: boolean,
    ): Promise<ReviewThread> {
      requireReview(deps, localId)
      return resolveLocalThread(buildLocalWriteDeps(deps, localId), localId, threadId, resolved)
    },

    async addReaction(
      localId: number,
      commentId: number,
      reaction: ReactionKey,
    ): Promise<ReactionRollup> {
      requireReview(deps, localId)
      return addLocalReaction(buildLocalWriteDeps(deps, localId), localId, commentId, reaction)
    },

    listThreads(localId: number): ReviewThread[] {
      requireReview(deps, localId)
      return store.listLocalThreads(localId)
    },
  }
}
