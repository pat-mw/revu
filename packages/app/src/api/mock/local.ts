import type { BranchRef, BrokerPullMeta, CreateLocalReviewInput, GhRef, GhUser, Human, LocalReviewSummary, PullDetail, ReactionKey, ReactionRollup, ReviewComment, ReviewSummary, ReviewThread, Snapshot, SubmitResult, SubmitReviewInput } from '@revu/shared'
import { ApiError, draftHoldsText, isValidRefName, normalizeRefName } from '@revu/shared'
import type { FixtureDB } from '@/fixtures/contract'
import { fixtureDB } from '@/fixtures'
import { fakeSha } from '@/fixtures/helpers'
import type { LocalReviewRecord } from './store'
import { store } from './store'

/**
 * Local-only reviews: the full review workflow over a branch pair that has no
 * pull request, with nothing ever sent to GitHub.
 *
 * The no-GitHub property is structural, not conditional — this module imports
 * no fixture remote, no identity stamping, and never touches the simulated
 * shared rate bucket. Everything it produces lives in the mock store: the
 * review record, the synthesized snapshot, the materialized threads, and the
 * submitted review summaries.
 *
 * Identity rules that bind every shape produced here:
 * - The synthesized user carries the reviewer's display NAME with empty
 *   `avatar_url`/`html_url` — never an email. `Human.id` is a storage key; it
 *   may be recorded on a comment (`commentAuthors`) but is never rendered
 *   into a body or a user object.
 * - Comment and review bodies are stored VERBATIM. The `**Name** (role)`
 *   stamp exists only because many humans share one GitHub bot account;
 *   locally there is exactly one author and the store records who it was, so
 *   a stamp here would render as literal body text.
 *
 * Id discipline: review ids come from the reserved local review band and
 * comment/review-summary ids from the reserved local entity band, both minted
 * off persisted high-water marks — always positive (negative ids belong to
 * the UI's optimistic synthetics) and never reused after a delete.
 *
 * Transport concerns — latency, failure modes, HTTP mapping — belong to the
 * adapter that fronts these functions; this module is synchronous store logic.
 */

const db = fixtureDB as FixtureDB

function nowISO(): string {
  return new Date().toISOString()
}

function currentHuman(): Human {
  const dev = store.getDev()
  const h = db.humans.find((x) => x.id === dev.humanId) ?? db.humans[0]
  return { ...h }
}

/** Display form of a fully qualified ref (`refs/heads/x` → `x`, `refs/remotes/origin/x` → `origin/x`). */
function shortRefName(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length)
  if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length)
  return ref
}

/**
 * The current tip of a ref, as this store's stand-in for `git rev-parse`.
 * Deterministic per `(repo, ref)` so a re-sync sees the same tip, the compare
 * key is stable, and the content-addressed cache stays honest.
 */
function liveRefSha(repo: string, ref: string): string {
  return fakeSha(`local:${repo}:${ref}`)
}

function requireLocalReview(id: number): LocalReviewRecord {
  const record = store.getLocalReview(id)
  if (!record) {
    throw new ApiError(
      'not_found',
      `No local review with id ${id} exists in this workspace.`,
    )
  }
  return record
}

/** The wire summary is exactly the record's scalar fields — nothing store-only leaks. */
function toSummary(record: LocalReviewRecord): LocalReviewSummary {
  return {
    id: record.id,
    repo: record.repo,
    baseRef: record.baseRef,
    headRef: record.headRef,
    title: record.title,
    baseSha: record.baseSha,
    mergeBaseSha: record.mergeBaseSha,
    headSha: record.headSha,
    dirty: record.dirty,
    archivedPr: record.archivedPr,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastSyncedAt: record.lastSyncedAt,
  }
}

/**
 * The sentinel author for everything a local review produces. The display
 * name rides in `login` (the only name-shaped field a GitHub user has);
 * `type: 'Bot'` marks it as not a genuine GitHub account; the URLs are empty
 * because there is nothing on github.com to link to. It never carries an
 * email — `Human.id` stays a storage key. `id: 0` sits outside every real
 * band: GitHub user ids are positive and nothing local mints user ids.
 */
export function synthesizeLocalUser(name: string): GhUser {
  return {
    login: name,
    id: 0,
    node_id: 'local:user',
    avatar_url: '',
    html_url: '',
    type: 'Bot',
  }
}

/**
 * The id of a locally materialized review thread:
 * `local:<review id>:<root comment id>`.
 *
 * Nothing parses thread ids — they travel opaquely through routes and query
 * keys — so the only reader this shape serves is a person looking at a log.
 * It is deliberately NOT GitHub-shaped: a local id that strays into a
 * GitHub-bound code path should be visibly local at a glance, and carrying
 * the owning review id makes a mis-routed id self-describing. Derived from
 * the root comment's id the same way GitHub-shaped mocks derive theirs, so
 * no extra counter exists to persist.
 */
export function localThreadId(reviewId: number, rootCommentId: number): string {
  return `local:${reviewId}:${rootCommentId}`
}

/** Zeroed reaction rollup with no GitHub URL — there is no github.com resource behind it. */
function emptyLocalReactions(): ReactionRollup {
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
 * Synthesize the GitHub-shaped `PullDetail` a local review presents, so every
 * surface downstream of a snapshot works unchanged. Every field has a legal
 * local value:
 *
 * - `number` and `id` are both the local review id — deterministic, so
 *   re-synthesis never churns identity; `node_id` is `local:<id>`.
 * - `state` is `open` until a pull request supersedes the review.
 * - `user` is the sentinel local reviewer (name only, never an email).
 * - `head`/`base` carry the real branch names and current tips; the repo
 *   identity is the local repository's. There is no fork namespace locally,
 *   so `label` equals the short ref name.
 * - `mergeable: null` / `mergeable_state: 'unknown'` — nothing computes
 *   mergeability locally, and both are already legal.
 * - The counts are derived from what the review actually holds; issue
 *   comments do not exist locally, so `comments` is always 0.
 */
function synthesizePullDetail(
  record: LocalReviewRecord,
  reviewer: Human,
  shas: { baseSha: string; mergeBaseSha: string; headSha: string },
): PullDetail {
  const ghRef = (ref: string, sha: string): GhRef => ({
    ref: shortRefName(ref),
    sha,
    label: shortRefName(ref),
    repo: { full_name: record.repo, default_branch: db.repo.default_branch },
  })
  return {
    id: record.id,
    node_id: `local:${record.id}`,
    number: record.id,
    state: record.archivedPr === null ? 'open' : 'closed',
    draft: false,
    merged_at: null,
    title: record.title,
    body: null,
    user: synthesizeLocalUser(reviewer.name),
    labels: [],
    requested_reviewers: [],
    head: ghRef(record.headRef, shas.headSha),
    base: ghRef(record.baseRef, shas.baseSha),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    merged: false,
    mergeable: null,
    mergeable_state: 'unknown',
    merge_base_sha: shas.mergeBaseSha,
    comments: 0,
    review_comments: record.threads.reduce((n, t) => n + t.comments.length, 0),
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  }
}

/**
 * The branches this workspace offers as review sides.
 *
 * Nothing git-shaped stands behind this store, so the listing is a fixed
 * fixture rather than a `for-each-ref` read — chosen to exercise everything a
 * picker has to handle: local branches and remote-tracking refs side by side,
 * a base that exists ONLY as a remote-tracking ref, nested names, and exactly
 * one default branch, which is the natural base preselection.
 *
 * Every ref is fully qualified because that is the only unambiguous form: a
 * bare `origin/main` cannot be told apart from a local branch literally named
 * `origin/main`, and a bare name is always read as a local branch when a
 * creation request normalizes it.
 */
export function listBranches(): BranchRef[] {
  const defaultBranch = db.repo.default_branch
  const localNames = [
    defaultBranch,
    'release/0.41',
    'chore/node-22',
    'feat/gateway-rate-limiting',
    'fix/cache-ttl-jitter',
    'marcus/strict-null-checks',
  ]
  // `metering/usage-rollups` is deliberately tracked but not checked out —
  // the "base exists only on the remote" case a picker must still offer.
  const remoteNames = [
    `origin/${defaultBranch}`,
    'origin/release/0.41',
    'origin/metering/usage-rollups',
  ]
  return [
    ...localNames.map((name): BranchRef => ({
      ref: `refs/heads/${name}`,
      name,
      kind: 'local',
      isDefault: name === defaultBranch,
    })),
    ...remoteNames.map((name): BranchRef => ({
      ref: `refs/remotes/${name}`,
      name,
      kind: 'remote',
      // The default marker names the one branch to preselect as a base, and a
      // remote-tracking copy of it is a different ref — so it is never marked.
      isDefault: false,
    })),
  ]
}

/**
 * Create a local review of `headRef` against `baseRef`, or return the one
 * that already exists for the same `(repo, baseRef, headRef)` — creation is
 * idempotent per branch pair, the in-document form of a uniqueness
 * constraint on those three columns.
 *
 * Both refs are validated syntactically and stored fully qualified, so the
 * same branch spelled bare and qualified lands on one record. Base and head
 * naming the same ref, or a ref failing validation, is `unprocessable`: the
 * request is well-formed but cannot be satisfied as given.
 */
export function createLocalReview(input: CreateLocalReviewInput): LocalReviewSummary {
  for (const [side, ref] of [
    ['base', input.baseRef],
    ['head', input.headRef],
  ] as const) {
    if (!isValidRefName(ref)) {
      throw new ApiError(
        'unprocessable',
        `The ${side} ref ${JSON.stringify(ref)} is not a valid git ref name.`,
      )
    }
  }
  const baseRef = normalizeRefName(input.baseRef)
  const headRef = normalizeRefName(input.headRef)
  if (baseRef === headRef) {
    throw new ApiError(
      'unprocessable',
      `Base and head name the same ref (${baseRef}) — a review needs two different sides.`,
    )
  }

  const repo = db.repo.full_name
  const existing = store.findLocalReviewByRefs(repo, baseRef, headRef)
  if (existing) return toSummary(existing)

  const at = nowISO()
  const record: LocalReviewRecord = {
    id: store.nextLocalReviewId(),
    repo,
    baseRef,
    headRef,
    title: input.title?.trim() ? input.title.trim() : shortRefName(headRef),
    baseSha: null,
    mergeBaseSha: null,
    headSha: null,
    dirty: false,
    archivedPr: null,
    createdAt: at,
    updatedAt: at,
    lastSyncedAt: null,
    submitted: [],
    threads: [],
    commentAuthors: {},
  }
  store.putLocalReview(record)
  return toSummary(record)
}

export function listLocalReviews(): LocalReviewSummary[] {
  return store.listLocalReviews().map(toSummary)
}

/** One local review projected into the two halves a pull-list row carries. */
export interface LocalPullRow {
  detail: PullDetail
  broker: BrokerPullMeta
}

/**
 * Every local review as a pull-list row.
 *
 * The pull list is the row source for every review the app renders — a review
 * missing from it resolves to "this pull request isn't in this installation"
 * on every open — so local reviews belong in it alongside pull requests. This
 * is the ONLY way one gets there: every local review is a record in this
 * store, whether it was seeded with the fixtures or created at runtime, so a
 * single review can never arrive by two routes and appear twice.
 *
 * The broker half is derived, not stored:
 * - `authorHumanId` is null. It names the human who drove the App identity
 *   when a pull request was opened; no pull request was opened here, so no
 *   surface may claim one was.
 * - `canApprove` is true — GitHub's self-review refusal has no local analogue,
 *   and every verdict stays available.
 * - No reviewers can be assigned where there is no pull request to assign them
 *   to, and `checks` is ABSENT rather than empty: nothing has reported on a
 *   branch that was never pushed, which is neither a pass nor a failure.
 * - The compare key is read from the ref tips as they are NOW, not from the
 *   last sync, so a row still tells the truth about a branch that moved.
 */
export function listLocalPullRows(): LocalPullRow[] {
  const reviewer = currentHuman()
  return store.listLocalReviews().map((record) => {
    const headSha = liveRefSha(record.repo, record.headRef)
    const baseSha = liveRefSha(record.repo, record.baseRef)
    const mergeBaseSha = headSha
    return {
      detail: synthesizePullDetail(record, reviewer, { baseSha, mergeBaseSha, headSha }),
      broker: {
        authorHumanId: null,
        canApprove: true,
        unresolvedThreads: record.threads.filter((t) => !t.isResolved).length,
        assignedReviewerHumanIds: [],
        compareKey: `${mergeBaseSha}...${headSha}`,
        commitCount: 0,
      },
    }
  })
}

export function getLocalReview(id: number): LocalReviewSummary | null {
  const record = store.getLocalReview(id)
  return record ? toSummary(record) : null
}

/**
 * Delete a local review: the record, its materialized threads and submitted
 * reviews, its cached snapshot, and every human's draft and viewed state on
 * it all go, and the id is never minted again so nothing can inherit it.
 *
 * The delete is REFUSED outright, as `unprocessable`, while any human's draft
 * on the review holds text — a pending comment, or a body with anything in it.
 * A delete is server-authoritative and has no flag to force it, so the only
 * way past the refusal is the one the message names: discard the draft, then
 * delete. That is what keeps "drafts survive everything" true for a
 * user-initiated delete as well as for a submit — text a human wrote leaves
 * this store only by that human's own discard or by a confirmed submit, and
 * the delete can therefore only ever take drafts that hold nothing. The
 * check spans EVERY human's draft, not the caller's alone, because two
 * reviewers of one branch pair hold two drafts and the delete would take
 * both; and it is the empty, editor-created draft that is allowed through,
 * because a check that counted an untouched draft as text would make every
 * review a human had merely opened undeletable.
 *
 * `unprocessable` is the exact code: the review exists (so not `not_found`),
 * nothing moved underneath the caller (so not `conflict`), and the caller can
 * put the review into a state that honors the identical request. It is a
 * precondition checked before the record is touched, so a refusal never
 * leaves the review half removed.
 *
 * Pruning shared content-addressed blobs is a retention concern, not a delete
 * concern: blobs may be referenced by other snapshots.
 */
export function deleteLocalReview(id: number): void {
  requireLocalReview(id)
  if (store.listDraftsFor(id).some(draftHoldsText)) {
    throw new ApiError(
      'unprocessable',
      `Local review ${id} still holds an unsubmitted draft with text in it — discard that draft, then delete the review.`,
    )
  }
  store.deleteLocalReview(id)
}

/**
 * Every review submitted against this local review. Submitted local reviews
 * live on the local record and are read from here — they are never appended
 * to `snapshot.mutable.reviews`, which stays empty so the conversation
 * surface of a local review is threads-only.
 */
export function listLocalSubmittedReviews(id: number): ReviewSummary[] {
  return requireLocalReview(id).submitted
}

/**
 * Sync a local review: read the current ref tips, refresh the record's SHA
 * fields, and persist a fresh snapshot under the local id — the same store
 * path every other snapshot uses, so cached reads, drafts, and reconcile all
 * work unchanged.
 *
 * This store has no git objects behind a runtime-created branch pair, so the
 * honest snapshot is the empty compare: merge base equals the head tip, no
 * files, no commits — the already-legal "head has no commits ahead of base"
 * review. A snapshot builder with a real repository behind it computes the
 * true merge base and diff instead; everything else here is shape.
 *
 * The sync costs nothing: no network, no rate budget, `requests: 0`.
 */
export function syncLocalReview(id: number): Snapshot {
  const record = requireLocalReview(id)
  const at = nowISO()
  const headSha = liveRefSha(record.repo, record.headRef)
  const baseSha = liveRefSha(record.repo, record.baseRef)
  const mergeBaseSha = headSha

  record.baseSha = baseSha
  record.mergeBaseSha = mergeBaseSha
  record.headSha = headSha
  record.dirty = false
  record.lastSyncedAt = at
  record.updatedAt = at
  store.putLocalReview(record)

  const snapshot: Snapshot = {
    prNumber: record.id,
    syncedAt: at,
    partial: null,
    syncStats: { blobsFetched: 0, blobsReused: 0, requests: 0 },
    immutable: {
      compareKey: `${mergeBaseSha}...${headSha}`,
      mergeBaseSha,
      headSha,
      files: [],
      blobIndex: {},
      commits: [],
    },
    mutable: {
      fetchedAt: at,
      pull: synthesizePullDetail(record, currentHuman(), { baseSha, mergeBaseSha, headSha }),
      threads: record.threads,
      issueComments: [],
      // Submitted local reviews live on the record, never here — rebuilt
      // empty on every sync.
      reviews: [],
      checks: [],
      commentAuthors: record.commentAuthors,
    },
  }
  store.putSnapshot(snapshot)
  return snapshot
}

/**
 * Republish a review's materialized threads into its cached snapshot.
 *
 * The record is the durable home of a local thread and the snapshot is the
 * surface reads come off, so every write updates the record first and then
 * refreshes the snapshot from it wholesale — one direction, one truth, and the
 * same rebuild a re-sync performs. A review with no snapshot yet has nothing
 * to refresh; the next sync builds it from the same record.
 *
 * `mutable.reviews` is deliberately never written here: submitted verdicts
 * live on the record alone.
 */
function refreshSnapshotThreads(record: LocalReviewRecord): void {
  const snap = store.getSnapshot(record.id)
  if (!snap) return
  snap.mutable.threads = record.threads
  snap.mutable.commentAuthors = record.commentAuthors
  snap.mutable.pull.review_comments = record.threads.reduce(
    (n, t) => n + t.comments.length,
    0,
  )
  store.putSnapshot(snap)
}

/** The thread with this id on this review, or a typed `not_found`. */
function requireLocalThread(record: LocalReviewRecord, threadId: string): ReviewThread {
  const thread = record.threads.find((t) => t.id === threadId)
  if (!thread) {
    throw new ApiError(
      'not_found',
      `Thread ${threadId} was not found on local review ${record.id}.`,
    )
  }
  return thread
}

/**
 * Submit a review against a local branch pair.
 *
 * A review with no snapshot is REFUSED as `unprocessable`. Submitting
 * materializes threads, and threads are read off the snapshot; with none to
 * publish into, the verdict and its comments would land on the record while
 * every snapshot-backed read kept answering empty — a list row counting
 * unresolved threads that nothing can open. Nothing would be lost, but the
 * state would be invisible, so the request is turned away rather than half
 * honored. `unprocessable` is its exact shape: the request is well-formed and
 * the review exists, but its current state cannot satisfy the request —
 * syncing puts it in one that can, which is what the message tells the caller.
 * The check precedes every write, so a refusal never leaves the record
 * partially updated.
 *
 * Otherwise it mirrors the transport semantics of every other submit path: a
 * moved head is a RETURNED `head_moved` value, never a throw, and it leaves the
 * draft untouched. On success each pending comment is materialized into a thread
 * whose comment ids come from the positive local entity band (negatives
 * belong to the UI's optimistic synthetics), bodies are stored verbatim with
 * authorship recorded as a key beside them, the summary is persisted on the
 * local record — never in `snapshot.mutable.reviews` — and the draft is
 * deleted only after that confirmed success.
 *
 * All three verdicts stay available: there is no self-review rule to enforce
 * because no GitHub identity opened anything, so no `forbidden` branch
 * exists. The idempotency re-check and the post-submit re-validation of
 * other submit paths guard against lost network responses and a remote's
 * second opinion; a synchronous local sink has neither, so neither appears.
 */
export function submitLocalReview(input: SubmitReviewInput): SubmitResult {
  const record = requireLocalReview(input.prNumber)
  // Ahead of the head guard as well as of every write: with no snapshot there
  // is no compare behind the expected SHA, so answering `head_moved` would
  // send the reviewer to reconcile against a snapshot that does not exist.
  // Guarded on the snapshot itself rather than on `lastSyncedAt`, because the
  // snapshot is the thing a submit actually needs. Every runtime path keeps
  // the pair together — a sync writes both, a delete drops both — but the
  // load path does not guarantee it: a persisted document is admitted on its
  // top-level fields with no cross-check of the pairing, so a record can
  // arrive claiming a past sync with no snapshot behind it. On that record a
  // `lastSyncedAt` key would accept the submit into threads no
  // snapshot-backed read could return; this key refuses it.
  if (!store.getSnapshot(record.id)) {
    throw new ApiError(
      'unprocessable',
      `Local review ${record.id} has no stored snapshot for its threads to appear in — sync it, then submit.`,
    )
  }
  const currentHeadSha = liveRefSha(record.repo, record.headRef)

  if (input.expectedHeadSha !== currentHeadSha) {
    // Head moved under the draft — an amend or rebase locally, with no event
    // to announce it. The local compare carries no commit list, so the honest
    // new-commit count is zero; the SHA mismatch itself is the signal.
    return { status: 'head_moved', currentHeadSha, newCommits: 0 }
  }

  const human = currentHuman()
  const at = nowISO()
  const user = synthesizeLocalUser(human.name)
  const reviewId = store.nextLocalEntityId()
  const stateMap = {
    COMMENT: 'COMMENTED',
    APPROVE: 'APPROVED',
    REQUEST_CHANGES: 'CHANGES_REQUESTED',
  } as const
  const review: ReviewSummary = {
    id: reviewId,
    node_id: `local:review:${reviewId}`,
    user,
    // Verbatim — the stamped body prefix exists only because many humans
    // share one GitHub bot; here the author is recorded, not smuggled.
    body: input.body,
    state: stateMap[input.event],
    submitted_at: at,
    commit_id: currentHeadSha,
  }

  const newThreads: ReviewThread[] = input.comments.map((c) => {
    const commentId = store.nextLocalEntityId()
    const comment: ReviewComment = {
      id: commentId,
      node_id: `local:comment:${commentId}`,
      pull_request_review_id: reviewId,
      path: c.path,
      // This store's local compare carries no patches to slice, so the hunk
      // is the minimal single-line header; a builder with a real diff in
      // hand slices the true containing hunk instead.
      diff_hunk: `@@ -${c.line},1 +${c.line},1 @@`,
      commit_id: currentHeadSha,
      original_commit_id: currentHeadSha,
      line: c.line,
      original_line: c.line,
      start_line: c.start_line,
      original_start_line: c.start_line,
      side: c.side,
      start_side: c.start_side,
      subject_type: 'line',
      user,
      body: c.body,
      created_at: at,
      updated_at: at,
      reactions: emptyLocalReactions(),
      html_url: '',
    }
    record.commentAuthors[commentId] = human.id
    return {
      id: localThreadId(record.id, commentId),
      isResolved: false,
      isOutdated: false,
      path: c.path,
      line: c.line,
      originalLine: c.line,
      startLine: c.start_line,
      originalStartLine: c.start_line,
      diffSide: c.side,
      startDiffSide: c.start_side,
      subjectType: 'LINE',
      resolvedBy: null,
      comments: [comment],
    }
  })

  record.threads.push(...newThreads)
  record.submitted.push(review)
  record.updatedAt = at
  store.putLocalReview(record)
  refreshSnapshotThreads(record)

  // Deletion stays gated on confirmed submit success — trivially satisfied by
  // a synchronous sink, and still coded on the success path only.
  store.deleteDraft(human.id, input.prNumber)
  return { status: 'ok', review }
}

/**
 * Reply to a materialized local thread.
 *
 * The comment is the thread's own anchor with a new positive entity-band id
 * and the body exactly as written — the client swaps its optimistic entry by
 * id, so a duplicate or negative id would orphan it. Authorship is recorded
 * beside the comment as a key, never smuggled into the text.
 */
export function replyToLocalThread(
  reviewId: number,
  threadId: string,
  body: string,
): ReviewComment {
  const record = requireLocalReview(reviewId)
  const thread = requireLocalThread(record, threadId)
  const root = thread.comments[0]
  if (!root) {
    throw new ApiError(
      'not_found',
      `Thread ${threadId} on local review ${reviewId} has no comment to reply to.`,
    )
  }

  const human = currentHuman()
  const at = nowISO()
  const id = store.nextLocalEntityId()
  const comment: ReviewComment = {
    id,
    node_id: `local:comment:${id}`,
    pull_request_review_id: root.pull_request_review_id,
    in_reply_to_id: root.id,
    path: thread.path,
    diff_hunk: root.diff_hunk,
    commit_id: liveRefSha(record.repo, record.headRef),
    original_commit_id: root.original_commit_id,
    line: thread.line,
    original_line: thread.originalLine,
    start_line: null,
    original_start_line: null,
    side: thread.diffSide,
    start_side: null,
    subject_type: thread.subjectType === 'FILE' ? 'file' : 'line',
    user: synthesizeLocalUser(human.name),
    body,
    created_at: at,
    updated_at: at,
    reactions: emptyLocalReactions(),
    html_url: '',
  }

  thread.comments.push(comment)
  record.commentAuthors[id] = human.id
  record.updatedAt = at
  store.putLocalReview(record)
  refreshSnapshotThreads(record)
  return comment
}

/**
 * Resolve or unresolve a local thread, returning the whole normalized thread —
 * the client copies its resolution fields back out of the response, so a
 * partial answer would snap an optimistic flip back with no error.
 *
 * Resolution is attributed to the local reviewer by DISPLAY NAME: there is no
 * bot account to name here, and an email is never rendered.
 */
export function resolveLocalThread(
  reviewId: number,
  threadId: string,
  resolved: boolean,
): ReviewThread {
  const record = requireLocalReview(reviewId)
  const thread = requireLocalThread(record, threadId)
  thread.isResolved = resolved
  thread.resolvedBy = resolved ? { login: currentHuman().name } : null
  record.updatedAt = nowISO()
  store.putLocalReview(record)
  refreshSnapshotThreads(record)
  return thread
}

/**
 * React to a comment on a local review, returning the rollup the client
 * renders — returning a stale one would silently revert the optimistic bump.
 *
 * The rollup is SHARED PER REVIEW, not per person. It records which emoji are
 * on a comment and never who put them there, so a reviewer adding an emoji the
 * comment already carries receives the unchanged rollup and no error. That is
 * a deliberate, system-wide choice rather than an omission here: reactions
 * everywhere in this product are shared-and-honest, because on the paths that
 * do reach GitHub many humans write through one account, which makes every
 * reaction the same reaction no matter who clicked it. Simulating per-person
 * reaction state on this path alone would make a local review the one surface
 * whose counts mean something different from every other surface, so it is not
 * built — the repeat no-op below is the specified behavior, not a gap to close.
 *
 * Adding a reaction does not float the review's `updatedAt`, matching how a
 * reaction leaves a pull request's own timestamp alone.
 */
export function addLocalReaction(
  reviewId: number,
  commentId: number,
  reaction: ReactionKey,
): ReactionRollup {
  const record = requireLocalReview(reviewId)
  const comment = record.threads
    .flatMap((t) => t.comments)
    .find((c) => c.id === commentId)
  if (!comment) {
    throw new ApiError(
      'not_found',
      `Comment ${commentId} was not found on local review ${reviewId}.`,
    )
  }
  if (comment.reactions[reaction] > 0) return comment.reactions

  comment.reactions[reaction] += 1
  comment.reactions.total_count += 1
  store.putLocalReview(record)
  refreshSnapshotThreads(record)
  return comment.reactions
}
