import type {
  ReactionKey,
  ReactionRollup,
  ReviewComment,
  ReviewSummary,
  ReviewThread,
  Session,
  SubmitResult,
  SubmitReviewInput,
} from '@revu/shared'
import { ApiError } from '@revu/shared'
import type { GithubClient, ReviewCommentInput, SubmitReviewBody } from './github-client'
import { GithubRequestError } from './github-client'
import { mapReactions, mapReview, mapReviewComment } from './mappers'
import type { RepoRef } from './repo'
import type { DirectStore } from './store'
import { normalizeReviewThread } from './threads'
import type { WriteDecorator } from './write-decorator'

/**
 * The direct-mode WRITE path: submit a review, reply to a thread, resolve a
 * thread, add a reaction. This is the shared write core the integration guide
 * describes — the mode-varying bits (does a body get stamped? is there an audit
 * log?) are injected as a `WriteDecorator`, so this file is identical across
 * deployment modes and the difference lives in one small strategy file.
 *
 * The invariants this module exists to protect (the product's differentiators):
 *
 *   - A draft SURVIVES everything. It is deleted from the store ONLY after a
 *     confirmed successful review creation. A head-move, a 422 validation
 *     failure, or any error leaves the draft intact so the human never loses
 *     work and can reconcile and resubmit.
 *   - `submitReview` returns `head_moved` as a 200-level VALUE, never an error:
 *     the guard reads the current head and, on a mismatch, returns the value
 *     WITHOUT posting anything, so the UI routes into reconcile.
 *   - Submit is idempotent under a retry-after-timeout: before posting, it
 *     re-checks GitHub for a matching review it may already have created (the
 *     first response was lost), and short-circuits to that review rather than
 *     double-posting.
 *   - Comments post as the authenticated GitHub user (the `WriteDecorator` is a
 *     passthrough in direct mode); no email ever enters a comment body.
 */

/** Everything a write operation needs, injected so the core is unit-testable with fakes. */
export interface WriteDeps {
  github: GithubClient
  repo: RepoRef
  store: DirectStore
  session: Session
  /** Stamps bodies + records writes; a passthrough in direct mode. */
  writeDecorator: WriteDecorator
  /** Timestamp source; injectable for deterministic tests. */
  now?: () => string
}

/** GitHub REST state string for each contract review event. */
const EVENT_STATE: Record<SubmitReviewInput['event'], ReviewSummary['state']> = {
  COMMENT: 'COMMENTED',
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
}

/**
 * Map one `PendingComment` onto the REST review-comment input, 1:1. A multi-line
 * comment (`start_line !== null`) sends `start_line`/`start_side`; a single-line
 * comment OMITS them entirely — GitHub rejects a review comment whose
 * `start_line` equals its `line`, so the fields are added ONLY when there is a
 * genuine range. `start_side` falls back to the end-line side when the draft did
 * not record a distinct start side.
 */
function toCommentInput(c: {
  path: string
  side: 'LEFT' | 'RIGHT'
  start_side: 'LEFT' | 'RIGHT' | null
  line: number
  start_line: number | null
  body: string
}): ReviewCommentInput {
  const input: ReviewCommentInput = {
    path: c.path,
    side: c.side,
    line: c.line,
    body: c.body,
  }
  if (c.start_line !== null) {
    input.start_line = c.start_line
    input.start_side = c.start_side ?? c.side
  }
  return input
}

/**
 * Whether a persisted review's REVIEW-LEVEL fields match "the one this submit
 * would have created" — the first half of the retry short-circuit that keeps a
 * lost first response from double-posting. A match is the same viewer, the same
 * target commit, the same verdict, and the same body. Body comparison uses the
 * DECORATED body (what was actually posted), so a stamping mode compares apples
 * to apples.
 *
 * This key alone is NOT sufficient to short-circuit: two DIFFERENT submits at
 * the same head share it whenever the summary body repeats — an empty body on
 * an inline-comments-only review is the everyday case — and treating the older
 * review as "already posted" would silently swallow the new comments and delete
 * the new draft. A key-matching candidate must ALSO pass the comment-level
 * check in `reviewCommentsMatch` before the short-circuit fires.
 */
function reviewMatches(
  review: ReviewSummary,
  viewerLogin: string,
  commitId: string,
  state: ReviewSummary['state'],
  decoratedBody: string,
): boolean {
  return (
    review.user.login === viewerLogin &&
    review.commit_id === commitId &&
    review.state === state &&
    review.body === decoratedBody
  )
}

/** The order-independent identity of one inline comment as this submit would post it. */
function inputCommentKey(c: ReviewCommentInput): string {
  return JSON.stringify([c.path, c.side, c.start_line ?? null, c.line, c.body])
}

/**
 * The same identity read from a raw REST review comment GitHub returns.
 * `original_line` / `original_start_line` are the AS-POSTED positions — they
 * never change after posting — so the comparison holds even if the comment has
 * since gone outdated (where `line` can shift or null out).
 */
function postedCommentKey(raw: unknown): string {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const num = (k: string): number | null => (typeof c[k] === 'number' ? (c[k] as number) : null)
  return JSON.stringify([
    typeof c.path === 'string' ? c.path : '',
    c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
    num('original_start_line'),
    num('original_line') ?? num('line'),
    typeof c.body === 'string' ? c.body : '',
  ])
}

/**
 * Whether an existing review's posted inline comments are exactly the ones this
 * submit carries — the second half of the retry short-circuit. Compared as an
 * unordered multiset of (path, side, as-posted start/end line, decorated body):
 * a true retry re-sends identical comments and matches; a different submit that
 * merely shares the review-level key does not, and posts fresh. Reads
 * `GET /pulls/{n}/reviews/{id}/comments`, paginating only while the count could
 * still match.
 */
async function reviewCommentsMatch(
  github: GithubClient,
  repo: RepoRef,
  prNumber: number,
  reviewId: number,
  inputs: ReviewCommentInput[],
): Promise<boolean> {
  const posted: string[] = []
  let page = 1
  for (;;) {
    const result = await github.getReviewComments(repo.owner, repo.repo, prNumber, reviewId, {
      page,
      perPage: 100,
    })
    for (const raw of result.items) posted.push(postedCommentKey(raw))
    if (posted.length > inputs.length) return false
    if (!result.hasNext) break
    page += 1
  }
  if (posted.length !== inputs.length) return false
  const expected = inputs.map(inputCommentKey).sort()
  posted.sort()
  return expected.every((key, i) => key === posted[i])
}

/**
 * The audit endpoint recorded for each inline comment a review creates. A review
 * submit journals the REVIEW's id under `submitReview` (review id-space), but a
 * review's inline comments each have their OWN comment id in the comment
 * id-space — a distinct provenance that carries the comment authorship the
 * snapshot's `commentAuthors` map is keyed by. Journaling those ids under a
 * dedicated endpoint (one row per created inline comment) lets author assembly
 * map each real comment id to its human, and keeps that provenance separate from
 * the review row so the two id-spaces are never conflated. This value is a
 * comment-CREATING endpoint: it names ids revu itself minted, not ids it merely
 * touched (a reaction, a resolve).
 */
const SUBMIT_REVIEW_COMMENT_ENDPOINT = 'submitReviewComment'

/**
 * Read every inline comment id a just-created review carries and journal each
 * one under `submitReviewComment`, so the author of every comment the review
 * opened is recoverable from the audit journal (the review row alone journals
 * only the review id, which lives in a different id-space than the comment ids).
 *
 * Reads `GET /pulls/{n}/reviews/{id}/comments` — the same per-review comment
 * list the idempotency re-check paginates — because the create-review POST
 * response does not reliably enumerate the inline comments' assigned ids. Each
 * id is journaled once; a review with no inline comments journals nothing. Runs
 * only after a confirmed successful submit, so every id it records belongs to a
 * comment that actually reached GitHub.
 */
async function journalReviewComments(
  deps: WriteDeps,
  prNumber: number,
  reviewId: number,
): Promise<void> {
  let page = 1
  for (;;) {
    const result = await deps.github.getReviewComments(
      deps.repo.owner,
      deps.repo.repo,
      prNumber,
      reviewId,
      { page, perPage: 100 },
    )
    for (const raw of result.items) {
      const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      if (typeof c.id === 'number') {
        deps.writeDecorator.recordWrite(c.id, {
          endpoint: SUBMIT_REVIEW_COMMENT_ENDPOINT,
          pr: prNumber,
        })
      }
    }
    if (!result.hasNext) break
    page += 1
  }
}

/**
 * Journal a review's inline comment ids as provenance, fully isolated. This runs
 * only AFTER the review is confirmed on GitHub, so a failure here must never
 * propagate: turning a landed submit into a user-visible error would keep the
 * draft and risk a double-post on resubmit (a draft is deleted only on confirmed
 * success, and a confirmed success is never undone by later bookkeeping). A
 * read/write hiccup at worst degrades `commentAuthors` to the name-match fallback
 * for this one review until the next sync. A review that opened no inline
 * comments has nothing to journal, so the remote read is skipped entirely.
 */
async function journalReviewCommentsIsolated(
  deps: WriteDeps,
  prNumber: number,
  reviewId: number,
  inlineCommentCount: number,
): Promise<void> {
  if (inlineCommentCount === 0) return
  try {
    await journalReviewComments(deps, prNumber, reviewId)
  } catch (err) {
    // Sanitized: a review/PR id and the error's NAME only — never reader- or
    // token-bearing content.
    console.warn(
      `revud: could not journal inline comment ids for review ${reviewId} on ` +
        `PR ${prNumber} (${err instanceof Error ? err.name : 'unknown error'}); ` +
        `commentAuthors falls back to name-match for it until the next sync.`,
    )
  }
}

/**
 * Read every page of a PR's reviews and map them onto `ReviewSummary[]`. Used
 * by the idempotency re-check; the page cost is small (a PR has few reviews) and
 * it runs only on the submit path, right before the guard-passing POST.
 */
async function fetchReviews(
  github: GithubClient,
  repo: RepoRef,
  prNumber: number,
): Promise<ReviewSummary[]> {
  const reviews: ReviewSummary[] = []
  let page = 1
  for (;;) {
    const result = await github.getPullReviews(repo.owner, repo.repo, prNumber, {
      page,
      perPage: 100,
    })
    for (const raw of result.items) reviews.push(mapReview(raw))
    if (!result.hasNext) break
    page += 1
  }
  return reviews
}

/**
 * Submit a review. Guard first, then post; the draft is deleted ONLY on a
 * confirmed success.
 *
 *   1. HEAD GUARD — read `GET /pulls/{n}` and compare head to
 *      `input.expectedHeadSha`. On a mismatch, return `{ status: 'head_moved' }`
 *      as a VALUE (never thrown) WITHOUT posting anything, so the UI reconciles.
 *      The draft is untouched.
 *   2. APPROVE/REQUEST_CHANGES gating — only when the viewer can approve
 *      (`pull.user.login !== viewer.login`). A self-authored PR can only be
 *      COMMENTED on; asking to APPROVE it returns `forbidden` (a value), draft
 *      kept.
 *   3. IDEMPOTENCY RE-CHECK — before posting, look for an already-created
 *      matching review (a retry after a lost response). If found, short-circuit
 *      to it (and still delete the draft, since the review DID land).
 *   4. POST — one `POST /pulls/{n}/reviews` mapping every comment 1:1. On a 422
 *      (a comment failed validation despite the guard — a force-push in the
 *      guard-to-post window), surface `conflict` and KEEP the draft. On success,
 *      record the write, delete the draft, and return the created review.
 */
export async function submitReview(
  deps: WriteDeps,
  input: SubmitReviewInput,
): Promise<SubmitResult> {
  const { github, repo, store, session, writeDecorator } = deps
  const humanId = session.human.id
  const viewerLogin = session.viewerLogin ?? ''

  // 1. Head guard — read the live head. A mismatch is a 200-VALUE, never a throw,
  //    and posts nothing. The draft is not touched.
  const detailRaw = await github.getPullDetail(repo.owner, repo.repo, input.prNumber)
  const { headSha: currentHeadSha, authorLogin } = readGuardFields(detailRaw)
  if (currentHeadSha !== input.expectedHeadSha) {
    const snap = store.getSnapshot(input.prNumber)
    const priorCommits = snap?.immutable.commits.length ?? 0
    const currentCommits = readCommitCount(detailRaw)
    return {
      status: 'head_moved',
      currentHeadSha,
      // Best-effort new-commit count; never negative. The reconcile flow refines
      // it against the freshly-synced commit list.
      newCommits: Math.max(0, currentCommits - priorCommits),
    }
  }

  // 2. Approve gating — direct mode approves only PRs the viewer did not author.
  //    A self-authored sandbox PR can only be COMMENTED on. The draft is kept.
  if (input.event !== 'COMMENT') {
    const canApprove = viewerLogin.length > 0 && authorLogin !== viewerLogin
    if (!canApprove) {
      return {
        status: 'forbidden',
        reason:
          'GitHub refuses self-review: you opened this pull request, so it can only ' +
          'be commented on. Submit a COMMENT review instead.',
      }
    }
  }

  const state = EVENT_STATE[input.event]
  const decoratedReviewBody = writeDecorator.decorateBody(input.body)
  // The decorated 1:1 comment inputs, built once: the idempotency re-check
  // compares against exactly what the POST below would send.
  const comments: ReviewCommentInput[] = input.comments.map((c) =>
    toCommentInput({
      path: c.path,
      side: c.side,
      start_side: c.start_side,
      line: c.line,
      start_line: c.start_line,
      body: writeDecorator.decorateBody(c.body),
    }),
  )

  // 3. Idempotency re-check — a retry after a lost response must not double-post.
  //    A candidate must match on BOTH levels — the review key (viewer, commit,
  //    verdict, decorated body) AND its posted inline comments — because the
  //    review key alone repeats across distinct submits (an empty summary body
  //    at the same head is common) and a coincidental match would swallow the
  //    new comments. On a full match, short-circuit: the review DID land, so the
  //    draft is deleted, exactly as a fresh success.
  const existing = await fetchReviews(github, repo, input.prNumber)
  const candidates = existing.filter((r) =>
    reviewMatches(r, viewerLogin, currentHeadSha, state, decoratedReviewBody),
  )
  for (const candidate of candidates) {
    if (await reviewCommentsMatch(github, repo, input.prNumber, candidate.id, comments)) {
      // The review DID land (on the lost first attempt), so it is recorded like
      // a fresh success — the audit journal must cover every write that reached
      // GitHub, including one whose response was lost.
      writeDecorator.recordWrite(candidate.id, {
        endpoint: 'submitReview',
        pr: input.prNumber,
      })
      // Journal each inline comment id too (isolated: the review already landed
      // on the lost first attempt, so a journaling failure must never fail this
      // retry or block the draft deletion below).
      await journalReviewCommentsIsolated(deps, input.prNumber, candidate.id, comments.length)
      store.deleteDraft(humanId, input.prNumber)
      return { status: 'ok', review: candidate }
    }
  }

  // 4. Post — one call regardless of comment count. Each comment maps 1:1, with a
  //    decorated body (passthrough in direct mode).
  const body: SubmitReviewBody = {
    commit_id: currentHeadSha,
    event: input.event,
    body: decoratedReviewBody,
    comments,
  }

  let review: ReviewSummary
  try {
    const raw = await github.submitReview(repo.owner, repo.repo, input.prNumber, body)
    review = mapReview(raw)
  } catch (err) {
    if (err instanceof GithubRequestError && err.status === 422) {
      // A comment failed server-side validation despite the guard — a force-push
      // landed in the guard-to-post window. Surface `conflict` and KEEP the
      // draft: the human reconciles and resubmits. NEVER discard the draft here.
      throw new ApiError(
        'conflict',
        'A comment could not be placed on the current diff — the pull request ' +
          'changed while the review was being submitted. Your draft is kept; ' +
          're-sync and reconcile, then submit again.',
      )
    }
    throw err
  }

  // Broker misconfiguration tripwire. A broker session self-identifies as the
  // CONFIGURED bot login, but GitHub attributes App writes to the App's ACTUAL
  // `<slug>[bot]` login. If the two disagree (typo, wrong slug, missing
  // `[bot]`), the idempotency re-check above can never match on a retry — a
  // lost response then double-posts — and the approve gate compares against
  // the wrong login, all silently. The first successful write carries the real
  // author, so the mismatch is surfaced loudly here. Broker-only (`brokerLogin`
  // is '' in direct mode, where the viewer authors their own writes) and
  // side-effect-free beyond the warning; no token or body material is logged.
  if (session.brokerLogin.length > 0 && viewerLogin.length > 0 && review.user.login !== viewerLogin) {
    console.warn(
      `revud: REVU_BOT_LOGIN mismatch — configured "${viewerLogin}" but GitHub ` +
        `attributed this review to "${review.user.login}". Until it is fixed, a ` +
        `retried submit will double-post (the idempotency re-check never matches) ` +
        `and the self-approve guard compares the wrong login. Set REVU_BOT_LOGIN ` +
        `to "${review.user.login}".`,
    )
  }

  // Confirmed success: record the write, then delete the draft. Deleting only
  // here is the whole invariant — nothing above this line touches the draft.
  writeDecorator.recordWrite(review.id, { endpoint: 'submitReview', pr: input.prNumber })
  // Journal each inline comment id (isolated: the review has already landed, so a
  // journaling failure must never turn this confirmed submit into a user-visible
  // failure or block the draft deletion below).
  await journalReviewCommentsIsolated(deps, input.prNumber, review.id, comments.length)
  store.deleteDraft(humanId, input.prNumber)
  return { status: 'ok', review }
}

/**
 * Reply to a review thread. The contract addresses a THREAD, but REST wants a
 * COMMENT id, so the reply is posted to the thread's FIRST comment (GitHub
 * attaches it to the thread root regardless). The thread's first comment is read
 * from the cached snapshot (the snapshot is the source of truth for a thread's
 * shape); a thread absent from the snapshot, or with no comments, is a typed
 * `not_found`. The new comment is normalized and returned; the write is recorded.
 *
 * There is deliberately NO idempotency re-check on replies. If recording the
 * write fails AFTER the reply already posted, the request surfaces
 * `persist_failed` and a client retry posts the reply again — an accepted
 * duplicate-on-retry window. A visible duplicate comment is cheap and
 * recoverable; the alternative (swallowing the journal failure) would leave a
 * write on GitHub with no audit row — a silently unattributed write, the one
 * outcome the journaling mode must never produce.
 */
export async function replyToThread(
  deps: WriteDeps,
  prNumber: number,
  threadId: string,
  body: string,
): Promise<ReviewComment> {
  const { github, repo, store, writeDecorator } = deps
  const snap = store.getSnapshot(prNumber)
  const thread = snap?.mutable.threads.find((t) => t.id === threadId)
  if (thread === undefined || thread.comments.length === 0) {
    throw new ApiError(
      'not_found',
      `Thread ${threadId} was not found on pull #${prNumber} — re-sync this pull ` +
        'request; it may have been resolved or deleted upstream.',
    )
  }
  const firstCommentId = thread.comments[0].id
  const decorated = writeDecorator.decorateBody(body)
  const raw = await github.replyToReviewComment(
    repo.owner,
    repo.repo,
    prNumber,
    firstCommentId,
    decorated,
  )
  const comment = mapReviewComment(raw)
  writeDecorator.recordWrite(comment.id, { endpoint: 'replyToThread', pr: prNumber })
  return comment
}

/**
 * Resolve or unresolve a review thread via the GraphQL mutation, addressed by the
 * `PRRT_` node id the snapshot carries. The mutated thread is returned in the
 * same node shape the read uses and normalized by the one thread normalizer, so
 * a resolve and a sync produce structurally identical threads. `resolvedBy` reads
 * as the authenticated user (the UI already renders that).
 *
 * The successful mutation is recorded through the `WriteDecorator` (a no-op in
 * direct mode). A thread's only REST-numeric identity is its root comment's id —
 * the same id a reply posts to — so that is what is recorded. When the mutated
 * thread comes back with NO comments there is no real GitHub id to record, and
 * the audit append is SKIPPED rather than fabricating a sentinel: the journal's
 * github id column is NOT NULL and 0 is never a real id, so a fabricated row
 * would be indistinguishable from corruption to any later integrity check.
 * Resolve rows are provenance-only — reconciliation of what actually exists on
 * GitHub works from comments and reviews — so a skipped row loses no ground
 * truth.
 */
export async function resolveThread(
  deps: WriteDeps,
  prNumber: number,
  threadId: string,
  resolved: boolean,
): Promise<ReviewThread> {
  const node = await deps.github.setThreadResolution(threadId, resolved)
  const thread = normalizeReviewThread(node)
  const rootCommentId = thread.comments[0]?.id
  if (rootCommentId !== undefined) {
    deps.writeDecorator.recordWrite(rootCommentId, {
      endpoint: 'resolveThread',
      pr: prNumber,
    })
  }
  return thread
}

/**
 * Add a reaction to a comment and return the comment's current rollup.
 *
 * Reactions are per-GitHub-user and there is one authenticated user, so this is
 * SHARED-AND-HONEST: a reaction is real data, but there is no per-human
 * simulation. GitHub's reaction POST is idempotent (a repeated identical reaction
 * changes nothing) and returns only the single reaction, not the rollup, so the
 * rollup is read back from the comment after the POST — the honest count the
 * whole team sees.
 *
 * The contract addresses the target only by comment id, but GitHub keeps PR
 * review comments and issue (conversation-tab) comments in separate id
 * namespaces with separate endpoints. The id is classified against the PR's
 * cached snapshot — this is what the owning `prNumber` is for: an id found among
 * the snapshot's conversation comments takes the issue endpoints; anything else
 * (thread comments, or a fresh reply the snapshot has not re-synced yet) takes
 * the pull-review-comment endpoints.
 *
 * A successful reaction is recorded through the `WriteDecorator` (a no-op in
 * direct mode), keyed by the id of the comment reacted TO — the stable numeric
 * identity of what was touched on GitHub.
 */
export async function addReaction(
  deps: WriteDeps,
  prNumber: number,
  commentId: number,
  reaction: ReactionKey,
): Promise<ReactionRollup> {
  const { github, repo, store, writeDecorator } = deps
  const snap = store.getSnapshot(prNumber)
  const isIssueComment =
    snap?.mutable.issueComments.some((c) => c.id === commentId) === true
  if (isIssueComment) {
    await github.addIssueCommentReaction(repo.owner, repo.repo, commentId, reaction)
  } else {
    await github.addReaction(repo.owner, repo.repo, commentId, reaction)
  }
  // Recorded the moment the reaction POST is confirmed — BEFORE the rollup
  // read-back — so a failed read-back cannot lose the journal entry for a
  // reaction that already landed on GitHub.
  writeDecorator.recordWrite(commentId, { endpoint: 'addReaction', pr: prNumber })
  const raw = isIssueComment
    ? await github.getIssueComment(repo.owner, repo.repo, commentId)
    : await github.getReviewComment(repo.owner, repo.repo, commentId)
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return mapReactions(c.reactions)
}

/** Read the head SHA and author login the submit guard needs from raw pull detail. */
function readGuardFields(raw: unknown): { headSha: string; authorLogin: string } {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const head = (p.head && typeof p.head === 'object' ? p.head : {}) as Record<string, unknown>
  const user = (p.user && typeof p.user === 'object' ? p.user : {}) as Record<string, unknown>
  return {
    headSha: typeof head.sha === 'string' ? head.sha : '',
    authorLogin: typeof user.login === 'string' ? user.login : '',
  }
}

/** Read the PR's current commit count from raw pull detail (for the head-moved delta). */
function readCommitCount(raw: unknown): number {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return typeof p.commits === 'number' ? p.commits : 0
}
