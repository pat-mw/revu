import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type {
  FileBlob,
  FileViewedState,
  HumanPreferences,
  LocalReviewSummary,
  ReviewDraft,
  ReviewSummary,
  ReviewThread,
  Snapshot,
  SnapshotImmutable,
} from '@revu/shared'
import {
  DEFAULT_PREFERENCES,
  LOCAL_ENTITY_ID_BASE,
  LOCAL_REVIEW_ID_BASE,
} from '@revu/shared'

/**
 * The durable, disk-backed store for direct mode.
 *
 * Unlike the mock (which persists ONE JSON blob under a `localStorage` key and
 * may swallow write failures for a browser), this store is a real SQLite file
 * on the daemon's disk. Durability is a daemon concern here, so the write path
 * NEVER swallows an error: a failed persist surfaces as a typed `StoreWriteError`
 * so the caller can answer `persist_failed` rather than a success the client
 * would trust as saved. In-memory work is not the model — the disk IS the model.
 *
 * The tables split state by how it is keyed and how long it lives:
 *
 *   - `immutables` — the immutable half of a snapshot, keyed by
 *     `compareKey = merge_base…head` (NOT by head alone), append-only and
 *     cache-forever with no TTL. This is what lets `syncPull` skip the diff/base-
 *     tree/commits work on a warm re-sync of an unchanged comparison.
 *   - `snapshots` — the per-PR assembled snapshot (mutable half + a reference to
 *     the immutable half's compareKey). Overwritten on every sync.
 *   - `blobs` — content-addressed by git blob SHA, append-only, cache-forever,
 *     no TTL: identical SHA ⇒ identical bytes.
 *   - `drafts` — per-human, per-PR review drafts. The irreplaceable local work;
 *     they must survive a version bump and a restart.
 *   - `viewed` — per-human, per-PR per-file viewed state.
 *   - `prefs` — per-human workspace preferences.
 *   - `audit_log` — the APPEND-ONLY journal of writes that reached GitHub under
 *     a shared identity: which human (by `human_id`, the lowercased git-config
 *     email — the email never enters a GitHub body, only this local journal),
 *     which endpoint, which PR, and the GitHub-assigned id. The store API can
 *     only append and read it — no update, no delete — so it stays ground truth
 *     for "who wrote this" even across a workspace-username rename.
 *   - `pr_author` — which human drove the shared bot when a pull request was
 *     opened, keyed by PR number. FIRST-WRITE-WINS: the first record for a PR is
 *     permanent, so a later re-observation never rewrites the original driver.
 *     A `human_id` of NULL records that a real org member opened the PR (not the
 *     bot). Population is a HOST-SIDE concern: revu is a review client and does
 *     not open pull requests, so nothing in the workspace calls `recordPrAuthor`
 *     during normal operation — the host-side collector correlates the workspace
 *     that opened each PR to its driving human and writes this row. The store
 *     surface is the durable seam the poll loop reads through.
 *   - `local_reviews` — one review of a branch pair that has no pull request,
 *     per `(repo, base_ref, head_ref, generation)`. Its id is minted from a
 *     monotonic high-water mark rather than left to the row id, so an id is
 *     never re-issued after a review is removed and a dependent row that
 *     outlived its review can never be adopted by an unrelated one.
 *   - `local_snapshots` — the envelope half of a local review's snapshot. The
 *     immutable half lands in the shared `immutables` table under the same
 *     `compareKey`, so a local review and a pull request over the same
 *     comparison share one stored copy of the expensive half.
 *   - `local_drafts` / `local_viewed` — the per-human, per-local-review twins of
 *     `drafts` and `viewed`. Their composite key names the human first, so
 *     removing everything belonging to one review scans rather than seeks;
 *     recorded here rather than answered with an index nobody has measured a
 *     need for.
 *   - `local_threads` — review threads created against a local review, keyed by
 *     `(local_id, thread_id)` and rewritten in place, so resolving a thread
 *     leaves one row rather than two copies in two states.
 *   - `local_reviews_submitted` — the review summaries submitted against a local
 *     review, keyed by `(local_id, review_id)`.
 *   - `meta` — the `store_version` row that drives migrate-in-place, plus the
 *     monotonic id high-water marks the local keyspace allocates from.
 *
 * The local tables carry a repository identity and the pull-request tables do
 * not, which looks inconsistent until the keys are compared. Two repositories
 * sharing one data directory collide on a pull-request number only when the same
 * number happens to exist in both; they collide on branch names constantly,
 * because `main` and `feature/x` exist in nearly every repository. So the
 * repository is part of the local key from the first row rather than a widening
 * a later migration would have to perform. The store is TOLD that identity — it
 * is `owner/name` for a workspace with a parseable GitHub remote and the
 * repository root's absolute path otherwise — because resolving it needs git,
 * which is not this layer's concern.
 *
 * The local path writes NONE of the three tables whose integer key is a real
 * GitHub pull-request number: `snapshots`, `audit_log` and `pr_author`. The
 * reserved band a local id is minted from keeps it out of the range a pull
 * request could occupy, but that is a convenience for the layers above and never
 * a licence to store a synthetic id in a column that means "pull request N".
 * Three readers interpret those columns as pull requests that exist on GitHub:
 * the comment-author assembly on the sync path, the poll loop's per-pull
 * annotation lookup, and the out-of-band-write detector — whose meaning, "writes
 * that reached the client repository", a local row would falsify outright. Those
 * columns accept an integer of any provenance without complaint, so nothing in
 * the schema refuses the mistake and the damage would surface far from the
 * statement that caused it.
 *
 * A local review is therefore invisible to the write journal, and that is
 * deliberate rather than a gap. The journal attests writes that reached the
 * client repository under a shared identity; a local review never reaches it, so
 * there is nothing to attest, and a row claiming otherwise would make the
 * journal wrong rather than more complete.
 *
 * Absent vs unreadable: a genuinely missing row reads back as `null` (never
 * synced / no draft yet — the correct empty answer). A row that EXISTS but whose
 * stored JSON cannot be parsed throws `StoreUnreadableError` rather than
 * returning `null`, because returning `null` would let a caller treat a present
 * document as absent and overwrite it. A present-but-unreadable row is never
 * reseeded or overwritten.
 */

/** The on-disk schema version. Bump this and add a migration step when the shape changes. */
export const STORE_VERSION = 4

/** A stored row could not be read back: the row EXISTS but its JSON is corrupt. */
export class StoreUnreadableError extends Error {
  readonly table: string
  readonly rowKey: string

  constructor(table: string, rowKey: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `The ${table} row "${rowKey}" exists but could not be parsed (${detail}). ` +
        'Refusing to treat it as absent: a present row is real state and must not ' +
        'be silently overwritten. Repair or remove the row to continue.',
    )
    this.name = 'StoreUnreadableError'
    this.table = table
    this.rowKey = rowKey
  }
}

/**
 * A durable write failed — the mutation did NOT reach disk (disk full,
 * permissions, read-only filesystem). Surfaced, never swallowed, so the daemon
 * can answer `persist_failed` instead of a success the client would trust. The
 * message carries no token material and no row contents.
 */
export class StoreWriteError extends Error {
  readonly table: string

  constructor(table: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to persist to the ${table} table: ${detail}`)
    this.name = 'StoreWriteError'
    this.table = table
  }
}

/**
 * Resolve the data directory: `${XDG_DATA_HOME:-~/.local/share}/revu`. An
 * explicit `REVU_DATA_DIR` overrides both (used by tests to point at a temp dir).
 */
export function resolveDirectDataDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.REVU_DATA_DIR
  if (override && override.length > 0) return override
  const xdg = env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share')
  return join(base, 'revu')
}

/** The store file name under the data dir. */
const DB_FILE = 'direct.sqlite'

/** The immutable half plus the head SHA it belongs to, as persisted. */
interface StoredImmutable {
  compareKey: string
  immutable: SnapshotImmutable
  /**
   * The incompleteness of THIS immutable half (file cap hit, merge-base tree
   * truncated), carried with it so a warm compareKey hit reattaches the honest
   * `partial` instead of reporting a truncated half as complete. Absent in rows
   * written before the field existed — read back as `null` (complete), which is
   * what those rows meant.
   */
  partial?: Snapshot['partial']
}

/**
 * A stored snapshot minus its immutable half: the mutable half and the top-level
 * envelope, plus the `compareKey` that joins it to the `immutables` table. The
 * immutable half is stored once per compareKey and re-attached on read, so a warm
 * re-sync that reuses the immutable half does not duplicate it on disk.
 */
interface StoredSnapshotEnvelope {
  prNumber: number
  syncedAt: string
  partial: Snapshot['partial']
  syncStats: Snapshot['syncStats']
  compareKey: string
  mutable: Snapshot['mutable']
}

/**
 * One journaled write: a GitHub mutation that succeeded under a shared identity,
 * keyed to the human who performed it. `githubId` is the id GitHub assigned (or
 * the numeric id of the mutated object), `humanId` the lowercased git-config
 * email (kept local — it never enters a GitHub body), `endpoint` the write route
 * that produced it, `pr` the pull request it landed on, and `createdAt` an
 * ISO-8601 UTC timestamp. Rows are append-only: the journal is ground truth for
 * "who wrote this", so nothing may rewrite or remove one.
 */
export interface AuditEntry {
  githubId: number
  humanId: string
  workspace: string
  endpoint: string
  pr: number
  createdAt: string
}

/**
 * The caller-supplied half of a new local review.
 *
 * The store is TOLD its repository identity rather than deriving one: resolving
 * it needs git, which is not this layer's concern, and a request must never be
 * able to name the repository it writes into. The value is `owner/name` when the
 * workspace has a parseable GitHub remote and the absolute path of the
 * repository root otherwise; it is never empty.
 *
 * Refs arrive already validated and fully qualified, and `title` already
 * defaulted. The store stores what it is handed and normalizes nothing, so one
 * branch pair cannot end up as two reviews under two spellings of the same
 * branch.
 */
export interface NewLocalReview {
  repo: string
  baseRef: string
  headRef: string
  title: string
}

/**
 * The sync-derived state of a local review: the three SHAs a comparison is built
 * from, whether the worktree held uncommitted changes (which are therefore NOT
 * part of the review), and when the sync ran. Every field is null-or-false before
 * the first sync.
 *
 * All of it is replaced together because all of it describes ONE observation of
 * the two refs — writing a head SHA without the merge base it was compared
 * against would record a comparison that never happened.
 */
export interface LocalReviewSyncState {
  baseSha: string | null
  mergeBaseSha: string | null
  headSha: string | null
  dirty: boolean
  lastSyncedAt: string | null
}

/**
 * The durable store surface direct mode reads and writes. Every getter returns
 * a fresh value (JSON round-trips, so nothing aliases internal state) and every
 * setter that touches disk throws `StoreWriteError` on failure rather than
 * swallowing it.
 */
export interface DirectStore {
  // ——— immutable half, keyed by compareKey (the two-half cache) ———
  /**
   * The cached immutable half for a compare, with the `partial` that describes
   * its own incompleteness (null = complete). `null` when the key is absent.
   */
  getImmutable(
    compareKey: string,
  ): { immutable: SnapshotImmutable; partial: Snapshot['partial'] } | null
  putImmutable(immutable: SnapshotImmutable, partial?: Snapshot['partial']): void

  // ——— per-PR assembled snapshot ———
  getSnapshot(prNumber: number): Snapshot | null
  putSnapshot(snapshot: Snapshot): void

  // ——— content-addressed blobs ———
  hasBlob(sha: string): boolean
  getBlob(sha: string): FileBlob | null
  putBlobs(blobs: FileBlob[]): void

  // ——— per-human drafts ———
  getDraft(humanId: string, prNumber: number): ReviewDraft | null
  putDraft(draft: ReviewDraft): void
  deleteDraft(humanId: string, prNumber: number): void

  // ——— per-human viewed state ———
  getViewed(humanId: string, prNumber: number): FileViewedState
  setViewed(humanId: string, prNumber: number, state: FileViewedState): void

  // ——— per-human preferences ———
  getPreferences(humanId: string): HumanPreferences
  setPreferences(humanId: string, patch: Partial<HumanPreferences>): HumanPreferences

  // ——— the append-only write audit journal ———
  /**
   * Append one journaled write. Durable and append-only: the row reaches disk
   * before the call returns or a `StoreWriteError` surfaces (never a silent
   * success), and there is deliberately NO update or delete counterpart — an
   * audit row, once written, is permanent.
   */
  appendAudit(entry: AuditEntry): void
  /**
   * Read journaled writes, oldest → newest (insertion order). `pr` narrows to
   * one pull request; `sinceIso` keeps entries whose `createdAt` is at or after
   * the given instant (ISO-8601 UTC strings compare correctly as text). Both
   * filters combine; omitting the filter returns the whole journal.
   */
  listAudit(filter?: { pr?: number; sinceIso?: string }): AuditEntry[]

  // ——— the pull-request author attribution seam ———
  /**
   * Record which human drove the shared bot when a pull request was opened, or
   * `null` to record that a real org member (not the bot) opened it.
   * FIRST-WRITE-WINS: the first record for a PR is permanent, so a later call
   * with the same PR is a no-op and never rewrites the original driver — the
   * driver at open time is ground truth and a re-observation must not overwrite
   * it. Durable and typed like every other write: the row reaches disk before the
   * call returns or a `StoreWriteError` surfaces.
   *
   * Population is host-side: revu is a review client and does not open pull
   * requests, so no in-workspace caller records an author during normal
   * operation — the host-side collector correlates each PR to its driving human
   * and writes this row.
   */
  recordPrAuthor(pr: number, humanId: string | null): void
  /**
   * The recorded author attribution for a PR: the driving human's id, `null`
   * when the row records a real org member opened it, or `undefined` when NO row
   * exists yet (never observed). The three-way answer lets the poll loop tell
   * "org member opened it" (`null`) apart from "not yet attributed" (`undefined`)
   * — both surface as a `null` `authorHumanId`, but only the former is a settled
   * fact.
   */
  getPrAuthor(pr: number): string | null | undefined

  // ——— the local-review keyspace ———
  /**
   * Create the local review for a branch pair, or return the one that already
   * exists for it. Creation is idempotent per `(repo, baseRef, headRef)`: a
   * second call with the same three values returns the first review rather than
   * minting a second, which is what makes a retried request safe and what makes a
   * branch pair's identity stable.
   *
   * That idempotence holds even once a pull request has superseded the review.
   * The branch pair keeps the review it already has; a superseded pair is a
   * one-way door and mints no successor.
   *
   * The returned id comes from a monotonic high-water mark and is at or above the
   * reserved local band, never a value a pull request could carry. Durable: the
   * row reaches disk before the call returns or a `StoreWriteError` surfaces.
   */
  createLocalReview(input: NewLocalReview): LocalReviewSummary
  /** One local review by id, or `null` when no review carries that id. */
  getLocalReview(id: number): LocalReviewSummary | null
  /**
   * Every local review recorded for one repository, ordered by **ascending id**,
   * which is creation order — the ids come from a mark that only ever moves up,
   * so the oldest review is always first. The order is part of the contract
   * because a caller renders the list in the order it arrives.
   *
   * Scoped to one repository on purpose: two repositories sharing a data
   * directory share these tables, and branch names collide across repositories
   * far more readily than pull-request numbers do — `main` exists in nearly
   * every repository.
   */
  listLocalReviews(repo: string): LocalReviewSummary[]
  /**
   * Replace the sync-derived state of one local review and stamp `updated_at`.
   *
   * Writes exactly those columns. The repository, both refs, the title, the
   * generation and `created_at` are identity and history: a sync observes the two
   * refs and has no business rewriting what the review IS. An id that matches no
   * row writes nothing — a caller that needs to distinguish reads the review
   * first.
   */
  patchLocalReviewSync(id: number, state: LocalReviewSyncState): void
  /**
   * Allocate the next locally minted entity id — for a comment or a submitted
   * review summary created against a local review.
   *
   * Strictly increasing, at or above the reserved entity band, and durable: the
   * mark it reads lives on disk, so a restart continues above the last value
   * handed out instead of re-issuing one. Re-issuing would attach a new comment
   * to whatever already referenced the old id.
   */
  nextLocalEntityId(): number
  /**
   * The stored snapshot of one local review, with the immutable half re-attached
   * from the shared content-addressed cache, or `null` when the review has never
   * been synced — the correct empty answer, never an error.
   *
   * Throws `StoreUnreadableError` when the stored envelope references a
   * `compareKey` that has no immutable half on disk. That is a corrupt store
   * rather than an absent snapshot, and it stays loud here: fabricating an empty
   * immutable half would hand back a snapshot of nothing that reads as complete.
   */
  getLocalSnapshot(localId: number): Snapshot | null
  /**
   * Persist the snapshot of one local review. The review's id travels in the
   * snapshot's `prNumber` field, so what is stored is an unchanged `Snapshot`
   * document and there is no parallel snapshot type to keep in step.
   *
   * The immutable half lands in the same content-addressed table a pull request's
   * does, keyed by `compareKey = merge_base…head` and cached with no TTL, so a
   * local review and a pull request over the same comparison share one stored
   * copy of the expensive half. Durable: the immutable half and the envelope
   * reach disk together, or a `StoreWriteError` surfaces and neither did.
   */
  putLocalSnapshot(snapshot: Snapshot): void
  /**
   * One human's review draft on one local review, or `null` when that human has
   * no draft on it — the correct empty answer, and never another human's draft.
   *
   * Keyed on the human AND the review, exactly as the pull-request draft table
   * is. Two humans can review the same branch pair, so the review id alone does
   * not identify a row: a read keyed on it would hand one human the other's
   * unsubmitted review text, which is the single most private thing this store
   * holds.
   *
   * Throws `StoreUnreadableError` when the row exists but its JSON cannot be
   * parsed, so a corrupt draft is never reported as no draft and then written
   * over.
   */
  getLocalDraft(humanId: string, localId: number): ReviewDraft | null
  /**
   * Persist one human's draft on one local review, replacing any draft that
   * human already had on it.
   *
   * The stored document is an unchanged `ReviewDraft` carrying the local review
   * id in its `prNumber` field, so nothing downstream needs a second draft type.
   * The row is keyed by the draft's OWN `humanId`; a caller that accepts an
   * identity from a request must overwrite it with the session's before calling,
   * exactly as the pull-request draft path does — the store makes the keying
   * possible and does not police who is asking.
   */
  putLocalDraft(draft: ReviewDraft): void
  /**
   * Remove one human's draft on one local review, and nothing else.
   *
   * Both key columns are matched. Deleting on the review id alone would take
   * every human's draft on that review with it; deleting on the human alone
   * would take their drafts on every other review. Drafts are irreplaceable
   * local work, so the narrowest statement that can express the intent is the
   * only acceptable one.
   */
  deleteLocalDraft(humanId: string, localId: number): void
  /**
   * One human's per-file viewed state on one local review. An absent row reads
   * back as an empty record — nothing viewed yet is the ordinary state, not an
   * error — while a present-but-unparseable row throws `StoreUnreadableError`.
   *
   * A separate keyspace from the pull-request viewed table, not a shared one
   * with a wider key: a local review id and a pull request number are different
   * kinds of number, and a review that happened to carry a colliding value must
   * never inherit the other's checkmarks.
   */
  getLocalViewed(humanId: string, localId: number): FileViewedState
  /** Replace one human's per-file viewed state on one local review. */
  setLocalViewed(humanId: string, localId: number, state: FileViewedState): void
  /**
   * Every review thread on one local review, in **insertion order** — the order
   * the threads were first stored, which is the order they were created against
   * the review. The order is part of the contract because a caller renders the
   * list in the order it arrives, and an opaque thread id sorts by nothing a
   * reader would recognise as meaningful.
   *
   * Re-storing a thread rewrites it where it already sits rather than moving it
   * to the end, so resolving one thread does not reshuffle the list underneath
   * the reader.
   *
   * Throws `StoreUnreadableError` when a stored thread cannot be parsed, rather
   * than dropping it from the result: a list silently one thread short reads as a
   * review that has fewer comments than it really does.
   */
  listLocalThreads(localId: number): ReviewThread[]
  /**
   * One thread on one local review, or `null` when that review carries no thread
   * under that id — the correct empty answer, and never another review's thread.
   *
   * Both key columns are matched. A thread id is opaque and nothing parses it, so
   * nothing makes one unique across reviews; a read keyed on the thread id alone
   * would hand back whichever review happened to store it.
   */
  getLocalThread(localId: number, threadId: string): ReviewThread | null
  /**
   * Store a thread on a local review, replacing whatever was stored under its id.
   *
   * Replacing rather than appending is what makes resolving work: a resolve
   * rewrites the same thread with `isResolved` flipped, and a second row under
   * the same id would render that thread twice, once in each state. The stored
   * document is an unchanged `ReviewThread`, so nothing downstream needs a second
   * thread type.
   */
  putLocalThread(localId: number, thread: ReviewThread): void
  /**
   * Every submitted review summary on one local review, in **insertion order** —
   * the order they were submitted. Ordered for the same reason the thread list is:
   * a caller renders them in the order they arrive.
   *
   * Throws `StoreUnreadableError` when a stored summary cannot be parsed, rather
   * than dropping it: a submitted review that silently vanishes from the list is a
   * review the human made and can no longer see.
   */
  listLocalSubmittedReviews(localId: number): ReviewSummary[]
  /**
   * Record a submitted review summary against a local review, replacing any
   * summary already stored under its id.
   *
   * Named for the table it writes rather than for the domain concept, because the
   * store's own vocabulary already spends "local review" on the review of a branch
   * pair — the thing these summaries are submitted *against*. The stored document
   * is an unchanged `ReviewSummary`.
   */
  putLocalSubmittedReview(localId: number, review: ReviewSummary): void

  /** Close the underlying database handle (tests + shutdown). */
  close(): void
}

/** Parse a stored JSON cell, mapping a parse failure to `StoreUnreadableError`. */
function parseRow<T>(table: string, rowKey: string, json: string): T {
  try {
    return JSON.parse(json) as T
  } catch (err) {
    throw new StoreUnreadableError(table, rowKey, err)
  }
}

/**
 * The generation every local review is created at.
 *
 * `generation` is the fourth column of the unique key over `(repo, base_ref,
 * head_ref, generation)`. Nothing advances it, which is what makes a branch
 * pair's identity a one-way door: the pair keeps the review it already has, even
 * once a pull request has superseded it. The column exists so a later change can
 * distinguish a superseded pair from a fresh one WITHOUT altering a primary key —
 * SQLite cannot do that without rebuilding the table, and a rebuild is what this
 * file's migration doctrine forbids.
 */
const LOCAL_REVIEW_GENERATION = 0

/** One `local_reviews` row as stored, before the wire-shaped rename. */
interface LocalReviewRow {
  id: number
  repo: string
  base_ref: string
  head_ref: string
  title: string
  base_sha: string | null
  merge_base_sha: string | null
  head_sha: string | null
  dirty: number
  archived_pr: number | null
  created_at: string
  updated_at: string
  last_synced_at: string | null
}

/**
 * The columns a local review reads back through, named rather than `*` so a
 * column added later cannot silently change what a row destructures to.
 * `generation` is deliberately absent: it discriminates rows inside the store and
 * is not part of what a review IS to a caller.
 */
const LOCAL_REVIEW_COLUMNS =
  'id, repo, base_ref, head_ref, title, base_sha, merge_base_sha, head_sha, ' +
  'dirty, archived_pr, created_at, updated_at, last_synced_at'

/**
 * Rename one stored row onto the wire shape. A local review is stored as typed
 * columns rather than as a JSON document, so there is no stored text that could
 * fail to parse and no unreadable-versus-absent distinction to preserve here: an
 * absent row is `null` and a present one always maps. `dirty` is the one
 * conversion — SQLite has no boolean type, so it is stored as 0 or 1.
 */
function toLocalReviewSummary(row: LocalReviewRow): LocalReviewSummary {
  return {
    id: row.id,
    repo: row.repo,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    title: row.title,
    baseSha: row.base_sha,
    mergeBaseSha: row.merge_base_sha,
    headSha: row.head_sha,
    dirty: row.dirty !== 0,
    archivedPr: row.archived_pr,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncedAt: row.last_synced_at,
  }
}

/**
 * The review recorded for one branch pair, looked up by the FULL unique key.
 *
 * Keying on the unique key rather than on a subset of it is what lets the mint
 * insert with `ON CONFLICT … DO NOTHING` and then read back the row that won: a
 * lookup on any narrower or wider predicate could miss the conflicting row and
 * leave the mint with nothing to return.
 */
function selectLocalReview(db: Database, key: NewLocalReview): LocalReviewRow | null {
  return db
    .query(
      `SELECT ${LOCAL_REVIEW_COLUMNS} FROM local_reviews ` +
        'WHERE repo = ? AND base_ref = ? AND head_ref = ? AND generation = ?',
    )
    .get(key.repo, key.baseRef, key.headRef, LOCAL_REVIEW_GENERATION) as LocalReviewRow | null
}

/**
 * Read and bump one monotonic id high-water mark, returning the value handed out.
 *
 * ONE statement, and that is the whole point. A `SELECT` followed by an `UPDATE`
 * lets two readers observe the same value and hand out the same id — and a
 * high-water mark makes that failure MORE likely than a `MAX(id) + 1` scan would,
 * not less, because both readers see a row that has not moved yet. `UPDATE …
 * RETURNING` closes the window entirely: the value returned is the value written,
 * decided by SQLite under the row's write lock, which is what keeps the mark
 * correct when two daemons share one data directory.
 *
 * The value is stored as text (the `meta` table holds strings), so the increment
 * casts through an integer and back rather than relying on column affinity.
 *
 * A missing row refuses to allocate. Both marks are seeded when the keyspace is
 * created and again on every path that upgrades a file into it, so an absent one
 * means the file was edited outside this store — and fabricating a starting value
 * there could hand back an id that was already issued.
 *
 * A mark that is PRESENT but not a decimal integer refuses too, and the guards
 * that decide it live in the WHERE clause rather than in a check on the result.
 * That placement is load-bearing rather than a stylistic preference:
 * SQLite casts a non-numeric string to 0, so an unguarded increment resolves to
 * `'1'` — a value squarely inside the pull-request number range this keyspace
 * exists to stay out of — writes it back over the unreadable one, and hands it
 * out as an id. Refusing in the WHERE clause means the statement matches no row,
 * so nothing is written and the value stays byte for byte as it was found; a
 * check on the returned value could only refuse after the overwrite had already
 * committed, and the entity allocator runs its statement in autocommit with no
 * transaction to roll back. The same clause carries the band floor, so a mark
 * that IS a decimal integer but would yield an id below the caller's reserved
 * base is refused on the same terms and for the same reason.
 *
 * The refusal is a `StoreUnreadableError`, not a write failure. The two say
 * different things to a caller: a write failure is retryable (the disk was full,
 * the handle was closed), while a present-but-unreadable row re-reads the same
 * bytes forever and only a human can repair it. A corrupt mark is the second,
 * and the doctrine it belongs to is the one that already governs every other
 * present-but-unparseable row in this file — surface it, and never reseed over
 * it. The MISSING case stays a plain error that the write wrapper types as a
 * write failure, because an absent row is not a present one and its long-
 * standing behaviour is not this refusal's to change.
 */
function bumpIdHighWater(db: Database, key: string, base: number): number {
  const row = db
    .query(
      'UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) ' +
        // `NOT GLOB '*[^0-9]*'` is "contains no non-digit"; paired with a
        // non-empty length it is exactly an all-digits value, spelled in the
        // only pattern language the statement itself can apply.
        "WHERE key = ? AND length(value) > 0 AND value NOT GLOB '*[^0-9]*' " +
        'AND CAST(value AS INTEGER) + 1 >= ? RETURNING value',
    )
    .get(key, base) as { value: string } | null
  if (row) return Number(row.value)

  // No row matched, so no row was written. Which refusal applies needs the
  // stored value, and reading it here costs the successful path nothing.
  const stored = db.query('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | null
  if (!stored) {
    throw new Error(
      `the id high-water mark "${key}" is missing, so no id can be allocated ` +
        'without risking one that has already been handed out',
    )
  }
  // The value itself is deliberately absent from the message: this file's errors
  // name the row, never its contents.
  throw new StoreUnreadableError(
    'meta',
    key,
    `the id high-water mark is not a decimal integer that yields an id of ${base} or above`,
  )
}

/**
 * Open (creating if needed) the direct-mode store at the resolved data dir, run
 * migrations in place, and return the store surface. A `:memory:` path is
 * honored verbatim for tests; any other path is created under the data dir.
 *
 * `dataDir` defaults to `${XDG_DATA_HOME:-~/.local/share}/revu`. Passing
 * `':memory:'` opens an ephemeral database with no file.
 */
export function openDirectStore(
  opts: { dataDir?: string; env?: Record<string, string | undefined> } = {},
): DirectStore {
  const env = opts.env ?? process.env
  const dataDir = opts.dataDir ?? resolveDirectDataDir(env)

  let db: Database
  if (dataDir === ':memory:') {
    db = new Database(':memory:')
  } else {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    db = new Database(join(dataDir, DB_FILE))
  }

  // Durability pragmas: a WAL with FULL synchrony means a committed write has
  // reached disk before the call returns, which is the whole point of a durable
  // host — an ack the client can trust as saved.
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = FULL')

  migrate(db)

  /**
   * Run a write, wrapping any failure in a typed `StoreWriteError` (never
   * swallowed). The callback's result is forwarded, so a write that has to report
   * what it wrote — a minted id, the row that won a conflict — reads back through
   * the same wrapper rather than around it.
   */
  function write<T>(table: string, fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      // A present-but-unreadable row is already the correctly named failure, and
      // it is a DIFFERENT condition from a mutation that never reached disk. A
      // write failure is retryable — the disk was full, the file was read-only,
      // the handle was closed — and a caller is right to try again. A corrupt row
      // is not: retrying re-reads the same bytes forever, and only a human can
      // repair them. Re-wrapping one as the other would erase that difference at
      // the exact moment a caller has to choose between the two responses, so it
      // travels out unchanged.
      if (err instanceof StoreUnreadableError) throw err
      throw new StoreWriteError(table, err)
    }
  }

  /**
   * Read the immutable half's OWN incompleteness back off disk, so a snapshot
   * write can leave it exactly as it found it.
   *
   * A snapshot's `partial` may be a MERGE of two kinds: the immutable half's own
   * incompleteness (a file cap, a truncated merge-base tree — a function of the
   * comparison, so it rides with the immutable row) and a snapshot-scoped one
   * (missing blob bytes, which a retry fixes — NOT a function of the comparison).
   * The immutable row is content-addressed by `compareKey` and cached forever with
   * no TTL, so writing the merged value onto it would pin a blob-missing reason to
   * a key that outlives the missing blobs: the next reader of that key, long after
   * those blobs were provisioned, would resurrect a truncation that stopped being
   * true and nothing downstream could tell it from a fresh one. The row's own
   * value was written on the cold path by `putImmutable`; this preserves it.
   *
   * An absent row means the cold path never ran for this key, so there is nothing
   * to preserve and the half is recorded as complete.
   */
  function ownImmutablePartial(compareKey: string): Snapshot['partial'] {
    const existing = db
      .query('SELECT data FROM immutables WHERE compare_key = ?')
      .get(compareKey) as { data: string } | null
    if (!existing) return null
    return parseRow<StoredImmutable>('immutables', compareKey, existing.data).partial ?? null
  }

  /**
   * Persist a snapshot as two rows: the immutable half in the shared
   * content-addressed `immutables` table under its `compareKey`, and the envelope
   * (the mutable half plus the top-level fields) in the caller's table under the
   * caller's key column. The envelope carries the merged `partial` verbatim — it is
   * what a caller sees — while the immutable row keeps its own, per
   * `ownImmutablePartial`.
   *
   * ONE function called from the pull-request path and the local-review path, for
   * the same reason each table's DDL is one statement constant run from two call
   * sites: the two paths must not drift, and the `partial` rule is subtle enough
   * that a second copy of it is where the drift would land — silently, and months
   * from the statement that caused it.
   *
   * All three statements — the preservation read and the two upserts — run inside
   * ONE transaction, so a stored envelope never references an immutable half that
   * is not on disk and no concurrent writer can change the immutable row between
   * the read of its `partial` and the write that carries that value forward.
   *
   * The whole unit sits inside the durability wrapper, so a database that cannot
   * be read or written surfaces as a `StoreWriteError` and the caller learns the
   * mutation did not persist. That includes a present-but-corrupt immutable row:
   * the transaction aborts, so the corrupt row is refused rather than overwritten,
   * and the refusal travels in the error's message.
   *
   * `envelopeTable` and `keyColumn` are interpolated into the statement and are
   * therefore module literals from the two call sites below — nothing a request
   * can supply reaches this SQL.
   */
  function writeSnapshotRows(
    envelopeTable: string,
    keyColumn: string,
    snapshot: Snapshot,
  ): void {
    const envelope: StoredSnapshotEnvelope = {
      prNumber: snapshot.prNumber,
      syncedAt: snapshot.syncedAt,
      partial: snapshot.partial,
      syncStats: snapshot.syncStats,
      compareKey: snapshot.immutable.compareKey,
      mutable: snapshot.mutable,
    }
    write(envelopeTable, () => {
      const tx = db.transaction(() => {
        const storedImm: StoredImmutable = {
          compareKey: snapshot.immutable.compareKey,
          immutable: snapshot.immutable,
          partial: ownImmutablePartial(snapshot.immutable.compareKey),
        }
        db.run(
          'INSERT INTO immutables (compare_key, data) VALUES (?, ?) ' +
            'ON CONFLICT(compare_key) DO UPDATE SET data = excluded.data',
          [snapshot.immutable.compareKey, JSON.stringify(storedImm)],
        )
        db.run(
          `INSERT INTO ${envelopeTable} (${keyColumn}, data) VALUES (?, ?) ` +
            `ON CONFLICT(${keyColumn}) DO UPDATE SET data = excluded.data`,
          [snapshot.prNumber, JSON.stringify(envelope)],
        )
      })
      tx()
    })
  }

  return {
    getImmutable(
      compareKey: string,
    ): { immutable: SnapshotImmutable; partial: Snapshot['partial'] } | null {
      const row = db
        .query('SELECT data FROM immutables WHERE compare_key = ?')
        .get(compareKey) as { data: string } | null
      if (!row) return null
      const stored = parseRow<StoredImmutable>('immutables', compareKey, row.data)
      return { immutable: stored.immutable, partial: stored.partial ?? null }
    },

    putImmutable(immutable: SnapshotImmutable, partial: Snapshot['partial'] = null): void {
      const stored: StoredImmutable = {
        compareKey: immutable.compareKey,
        immutable,
        partial,
      }
      write('immutables', () => {
        // Cache-forever, no TTL: an identical compareKey is idempotently the
        // same diff, so a re-put replaces bytes-for-bytes without invalidation.
        db.run(
          'INSERT INTO immutables (compare_key, data) VALUES (?, ?) ' +
            'ON CONFLICT(compare_key) DO UPDATE SET data = excluded.data',
          [immutable.compareKey, JSON.stringify(stored)],
        )
      })
    },

    getSnapshot(prNumber: number): Snapshot | null {
      const row = db
        .query('SELECT data FROM snapshots WHERE pr_number = ?')
        .get(prNumber) as { data: string } | null
      if (!row) return null
      const envelope = parseRow<StoredSnapshotEnvelope>(
        'snapshots',
        String(prNumber),
        row.data,
      )
      const imm = db
        .query('SELECT data FROM immutables WHERE compare_key = ?')
        .get(envelope.compareKey) as { data: string } | null
      if (!imm) {
        // The snapshot references an immutable half that is not on disk. That is
        // a corrupt store, not an absent snapshot: surface it rather than return
        // a snapshot with a fabricated or empty immutable half.
        throw new StoreUnreadableError(
          'snapshots',
          String(prNumber),
          new Error(
            `snapshot references compareKey "${envelope.compareKey}" with no stored immutable half`,
          ),
        )
      }
      const stored = parseRow<StoredImmutable>('immutables', envelope.compareKey, imm.data)
      return {
        prNumber: envelope.prNumber,
        syncedAt: envelope.syncedAt,
        partial: envelope.partial,
        syncStats: envelope.syncStats,
        immutable: stored.immutable,
        mutable: envelope.mutable,
      }
    },

    putSnapshot(snapshot: Snapshot): void {
      writeSnapshotRows('snapshots', 'pr_number', snapshot)
    },

    hasBlob(sha: string): boolean {
      const row = db.query('SELECT 1 FROM blobs WHERE sha = ?').get(sha)
      return row !== null
    },

    getBlob(sha: string): FileBlob | null {
      const row = db.query('SELECT data FROM blobs WHERE sha = ?').get(sha) as
        | { data: string }
        | null
      if (!row) return null
      return parseRow<FileBlob>('blobs', sha, row.data)
    },

    putBlobs(blobs: FileBlob[]): void {
      if (blobs.length === 0) return
      write('blobs', () => {
        const insert = db.prepare(
          'INSERT INTO blobs (sha, data) VALUES (?, ?) ' +
            'ON CONFLICT(sha) DO NOTHING',
        )
        const tx = db.transaction((rows: FileBlob[]) => {
          for (const b of rows) insert.run(b.sha, JSON.stringify(b))
        })
        tx(blobs)
      })
    },

    getDraft(humanId: string, prNumber: number): ReviewDraft | null {
      const row = db
        .query('SELECT data FROM drafts WHERE human_id = ? AND pr_number = ?')
        .get(humanId, prNumber) as { data: string } | null
      if (!row) return null
      return parseRow<ReviewDraft>('drafts', `${humanId}/${prNumber}`, row.data)
    },

    putDraft(draft: ReviewDraft): void {
      write('drafts', () => {
        db.run(
          'INSERT INTO drafts (human_id, pr_number, data) VALUES (?, ?, ?) ' +
            'ON CONFLICT(human_id, pr_number) DO UPDATE SET data = excluded.data',
          [draft.humanId, draft.prNumber, JSON.stringify(draft)],
        )
      })
    },

    deleteDraft(humanId: string, prNumber: number): void {
      write('drafts', () => {
        db.run('DELETE FROM drafts WHERE human_id = ? AND pr_number = ?', [humanId, prNumber])
      })
    },

    getViewed(humanId: string, prNumber: number): FileViewedState {
      const row = db
        .query('SELECT data FROM viewed WHERE human_id = ? AND pr_number = ?')
        .get(humanId, prNumber) as { data: string } | null
      if (!row) return {}
      return parseRow<FileViewedState>('viewed', `${humanId}/${prNumber}`, row.data)
    },

    setViewed(humanId: string, prNumber: number, state: FileViewedState): void {
      write('viewed', () => {
        db.run(
          'INSERT INTO viewed (human_id, pr_number, data) VALUES (?, ?, ?) ' +
            'ON CONFLICT(human_id, pr_number) DO UPDATE SET data = excluded.data',
          [humanId, prNumber, JSON.stringify(state)],
        )
      })
    },

    getPreferences(humanId: string): HumanPreferences {
      const row = db
        .query('SELECT data FROM prefs WHERE human_id = ?')
        .get(humanId) as { data: string } | null
      if (!row) return { ...DEFAULT_PREFERENCES }
      const stored = parseRow<Partial<HumanPreferences>>('prefs', humanId, row.data)
      // New preference fields default from `DEFAULT_PREFERENCES`, so an old row
      // that predates a field reads back with the field defaulted, never missing.
      return { ...DEFAULT_PREFERENCES, ...stored }
    },

    setPreferences(humanId: string, patch: Partial<HumanPreferences>): HumanPreferences {
      const current = this.getPreferences(humanId)
      const next: HumanPreferences = { ...current, ...patch }
      write('prefs', () => {
        db.run(
          'INSERT INTO prefs (human_id, data) VALUES (?, ?) ' +
            'ON CONFLICT(human_id) DO UPDATE SET data = excluded.data',
          [humanId, JSON.stringify(next)],
        )
      })
      return next
    },

    appendAudit(entry: AuditEntry): void {
      write('audit_log', () => {
        // A plain INSERT is the ONLY statement that ever touches this table:
        // no upsert, no UPDATE, no DELETE. The implicit rowid orders entries by
        // insertion, and since nothing deletes, rowids stay strictly monotonic.
        db.run(
          'INSERT INTO audit_log (github_id, human_id, workspace, endpoint, pr, created_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?)',
          [entry.githubId, entry.humanId, entry.workspace, entry.endpoint, entry.pr, entry.createdAt],
        )
      })
    },

    listAudit(filter: { pr?: number; sinceIso?: string } = {}): AuditEntry[] {
      const clauses: string[] = []
      const params: (string | number)[] = []
      if (filter.pr !== undefined) {
        clauses.push('pr = ?')
        params.push(filter.pr)
      }
      if (filter.sinceIso !== undefined) {
        // ISO-8601 UTC timestamps sort correctly as text, so a plain string
        // comparison is an honest time filter. Inclusive: an entry stamped
        // exactly at `sinceIso` is returned.
        clauses.push('created_at >= ?')
        params.push(filter.sinceIso)
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
      const rows = db
        .query(
          'SELECT github_id, human_id, workspace, endpoint, pr, created_at ' +
            `FROM audit_log${where} ORDER BY rowid ASC`,
        )
        .all(...params) as {
        github_id: number
        human_id: string
        workspace: string
        endpoint: string
        pr: number
        created_at: string
      }[]
      return rows.map((r) => ({
        githubId: r.github_id,
        humanId: r.human_id,
        workspace: r.workspace,
        endpoint: r.endpoint,
        pr: r.pr,
        createdAt: r.created_at,
      }))
    },

    recordPrAuthor(pr: number, humanId: string | null): void {
      write('pr_author', () => {
        // FIRST-WRITE-WINS: `ON CONFLICT(pr) DO NOTHING` means the earliest
        // record for a PR is permanent. A later call — the collector
        // re-observing the same PR — is silently a no-op, so the original driver
        // recorded at open time is never rewritten.
        db.run(
          'INSERT INTO pr_author (pr, human_id, recorded_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(pr) DO NOTHING',
          [pr, humanId, new Date().toISOString()],
        )
      })
    },

    getPrAuthor(pr: number): string | null | undefined {
      const row = db
        .query('SELECT human_id FROM pr_author WHERE pr = ?')
        .get(pr) as { human_id: string | null } | null
      // No row: never attributed — `undefined`, distinct from a recorded `null`
      // (an org member opened it). SQLite hands back a JS `null` for a NULL cell,
      // so a present row with a NULL author reads back as `null`, not `undefined`.
      if (!row) return undefined
      return row.human_id
    },

    createLocalReview(input: NewLocalReview): LocalReviewSummary {
      return write('local_reviews', () => {
        // Read the mark, bump it, and insert the row as ONE transaction. Two
        // daemons can share a data directory, and the failure that a partial
        // sequence produces is silent: a bump that commits without its row leaves
        // the mark ahead of every id in the table, and an insert that commits
        // without its bump hands the same id out twice.
        const tx = db.transaction(() => {
          // Already recorded for this branch pair: leave it alone and consume no
          // id. Minting first and discarding the loser would burn an id on every
          // retried request.
          if (selectLocalReview(db, input)) return

          const id = bumpIdHighWater(db, LOCAL_REVIEW_ID_META_KEY, LOCAL_REVIEW_ID_BASE)
          const at = new Date().toISOString()
          // The id is supplied explicitly — never omitted and never NULL, which
          // SQLite would answer by assigning a small rowid inside the
          // pull-request number range.
          //
          // `ON CONFLICT … DO NOTHING` rather than a failure, because the unique
          // key is the last line of defence on the branch pair's identity: an
          // insert that lost the race to another writer must not be the thing
          // that decides the pair has two reviews. Spelled as `ON CONFLICT` and
          // not as a blanket ignoring insert so that any OTHER constraint
          // violation — a NULL in a NOT NULL column — still aborts loudly
          // instead of being indistinguishable from a yielded duplicate.
          //
          // It does NOT make a genuinely concurrent create idempotent, and an
          // interleaved pair of writers never reaches it at all. Two daemons on
          // one file are two connections; this transaction takes its snapshot at
          // the lookup above, and a write that commits after that snapshot
          // leaves this one unable to proceed. No busy timeout is set on the
          // connection, so the loser is refused immediately — at the mark's
          // update, before the insert exists to conflict — and the caller
          // receives a write failure rather than the row the winner wrote. The
          // STATE that failure leaves is still correct, which is why the clause
          // stays: one row for the pair, a mark consistent with it, nothing
          // half-written, and a retry that finds the winner's row at the lookup
          // and returns it. Turning the refusal into a wait is a busy timeout,
          // which belongs to whatever opens the connection, not to this
          // statement.
          db.run(
            'INSERT INTO local_reviews (id, repo, base_ref, head_ref, generation, title, ' +
              'created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT(repo, base_ref, head_ref, generation) DO NOTHING',
            [
              id,
              input.repo,
              input.baseRef,
              input.headRef,
              LOCAL_REVIEW_GENERATION,
              input.title,
              at,
              at,
            ],
          )
        })
        tx()
        // Read after the commit, so the row returned is the one that WON the
        // branch pair — whether this call inserted it or yielded to a writer that
        // got there first. Absent here means the row was removed from underneath
        // the commit, which is a real failure and not a review to hand back.
        const row = selectLocalReview(db, input)
        if (!row) {
          throw new Error('the local review is neither newly inserted nor already recorded')
        }
        return toLocalReviewSummary(row)
      })
    },

    getLocalReview(id: number): LocalReviewSummary | null {
      const row = db
        .query(`SELECT ${LOCAL_REVIEW_COLUMNS} FROM local_reviews WHERE id = ?`)
        .get(id) as LocalReviewRow | null
      return row ? toLocalReviewSummary(row) : null
    },

    listLocalReviews(repo: string): LocalReviewSummary[] {
      const rows = db
        .query(
          `SELECT ${LOCAL_REVIEW_COLUMNS} FROM local_reviews WHERE repo = ? ORDER BY id ASC`,
        )
        .all(repo) as LocalReviewRow[]
      return rows.map(toLocalReviewSummary)
    },

    patchLocalReviewSync(id: number, state: LocalReviewSyncState): void {
      write('local_reviews', () => {
        db.run(
          'UPDATE local_reviews SET base_sha = ?, merge_base_sha = ?, head_sha = ?, ' +
            'dirty = ?, last_synced_at = ?, updated_at = ? WHERE id = ?',
          [
            state.baseSha,
            state.mergeBaseSha,
            state.headSha,
            state.dirty ? 1 : 0,
            state.lastSyncedAt,
            new Date().toISOString(),
            id,
          ],
        )
      })
    },

    nextLocalEntityId(): number {
      // No explicit transaction, and that is not an omission: the whole
      // allocation is ONE `UPDATE … RETURNING`, which SQLite already runs
      // atomically under the row's write lock. There is no second statement for a
      // concurrent writer to interleave with, so a BEGIN/COMMIT around it would
      // add a round trip and no guarantee. The mint of a review id is different —
      // it bumps a mark AND inserts a row, two statements that must commit or fail
      // together — and it wraps them accordingly.
      return write('meta', () =>
        bumpIdHighWater(db, LOCAL_ENTITY_ID_META_KEY, LOCAL_ENTITY_ID_BASE),
      )
    },

    getLocalSnapshot(localId: number): Snapshot | null {
      const row = db
        .query('SELECT data FROM local_snapshots WHERE local_id = ?')
        .get(localId) as { data: string } | null
      if (!row) return null
      const envelope = parseRow<StoredSnapshotEnvelope>(
        'local_snapshots',
        String(localId),
        row.data,
      )
      const imm = db
        .query('SELECT data FROM immutables WHERE compare_key = ?')
        .get(envelope.compareKey) as { data: string } | null
      if (!imm) {
        // The envelope references an immutable half that is not on disk. That is
        // a corrupt store, not an absent snapshot: surface it rather than return a
        // snapshot with a fabricated or empty immutable half. A caller that wants
        // to offer "the objects are gone, re-sync to rebuild" needs to be told the
        // store is broken, which returning a plausible-looking snapshot would hide.
        throw new StoreUnreadableError(
          'local_snapshots',
          String(localId),
          new Error(
            `snapshot references compareKey "${envelope.compareKey}" with no stored immutable half`,
          ),
        )
      }
      const stored = parseRow<StoredImmutable>('immutables', envelope.compareKey, imm.data)
      return {
        prNumber: envelope.prNumber,
        syncedAt: envelope.syncedAt,
        partial: envelope.partial,
        syncStats: envelope.syncStats,
        immutable: stored.immutable,
        mutable: envelope.mutable,
      }
    },

    getLocalDraft(humanId: string, localId: number): ReviewDraft | null {
      const row = db
        .query('SELECT data FROM local_drafts WHERE human_id = ? AND local_id = ?')
        .get(humanId, localId) as { data: string } | null
      if (!row) return null
      return parseRow<ReviewDraft>('local_drafts', `${humanId}/${localId}`, row.data)
    },

    putLocalDraft(draft: ReviewDraft): void {
      write('local_drafts', () => {
        // The local review's id travels in `prNumber`, so the document written
        // here is an unchanged draft: the same shape the pull-request path
        // stores, read by the same code, with nothing to keep in step.
        db.run(
          'INSERT INTO local_drafts (human_id, local_id, data) VALUES (?, ?, ?) ' +
            'ON CONFLICT(human_id, local_id) DO UPDATE SET data = excluded.data',
          [draft.humanId, draft.prNumber, JSON.stringify(draft)],
        )
      })
    },

    deleteLocalDraft(humanId: string, localId: number): void {
      write('local_drafts', () => {
        // BOTH key columns, and that is the whole statement's substance. Two
        // humans reviewing one branch pair hold two rows under the same
        // `local_id`, so a delete keyed on the id alone would discard the other
        // human's unsubmitted review text — silently, since a delete reports
        // nothing about what it matched. Keyed on the pair it removes exactly
        // the row the caller addressed and cannot reach a row belonging to
        // anyone else.
        db.run('DELETE FROM local_drafts WHERE human_id = ? AND local_id = ?', [humanId, localId])
      })
    },

    getLocalViewed(humanId: string, localId: number): FileViewedState {
      const row = db
        .query('SELECT data FROM local_viewed WHERE human_id = ? AND local_id = ?')
        .get(humanId, localId) as { data: string } | null
      if (!row) return {}
      return parseRow<FileViewedState>('local_viewed', `${humanId}/${localId}`, row.data)
    },

    setLocalViewed(humanId: string, localId: number, state: FileViewedState): void {
      write('local_viewed', () => {
        db.run(
          'INSERT INTO local_viewed (human_id, local_id, data) VALUES (?, ?, ?) ' +
            'ON CONFLICT(human_id, local_id) DO UPDATE SET data = excluded.data',
          [humanId, localId, JSON.stringify(state)],
        )
      })
    },

    listLocalThreads(localId: number): ReviewThread[] {
      const rows = db
        .query('SELECT thread_id, data FROM local_threads WHERE local_id = ? ORDER BY rowid ASC')
        .all(localId) as { thread_id: string; data: string }[]
      return rows.map((row) =>
        parseRow<ReviewThread>('local_threads', `${localId}/${row.thread_id}`, row.data),
      )
    },

    getLocalThread(localId: number, threadId: string): ReviewThread | null {
      const row = db
        .query('SELECT data FROM local_threads WHERE local_id = ? AND thread_id = ?')
        .get(localId, threadId) as { data: string } | null
      if (!row) return null
      return parseRow<ReviewThread>('local_threads', `${localId}/${threadId}`, row.data)
    },

    putLocalThread(localId: number, thread: ReviewThread): void {
      write('local_threads', () => {
        // An upsert rather than an insert, because a resolve rewrites the thread
        // it resolves: a plain insert leaves the row behind twice — once
        // unresolved and once resolved — and the read has no way to tell which
        // copy is current. Spelled as `ON CONFLICT` on the key rather than as a
        // blanket ignoring insert so that any OTHER constraint violation still
        // aborts loudly instead of being indistinguishable from a rewrite.
        //
        // The conflicting row is updated where it already sits, so the thread
        // keeps its position in the list and a resolve does not reorder the
        // review under whoever is reading it.
        db.run(
          'INSERT INTO local_threads (local_id, thread_id, data) VALUES (?, ?, ?) ' +
            'ON CONFLICT(local_id, thread_id) DO UPDATE SET data = excluded.data',
          [localId, thread.id, JSON.stringify(thread)],
        )
      })
    },

    listLocalSubmittedReviews(localId: number): ReviewSummary[] {
      const rows = db
        .query(
          'SELECT review_id, data FROM local_reviews_submitted WHERE local_id = ? ORDER BY rowid ASC',
        )
        .all(localId) as { review_id: number; data: string }[]
      return rows.map((row) =>
        parseRow<ReviewSummary>('local_reviews_submitted', `${localId}/${row.review_id}`, row.data),
      )
    },

    putLocalSubmittedReview(localId: number, review: ReviewSummary): void {
      write('local_reviews_submitted', () => {
        // The id is bound as a JavaScript number, which is what keeps the key
        // column an integer: the ids stored here come from a band around 9e12,
        // and the column is declared INTEGER so the value is stored as one rather
        // than converted to a float. Both the band and its neighbourhood are far
        // inside the range a double represents exactly, so nothing is lost today
        // — the declaration is what keeps that true if the band, or the
        // arithmetic done on an id, ever reaches past where doubles stay exact.
        db.run(
          'INSERT INTO local_reviews_submitted (local_id, review_id, data) VALUES (?, ?, ?) ' +
            'ON CONFLICT(local_id, review_id) DO UPDATE SET data = excluded.data',
          [localId, review.id, JSON.stringify(review)],
        )
      })
    },

    putLocalSnapshot(snapshot: Snapshot): void {
      // The local review's id is what `prNumber` carries here, so the envelope
      // lands under `local_id` while the immutable half goes to the same shared
      // cache a pull request's does. Nothing about the immutable half is
      // pull-request-shaped: it is addressed by the SHAs git produced locally.
      writeSnapshotRows('local_snapshots', 'local_id', snapshot)
    },

    close(): void {
      db.close()
    },
  }
}

/**
 * The version-2 table: the append-only write audit journal. One statement,
 * shared by the fresh-file shape and the guarded v1 → v2 in-place step, so the
 * two paths cannot drift. No UNIQUE constraints beyond the implicit rowid — the
 * same GitHub id may legitimately journal more than once (an idempotent retry
 * that short-circuits to an already-created review still records it).
 */
const CREATE_AUDIT_LOG =
  'CREATE TABLE IF NOT EXISTS audit_log (github_id INTEGER NOT NULL, ' +
  'human_id TEXT NOT NULL, workspace TEXT NOT NULL, endpoint TEXT NOT NULL, ' +
  'pr INTEGER NOT NULL, created_at TEXT NOT NULL)'

/**
 * The version-3 table: the pull-request author attribution seam. One statement,
 * shared by the fresh-file shape and the guarded v2 → v3 in-place step, so the
 * two paths cannot drift. `pr` is the primary key (one attribution per PR, which
 * is what makes the first-write-wins upsert land), `human_id` is nullable (NULL
 * records "a real org member opened it", NOT the absent-row "never observed"
 * state), and `recorded_at` stamps when the attribution was first written.
 */
const CREATE_PR_AUTHOR =
  'CREATE TABLE IF NOT EXISTS pr_author (pr INTEGER PRIMARY KEY, ' +
  'human_id TEXT, recorded_at TEXT NOT NULL)'

/**
 * The local-review keyspace: reviews of a branch pair that has no pull request.
 *
 * A parallel set of tables rather than a wider key on the existing ones, and
 * that is forced rather than chosen. The pull-request-keyed tables are keyed by
 * a real GitHub pull-request number, read as such by the host-side collector and
 * the broker's poll loop; a synthetic identifier written into one of those
 * columns is not a wrong row that surfaces later but a row those readers cannot
 * tell from a real one. Widening their keys instead would mean altering a primary
 * key, which SQLite cannot do without rebuilding the table — and rebuilding a
 * table is exactly what this file's migration doctrine forbids, because that is
 * how a migration wipes drafts.
 *
 * `immutables` and `blobs` are reused untouched: both are content-addressed by
 * SHAs git produces locally, so neither knows or cares whether a comparison came
 * from a pull request. Nothing here writes `audit_log` or `pr_author`, and that
 * invisibility to the audit journal is deliberate — the journal records writes
 * that reached a client's repository under a shared identity, and a local review
 * reaches no repository at all.
 *
 * `repo` is part of the key from the first row. The pull-request-keyed tables are
 * repo-blind, which only collides when the same pull-request number exists in two
 * repositories sharing one data directory; branch names collide far more readily,
 * since `main` and `feature/x` exist in nearly every repository.
 */
const CREATE_LOCAL_REVIEWS =
  'CREATE TABLE IF NOT EXISTS local_reviews (id INTEGER PRIMARY KEY, ' +
  'repo TEXT NOT NULL, base_ref TEXT NOT NULL, head_ref TEXT NOT NULL, ' +
  'generation INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, ' +
  'base_sha TEXT, merge_base_sha TEXT, head_sha TEXT, ' +
  'dirty INTEGER NOT NULL DEFAULT 0, archived_pr INTEGER, ' +
  'created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_synced_at TEXT, ' +
  'UNIQUE(repo, base_ref, head_ref, generation))'

/**
 * The envelope half of a local review's snapshot, keyed by the local id. The
 * immutable half lands in `immutables` under its own compareKey, exactly as a
 * pull request's does, so a local review and a pull request over the same
 * comparison share one cached copy of the expensive half.
 */
const CREATE_LOCAL_SNAPSHOTS =
  'CREATE TABLE IF NOT EXISTS local_snapshots (local_id INTEGER PRIMARY KEY, data TEXT NOT NULL)'

/** Review threads on a local review, keyed by the local id and the thread id. */
const CREATE_LOCAL_THREADS =
  'CREATE TABLE IF NOT EXISTS local_threads (local_id INTEGER NOT NULL, ' +
  'thread_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (local_id, thread_id))'

/**
 * Submitted review summaries on a local review. `review_id` is declared INTEGER
 * and must stay INTEGER.
 *
 * The ids stored here come from a band around 9e12. That is roughly three orders
 * of magnitude below the largest integer a double represents exactly, so a REAL
 * column would round-trip today's ids with every digit intact — the hazard is not
 * that the current band loses bits, it is that a float column silently stops
 * being exact somewhere above it, with nothing in the schema left to say where.
 * The declaration is the guarantee: an INTEGER column holds a 64-bit integer
 * exactly no matter how far the band or the arithmetic done on an id moves.
 */
const CREATE_LOCAL_REVIEWS_SUBMITTED =
  'CREATE TABLE IF NOT EXISTS local_reviews_submitted (local_id INTEGER NOT NULL, ' +
  'review_id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (local_id, review_id))'

/**
 * Per-human review drafts and per-human per-file viewed state on a local review,
 * keyed exactly as their pull-request-keyed counterparts are: `human_id` first,
 * supplied by the session and overwritten on write, so one human can never write
 * another's row. The key order indexes `human_id` first, which makes a read for
 * one human cheap and makes removing everything belonging to one local review a
 * scan — small at these row counts, and noted rather than indexed against a need
 * nobody has measured.
 */
const CREATE_LOCAL_DRAFTS =
  'CREATE TABLE IF NOT EXISTS local_drafts (human_id TEXT NOT NULL, ' +
  'local_id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (human_id, local_id))'

const CREATE_LOCAL_VIEWED =
  'CREATE TABLE IF NOT EXISTS local_viewed (human_id TEXT NOT NULL, ' +
  'local_id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (human_id, local_id))'

/**
 * The `meta` key holding the highest review id ever handed out for a local
 * review, and the one holding the highest locally minted entity id.
 *
 * A HIGH-WATER MARK, not a row count and not `MAX(id) + 1`. The difference only
 * shows up after a delete: `MAX(id) + 1` re-issues the id of the review that was
 * just removed, so any dependent row the delete happened to miss is silently
 * adopted by an unrelated new review. A mark that only ever moves up makes that
 * impossible however thorough the delete turns out to be.
 *
 * The entity mark lives in `meta` rather than being scanned out of a column
 * because locally minted comment ids live INSIDE the stored review-thread
 * documents; recovering the maximum would mean parsing every thread row. Both
 * marks are durable for the same reason: an id must never be re-issued across a
 * restart, and only the disk survives one.
 *
 * Exported so every reader spells the key the same way. These strings are an
 * on-disk contract: renaming one orphans the row in every file already written,
 * and the next allocator to look for it finds nothing to bump.
 */
export const LOCAL_REVIEW_ID_META_KEY = 'local_review_id_high_water'
export const LOCAL_ENTITY_ID_META_KEY = 'local_entity_id_high_water'

/**
 * Seed both marks one below the first legal value of their band, so the first
 * read-and-bump yields the base itself.
 *
 * `DO NOTHING` on conflict, because a high-water mark is STATE rather than shape:
 * re-asserting the seed over a file that has already handed out ids would hand
 * the next caller an id it has already issued. Written as `ON CONFLICT` rather
 * than as a blanket ignoring insert so a constraint violation still aborts
 * loudly instead of being indistinguishable from a skipped duplicate.
 */
const SEED_ID_HIGH_WATER =
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'

function seedLocalIdHighWaterMarks(db: Database): void {
  db.run(SEED_ID_HIGH_WATER, [LOCAL_REVIEW_ID_META_KEY, String(LOCAL_REVIEW_ID_BASE - 1)])
  db.run(SEED_ID_HIGH_WATER, [LOCAL_ENTITY_ID_META_KEY, String(LOCAL_ENTITY_ID_BASE - 1)])
}

/**
 * Create the local keyspace's six tables when absent. One function called from
 * the create-when-absent shape at the top of `migrate` and again from the guarded
 * step that introduces the keyspace, so the fresh-file shape and the in-place
 * upgrade cannot drift: each statement exists once, and the list of statements to
 * run exists once.
 */
function createLocalTables(db: Database): void {
  db.run(CREATE_LOCAL_REVIEWS)
  db.run(CREATE_LOCAL_SNAPSHOTS)
  db.run(CREATE_LOCAL_THREADS)
  db.run(CREATE_LOCAL_REVIEWS_SUBMITTED)
  db.run(CREATE_LOCAL_DRAFTS)
  db.run(CREATE_LOCAL_VIEWED)
}

/**
 * Create tables if absent and migrate an older store IN PLACE. Migration never
 * drops or reseeds a table — that would wipe drafts — it only creates missing
 * tables and adds columns/defaults, then stamps the current `store_version`.
 *
 * The `meta` row records the version the file was last written at. On open:
 *   - a fresh file (no `meta` row) is stamped at `STORE_VERSION`;
 *   - an older version runs the additive steps between its version and current;
 *   - a version NEWER than this build is left untouched (a future file this
 *     build cannot reason about) — it is not downgraded or reseeded.
 *
 * When the shape changes: bump `STORE_VERSION`, add a `CREATE TABLE IF NOT
 * EXISTS` / `ALTER TABLE … ADD COLUMN` step here defaulting the new field, and
 * the ladder upgrades every existing file without touching a single draft.
 */
function migrate(db: Database): void {
  db.run(
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  )

  // Version 1 shape. Every table is created only when absent, so re-opening a
  // populated store adds nothing and drops nothing.
  db.run(
    'CREATE TABLE IF NOT EXISTS immutables (compare_key TEXT PRIMARY KEY, data TEXT NOT NULL)',
  )
  db.run(
    'CREATE TABLE IF NOT EXISTS snapshots (pr_number INTEGER PRIMARY KEY, data TEXT NOT NULL)',
  )
  db.run('CREATE TABLE IF NOT EXISTS blobs (sha TEXT PRIMARY KEY, data TEXT NOT NULL)')
  db.run(
    'CREATE TABLE IF NOT EXISTS drafts (human_id TEXT NOT NULL, pr_number INTEGER NOT NULL, ' +
      'data TEXT NOT NULL, PRIMARY KEY (human_id, pr_number))',
  )
  db.run(
    'CREATE TABLE IF NOT EXISTS viewed (human_id TEXT NOT NULL, pr_number INTEGER NOT NULL, ' +
      'data TEXT NOT NULL, PRIMARY KEY (human_id, pr_number))',
  )
  db.run('CREATE TABLE IF NOT EXISTS prefs (human_id TEXT PRIMARY KEY, data TEXT NOT NULL)')

  // Version 2 shape: the append-only audit journal. Created-when-absent like
  // every table above, so a fresh file carries it immediately; the guarded
  // ladder below runs the same statement for an existing version-1 file.
  db.run(CREATE_AUDIT_LOG)

  // Version 3 shape: the pull-request author attribution seam. Created-when-
  // absent like every table above; the guarded ladder below runs the same
  // statement for an existing version-1 or version-2 file.
  db.run(CREATE_PR_AUTHOR)

  // Version 4 shape: the local-review keyspace. Created-when-absent like every
  // table above; the guarded ladder below runs the same statements for a file
  // stamped at any earlier version.
  createLocalTables(db)

  const row = db.query("SELECT value FROM meta WHERE key = 'store_version'").get() as
    | { value: string }
    | null
  const current = row ? Number(row.value) : null

  if (current === null) {
    // Fresh file: seed the local id high-water marks and stamp the current
    // version. (No data to migrate.) The marks are seeded on the two paths where
    // a starting value is legitimate — a brand-new file, and a file crossing into
    // the version that introduces them — and never re-asserted over a file that
    // already carries them, so a mark that has moved is never walked back.
    seedLocalIdHighWaterMarks(db)
    db.run(
      "INSERT INTO meta (key, value) VALUES ('store_version', ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [String(STORE_VERSION)],
    )
    return
  }

  if (current > STORE_VERSION) {
    // A file from a newer build. Do not downgrade or reseed — leave it be; the
    // additive tables above are already present, so reads still work.
    return
  }

  // Additive migration steps, oldest → newest, each guarded by `if (current < N)`
  // and each only creating tables or defaulting columns — never dropping,
  // rewriting, or reseeding a row, so drafts and every other table survive
  // untouched.

  if (current < 2) {
    // v1 → v2: add the append-only `audit_log` journal. Purely additive — the
    // idempotent CREATE (already run above for the current shape) is the entire
    // step; no existing row is read or rewritten.
    db.run(CREATE_AUDIT_LOG)
  }

  if (current < 3) {
    // v2 → v3: add the `pr_author` attribution table. Purely additive — the
    // idempotent CREATE (already run above for the current shape) is the entire
    // step; no existing row is read or rewritten, so drafts, viewed state, and
    // the audit journal survive untouched.
    db.run(CREATE_PR_AUTHOR)
  }

  if (current < 4) {
    // v3 → v4: add the local-review keyspace and the two id high-water marks its
    // minters read and bump. Purely additive — the idempotent CREATEs (already
    // run above for the current shape) plus two `meta` rows; no existing row is
    // read or rewritten, so drafts, viewed state, the audit journal and the
    // attribution table all survive untouched.
    //
    // The marks are seeded HERE as well as on the fresh-file path because a file
    // written before this shape existed carries neither, and a minter with no row
    // to bump cannot allocate an id at all. Seeding only the fresh-file path
    // would open that hole exclusively for upgraded workspaces while every newly
    // created one kept working — a failure the common case cannot surface.
    createLocalTables(db)
    seedLocalIdHighWaterMarks(db)
  }

  if (current < STORE_VERSION) {
    db.run("UPDATE meta SET value = ? WHERE key = 'store_version'", [String(STORE_VERSION)])
  }
}
