import type { CreateLocalReviewInput, GhRef, GhUser, Human, LocalReviewSummary, PullDetail, ReactionRollup, ReviewComment, ReviewSummary, ReviewThread, Snapshot, SubmitResult, SubmitReviewInput } from '@revu/shared'
import { ApiError, isValidRefName, normalizeRefName } from '@revu/shared'
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

export function getLocalReview(id: number): LocalReviewSummary | null {
  const record = store.getLocalReview(id)
  return record ? toSummary(record) : null
}

/**
 * Delete a local review: the record, its materialized threads and submitted
 * reviews, and its cached snapshot all go. Per-human drafts and viewed state
 * are deliberately left in place — user-written text is never destroyed,
 * only orphaned, and the id is never minted again so nothing can inherit it.
 * Pruning shared content-addressed blobs is a retention concern, not a
 * delete concern: blobs may be referenced by other snapshots.
 */
export function deleteLocalReview(id: number): void {
  requireLocalReview(id)
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
 * Submit a review against a local branch pair.
 *
 * Mirrors the transport semantics of every other submit path: a moved head is
 * a RETURNED `head_moved` value, never a throw, and it leaves the draft
 * untouched. On success each pending comment is materialized into a thread
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

  const snap = store.getSnapshot(input.prNumber)
  if (snap) {
    snap.mutable.threads.push(...newThreads)
    const authors = (snap.mutable.commentAuthors ??= {})
    for (const t of newThreads) {
      for (const c of t.comments) authors[c.id] = human.id
    }
    snap.mutable.pull.review_comments += input.comments.length
    // snap.mutable.reviews is deliberately not touched: submitted local
    // reviews are read from the local record, and this array stays empty.
    store.putSnapshot(snap)
  }

  // Deletion stays gated on confirmed submit success — trivially satisfied by
  // a synchronous sink, and still coded on the success path only.
  store.deleteDraft(human.id, input.prNumber)
  return { status: 'ok', review }
}
