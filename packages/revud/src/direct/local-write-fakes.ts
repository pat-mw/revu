/**
 * In-memory test support for the local write path: a Map-backed stand-in for
 * durable local storage, a counting id allocator, a fixed head resolver, and
 * builders for the documents a local review is answered against.
 *
 * Test-support code — imported only by `*.test.ts`, never reachable from a live
 * daemon — with the same standing as the throwing GitHub client stubs the remote
 * write tests spread in. Unlike those, nothing here constructs a client of any
 * kind: the local write port has nowhere to put one, so there is nothing to stub
 * and no seam to fill, and that absence is itself part of what the local write
 * tests assert. Its whole import surface is the shared contract types plus the
 * port it implements.
 *
 * READS HAND OUT COPIES, AND WRITES STORE COPIES. Every method that returns a
 * document returns a structural clone, and every method that takes one keeps a
 * clone rather than the caller's object. This is not tidiness; it is the
 * property every persistence assertion written against this store rests on.
 * Those assertions have the form "the snapshot read AFTER the write already
 * carries the new threads". If a read handed back the object the store still
 * holds, a writer mutating that object in place would satisfy the read whether
 * or not any write method was ever reached — the assertion would pass with
 * nothing persisted, and a whole suite of green would be measuring nothing.
 * Storing a clone closes the mirror image of the same hole: a caller that kept
 * the document it wrote could otherwise keep editing stored state afterwards,
 * with no write call to attribute the change to.
 *
 * The clone is a FULL structural clone, not a top-level copy. The documents a
 * write touches nest three and four deep — a thread inside the snapshot's
 * mutable half, a comment inside the thread, a rollup inside the comment, a
 * blob pair inside the immutable index — and a shallow copy would alias every
 * one of those while still passing for a fresh object at the top, which is
 * precisely the depth where the writes happen.
 *
 * Threads are kept as their own rows keyed by thread id and recomposed into the
 * snapshot a read returns. That is what lets a single-thread write and a
 * whole-envelope write agree: an upsert replaces the row for that id, so neither
 * route can leave one thread stored twice, and a row written for a review whose
 * snapshot was never stored is still readable through the thread read-back
 * rather than silently accepted and lost.
 */
import type {
  GhUser,
  LocalReviewSummary,
  PullDetail,
  ReactionRollup,
  ReviewComment,
  ReviewDraft,
  ReviewSummary,
  ReviewThread,
  Snapshot,
} from '@revu/shared'
import { LOCAL_ENTITY_ID_BASE } from '@revu/shared'
import type { LocalWriteStore } from './local-writes'

/**
 * A structural clone. Named for the reason it exists rather than for the call it
 * makes: everything crossing this store's boundary is copied, in both
 * directions, so no assertion about persistence can be satisfied by two names
 * for one object.
 */
function copy<T>(document: T): T {
  return structuredClone(document)
}

/** A zeroed reaction rollup — the shape a comment carrying no reactions holds. */
export function zeroedReactions(): ReactionRollup {
  return {
    url: '',
    total_count: 0,
    '+1': 0,
    '-1': 0,
    laugh: 0,
    hooray: 0,
    confused: 0,
    heart: 0,
    rocket: 0,
    eyes: 0,
  }
}

/**
 * The author a SEEDED comment carries. Fixture data, not a contract: the
 * sentinel user a local write mints for the comments it creates belongs to the
 * write path, and this login is deliberately unlike anything that path would
 * produce so an assertion about the minted sentinel cannot pass by matching
 * seeded fixture data instead.
 */
export const SEEDED_AUTHOR: GhUser = {
  login: 'Seeded Author',
  id: 1,
  node_id: 'seeded-author',
  avatar_url: '',
  html_url: '',
  type: 'Bot',
}

/** Defaults a seed leaves unstated, kept in one place so seeds stay short. */
const DEFAULT_PATH = 'src/a.ts'
const DEFAULT_LINE = 3
const DEFAULT_MERGE_BASE_SHA = '0'.repeat(40)

/** One comment of a seeded thread. Everything not stated is derived or defaulted. */
export interface LocalCommentSeed {
  readonly id: number
  readonly body?: string
  /**
   * The submitted review this comment was created by, which a reply to the
   * thread carries forward. `null` for a comment that belongs to no review.
   */
  readonly reviewId?: number | null
  /** Reactions already on the comment; zeroed when unstated. */
  readonly reactions?: ReactionRollup
}

/**
 * One thread of a seeded local review. The comments' own `path`, `line`, `side`
 * and `subject_type` are derived from the thread's, mirroring how the read path
 * pushes a thread's location onto every comment it holds, so a seeded thread is
 * internally consistent and a reply derived from its first comment lands on the
 * same lines the thread claims.
 */
export interface LocalThreadSeed {
  readonly id: string
  readonly comments: readonly LocalCommentSeed[]
  readonly isResolved?: boolean
  readonly isOutdated?: boolean
  readonly resolvedBy?: { login: string } | null
  readonly path?: string
  readonly line?: number | null
  readonly diffSide?: 'LEFT' | 'RIGHT'
  readonly subjectType?: 'LINE' | 'FILE'
}

/** A whole seeded local review snapshot: the state a write starts from. */
export interface LocalSnapshotSeed {
  /** The local review the snapshot belongs to; carried as its `prNumber`. */
  readonly localId: number
  readonly headSha: string
  /** Every timestamp the built document carries. Required, so there is exactly one clock. */
  readonly at: string
  readonly mergeBaseSha?: string
  readonly threads?: readonly LocalThreadSeed[]
  readonly commentAuthors?: Readonly<Record<number, string>>
  /** Paths carried by `immutable.files` and `immutable.blobIndex`. */
  readonly paths?: readonly string[]
}

function localComment(
  seed: LocalCommentSeed,
  on: {
    path: string
    line: number | null
    diffSide: 'LEFT' | 'RIGHT'
    subjectType: 'LINE' | 'FILE'
    headSha: string
    at: string
  },
): ReviewComment {
  return {
    id: seed.id,
    node_id: `seeded-comment-${seed.id}`,
    pull_request_review_id: seed.reviewId ?? null,
    path: on.path,
    diff_hunk: '@@ -1,1 +1,1 @@\n-was\n+is\n',
    commit_id: on.headSha,
    original_commit_id: on.headSha,
    line: on.line,
    original_line: on.line,
    start_line: null,
    original_start_line: null,
    side: on.diffSide,
    start_side: null,
    subject_type: on.subjectType === 'FILE' ? 'file' : 'line',
    user: SEEDED_AUTHOR,
    body: seed.body ?? `Seeded comment ${seed.id}.`,
    created_at: on.at,
    updated_at: on.at,
    reactions: seed.reactions ?? zeroedReactions(),
    html_url: '',
  }
}

/** One seeded thread, with its comments derived from its own location. */
export function localThread(
  seed: LocalThreadSeed,
  on: { headSha: string; at: string },
): ReviewThread {
  const path = seed.path ?? DEFAULT_PATH
  const line = seed.line === undefined ? DEFAULT_LINE : seed.line
  const diffSide = seed.diffSide ?? 'RIGHT'
  const subjectType = seed.subjectType ?? 'LINE'
  return {
    id: seed.id,
    isResolved: seed.isResolved ?? false,
    isOutdated: seed.isOutdated ?? false,
    path,
    line,
    originalLine: line,
    startLine: null,
    originalStartLine: null,
    diffSide,
    startDiffSide: null,
    subjectType,
    resolvedBy: seed.resolvedBy ?? null,
    comments: seed.comments.map((comment) =>
      localComment(comment, { path, line, diffSide, subjectType, headSha: on.headSha, at: on.at }),
    ),
  }
}

/**
 * The synthetic pull half of a seeded local snapshot.
 *
 * FILLER, and nothing may assert on it. No local write verb reads this half —
 * the verbs work on `mutable.threads`, `mutable.commentAuthors` and the draft —
 * and what a real local review's pull detail carries is the snapshot producer's
 * to define. It is written out in full rather than cast from an empty object so
 * the seeded document is a complete, well-formed snapshot: a partial one typed
 * as whole would read fine here and fail in whatever first walks it.
 */
function localPull(seed: {
  localId: number
  headSha: string
  mergeBaseSha: string
  at: string
  paths: readonly string[]
  reviewComments: number
}): PullDetail {
  const repo = { full_name: 'local/repo', default_branch: 'main' }
  return {
    id: seed.localId,
    node_id: `seeded-local-review-${seed.localId}`,
    number: seed.localId,
    state: 'open',
    draft: false,
    merged_at: null,
    title: `Seeded local review ${seed.localId}`,
    body: null,
    user: SEEDED_AUTHOR,
    labels: [],
    requested_reviewers: [],
    head: { ref: 'work', sha: seed.headSha, label: 'work', repo },
    base: { ref: 'main', sha: seed.mergeBaseSha, label: 'main', repo },
    created_at: seed.at,
    updated_at: seed.at,
    merged: false,
    mergeable: null,
    mergeable_state: 'unknown',
    merge_base_sha: seed.mergeBaseSha,
    comments: 0,
    review_comments: seed.reviewComments,
    commits: 1,
    additions: seed.paths.length,
    deletions: 0,
    changed_files: seed.paths.length,
  }
}

/**
 * A complete local review snapshot built from a seed.
 *
 * `mutable.reviews` and `mutable.issueComments` are empty and a seed cannot fill
 * them: a local review has no submitted-review timeline and no conversation-tab
 * comments, and a seed that could populate either would let a test assert
 * against a state the local read path never produces.
 */
export function localSnapshot(seed: LocalSnapshotSeed): Snapshot {
  const mergeBaseSha = seed.mergeBaseSha ?? DEFAULT_MERGE_BASE_SHA
  const paths = seed.paths ?? [DEFAULT_PATH]
  const threads = (seed.threads ?? []).map((thread) =>
    localThread(thread, { headSha: seed.headSha, at: seed.at }),
  )
  const reviewComments = threads.reduce((total, thread) => total + thread.comments.length, 0)
  return {
    prNumber: seed.localId,
    syncedAt: seed.at,
    partial: null,
    syncStats: null,
    immutable: {
      compareKey: `${mergeBaseSha}...${seed.headSha}`,
      mergeBaseSha,
      headSha: seed.headSha,
      files: paths.map((path) => ({
        sha: `${path}@head`,
        filename: path,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -1,1 +1,1 @@\n-was\n+is\n',
      })),
      blobIndex: Object.fromEntries(
        paths.map((path) => [path, { base: `${path}@base`, head: `${path}@head` }]),
      ),
      commits: [],
    },
    mutable: {
      fetchedAt: seed.at,
      pull: localPull({
        localId: seed.localId,
        headSha: seed.headSha,
        mergeBaseSha,
        at: seed.at,
        paths,
        reviewComments,
      }),
      threads,
      issueComments: [],
      reviews: [],
      checks: [],
      commentAuthors: { ...(seed.commentAuthors ?? {}) },
    },
  }
}

/**
 * The store methods `throwOn` may name. Typed as the port's own key union so a
 * misspelled method name is a compile error rather than a failure injection that
 * silently never fires — which would turn every persist-failure case built on it
 * into a second test of the happy path.
 */
export type LocalStoreMethod = keyof LocalWriteStore

export interface FakeLocalStoreOptions {
  /**
   * Review rows present before any write, each keyed by its own `id`. A row is
   * what carries the archive: a seed that names a pull request in `archivedPr`
   * starts the review read-only, and a seed with `null` there starts it live.
   * A review with no row reads as no archive to enforce, which is the state
   * every case that seeds no row has always run in.
   */
  readonly reviews?: readonly LocalReviewSummary[]
  /** Snapshots present before any write, each keyed by its own `prNumber`. */
  readonly snapshots?: readonly Snapshot[]
  /** Drafts present before any write, each keyed by its own `humanId` and `prNumber`. */
  readonly drafts?: readonly ReviewDraft[]
  /**
   * One method that throws instead of doing its work, for the cases that assert
   * a write failure leaves the reviewer's draft where it was. Seeding does not
   * go through it, so a review can start with state a failing write then cannot
   * change.
   */
  readonly throwOn?: LocalStoreMethod
}

/**
 * The port slice plus read-backs for what was written. The read-backs are NOT
 * port members and are not meant to become any: they exist so a test can look at
 * stored state that no port read exposes, and a dependency set built from this
 * store must therefore name the port's members rather than spreading the whole
 * object — which is also what keeps the port's key set exactly the port's.
 */
export interface FakeLocalStore extends LocalWriteStore {
  /** Every summary written for a local review, in write order. */
  listLocalSubmittedReviews(localId: number): ReviewSummary[]
  /**
   * Every thread row held for a local review, in first-written order. Readable
   * whether or not a snapshot envelope was ever stored, so a thread write
   * against a never-synced review is observable rather than lost.
   */
  listLocalThreads(localId: number): ReviewThread[]
  /**
   * Record that a pull request now covers the review's branch pair, exactly as
   * durable storage does it: ONE column of one row, write-once, so a second
   * number never replaces the first; nothing else the review holds is read,
   * rewritten or removed. A review with no row is left alone. This is the
   * mutation the write verbs must observe and refuse on — not a port member,
   * because no write verb archives anything; only a sync does.
   */
  markLocalReviewArchived(localId: number, prNumber: number): void
  /**
   * The whole of the store's state as one string, byte-comparable before and
   * after a call. What a refusal must leave untouched is EVERYTHING — every
   * row, every draft, every summary — and a comparison of the fields a test
   * happened to name would pass over a refusal that wrote somewhere else. Two
   * calls with no write between them serialize identically; a write of any
   * kind changes the string.
   */
  serialize(): string
}

interface LocalReviewRows {
  /** The review row, or null for a review no seed and no mark ever described. */
  review: LocalReviewSummary | null
  /** The snapshot envelope, held with its thread list emptied — threads are rows. */
  envelope: Snapshot | null
  threads: Map<string, ReviewThread>
  summaries: ReviewSummary[]
}

/**
 * Drafts are keyed per human AND per review, exactly as durable storage keys
 * them, so one human's draft is never reachable under another's key. The two
 * parts are joined on a character that can occur in neither an identity nor a
 * number, so no pair of distinct keys can flatten onto one string.
 */
const draftKey = (humanId: string, localId: number): string => `${humanId}\u0000${localId}`

/**
 * A Map-backed local store for the write verbs to be exercised against, with no
 * daemon, no disk and no forge behind it.
 */
export function createFakeLocalStore(options: FakeLocalStoreOptions = {}): FakeLocalStore {
  const reviews = new Map<number, LocalReviewRows>()
  const drafts = new Map<string, ReviewDraft>()

  const rowsFor = (localId: number): LocalReviewRows => {
    const held = reviews.get(localId)
    if (held !== undefined) return held
    const created: LocalReviewRows = {
      review: null,
      envelope: null,
      threads: new Map(),
      summaries: [],
    }
    reviews.set(localId, created)
    return created
  }

  /** Throw when this store was built to fail on `method`, naming it. */
  const failIfConfigured = (method: LocalStoreMethod): void => {
    if (options.throwOn !== method) return
    throw new Error(
      `the fake local store was built to fail on ${method}, and ${method} was called`,
    )
  }

  /**
   * Store an envelope and its threads. Used by both the write method and the
   * seed, so a seeded review can hold no state a write could not have produced.
   */
  const storeSnapshot = (snapshot: Snapshot): void => {
    const rows = rowsFor(snapshot.prNumber)
    const held = copy(snapshot)
    for (const thread of held.mutable.threads) rows.threads.set(thread.id, thread)
    held.mutable.threads = []
    rows.envelope = held
  }

  for (const review of options.reviews ?? []) rowsFor(review.id).review = copy(review)
  for (const snapshot of options.snapshots ?? []) storeSnapshot(snapshot)
  for (const draft of options.drafts ?? []) {
    drafts.set(draftKey(draft.humanId, draft.prNumber), copy(draft))
  }

  return {
    getLocalReview: (localId) => {
      failIfConfigured('getLocalReview')
      const held = reviews.get(localId)?.review
      return held === undefined || held === null ? null : copy(held)
    },
    getLocalSnapshot: (localId) => {
      failIfConfigured('getLocalSnapshot')
      const rows = reviews.get(localId)
      if (rows === undefined || rows.envelope === null) return null
      const answer = copy(rows.envelope)
      answer.mutable.threads = copy([...rows.threads.values()])
      return answer
    },
    putLocalSnapshot: (snapshot) => {
      failIfConfigured('putLocalSnapshot')
      storeSnapshot(snapshot)
    },
    putLocalThread: (localId, thread) => {
      failIfConfigured('putLocalThread')
      rowsFor(localId).threads.set(thread.id, copy(thread))
    },
    putLocalReviewSummary: (localId, review) => {
      failIfConfigured('putLocalReviewSummary')
      rowsFor(localId).summaries.push(copy(review))
    },
    getLocalDraft: (humanId, localId) => {
      failIfConfigured('getLocalDraft')
      const held = drafts.get(draftKey(humanId, localId))
      return held === undefined ? null : copy(held)
    },
    deleteLocalDraft: (humanId, localId) => {
      failIfConfigured('deleteLocalDraft')
      drafts.delete(draftKey(humanId, localId))
    },
    listLocalSubmittedReviews: (localId) => copy(reviews.get(localId)?.summaries ?? []),
    listLocalThreads: (localId) => copy([...(reviews.get(localId)?.threads.values() ?? [])]),
    markLocalReviewArchived: (localId, prNumber) => {
      const held = reviews.get(localId)?.review
      // Write-once, decided on the row as durable storage decides it in the
      // statement's own predicate: a number already standing is the one that
      // stays. A review with no row is a plain no-op, not an error.
      if (held === undefined || held === null || held.archivedPr !== null) return
      held.archivedPr = prNumber
    },
    serialize: () =>
      JSON.stringify({
        reviews: [...reviews.entries()].map(([localId, rows]) => ({
          localId,
          review: rows.review,
          envelope: rows.envelope,
          threads: [...rows.threads.entries()],
          summaries: rows.summaries,
        })),
        drafts: [...drafts.entries()],
      }),
  }
}

/**
 * A strictly increasing id allocator starting AT the local entity band's base,
 * standing in for the durable high-water mark.
 *
 * Every id it issues is positive, safely integral and above the base, which is
 * what keeps a locally minted id out of the negative band the client reserves
 * for the optimistic entries it swaps by id. It holds its counter per allocator
 * rather than per module, so a fresh allocator restarts the sequence — a test
 * that mints through two of them can tell a stateless minter from one carrying a
 * counter of its own.
 */
export function countingEntityIds(): () => number {
  let issued = 0
  return () => {
    const id = LOCAL_ENTITY_ID_BASE + issued
    issued += 1
    return id
  }
}

/**
 * A head resolver that always answers the same branch tip, standing in for the
 * git read the daemon injects. Returning a fixed answer is what makes the head
 * guard's two outcomes reachable from a test: a submit quoting this sha proceeds,
 * one quoting any other is a moved head.
 */
export function fixedHead(
  sha: string,
  commitCount: number,
): () => Promise<{ sha: string; commitCount: number }> {
  return () => Promise.resolve({ sha, commitCount })
}
