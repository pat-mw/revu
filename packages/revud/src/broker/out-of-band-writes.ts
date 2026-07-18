import type { GithubClient, Page, PageParams } from '../direct/github-client'
import type { RepoRef } from '../direct/repo'
import type { AuditEntry } from '../direct/store'

/**
 * Host-side detection of OUT-OF-BAND writes: artifacts that exist on GitHub
 * under the shared bot identity but were NOT produced through revu's mediated
 * write path.
 *
 * Threat model: every workspace holds the same ambient installation token with
 * `pull_requests: write`, so a workspace user can bypass revu entirely and post
 * as the bot directly (a raw `curl` POST, `gh pr comment`). Such a write
 * carries no smuggled author stamp and no audit-journal row — an unattributed
 * write under the shared identity. This module closes that gap: the audit
 * journal is provenance for MEDIATED writes, and the detector here flags every
 * bot-authored artifact the journal cannot account for.
 *
 * Placement: this file lives in `broker/`, but that directory is NOT host-only
 * (`broker/token-source.ts` runs in-workspace). What keeps THIS module
 * host-side is a convention enforced by imports, not a structural guarantee:
 * nothing on the in-workspace request path imports it, and nothing may start
 * to. A workspace running its own reconcile could equally suppress its
 * findings, so only the journal's owner — the host process — can compare
 * journal against GitHub honestly. The detector itself is pure (no I/O); the
 * reconcile below feeds it from an injected GitHub client and journal reader
 * so it is testable with fakes and callable by a host-side collector.
 *
 * KNOWN RESIDUAL CHANNELS — scope is a decision, not an accident. The ambient
 * token's grant (`contents: write`, `pull_requests: write`, `metadata: read`,
 * `checks: read`) can write as the bot through channels this reconcile does
 * not enumerate, so they produce no finding:
 *
 *   1. Reactions (`POST …/reactions` as the bot) — no reconciled artifact
 *      list covers reaction objects themselves.
 *   2. GraphQL thread resolve/unresolve — dismissing review feedback as the
 *      bot mutates thread state without creating any comment or review to
 *      reconcile.
 *   3. Review dismissal (`PUT /pulls/{n}/reviews/{id}/dismissals`) — mutates
 *      an existing review's state, not the artifact lists.
 *   4. PATCH edits of an existing bot artifact (`PATCH /pulls/comments/{id}`,
 *      `PATCH /issues/comments/{id}`, `PUT /pulls/{n}/reviews/{id}`): the id
 *      stays journaled, so an out-of-band REWRITE of a mediated,
 *      author-stamped artifact is absolved by id — the cleanest bypass.
 *      Partially covered: the reconcile reports any bot comment whose
 *      `updated_at` sits meaningfully after its `created_at` (and after its
 *      journal row's write instant, when one is known) as the informational
 *      `editedAfterMediation` signal. It stays informational because GitHub
 *      can bump `updated_at` for benign server-side reasons, and review
 *      BODIES expose no `updated_at` at all (only `submitted_at`), so review
 *      rewrites remain uncovered.
 *   5. PR title/body PATCH (`PATCH /pulls/{n}`) — the PR object is not
 *      reconciled.
 *   6. `contents: write` — pushing commits or editing files as the bot is an
 *      entirely different artifact universe (git, not the PR discussion).
 *
 * POINT-IN-TIME LIMITS — the reconcile compares one GitHub snapshot against
 * the journal:
 *
 *   - An artifact posted AND deleted between two reconcile runs is never
 *     detected. This is inherent to polling; only an event feed could see it.
 *   - GitHub is fetched BEFORE the journal is read, which is the
 *     false-positive-safe order: a mediated write landing between the two
 *     steps has a journal row but no fetched artifact, so it surfaces as
 *     informational `unmatchedJournal`, never as a violation. The only
 *     remaining race is the sub-second in-flight window where a mediated
 *     write's artifact is already visible to the fetch but its journal row
 *     has not yet committed.
 */

// ————————————————————————————————————————————————————————————————
// The pure detector
// ————————————————————————————————————————————————————————————————

/**
 * The author of a GitHub artifact, reduced to the two fields authorship
 * classification needs. `type` is the REST payload's account type verbatim; a
 * GitHub App posts as `type: 'Bot'` with a `<slug>[bot]` login. Bot-authorship
 * is decided on the TYPE and the exact configured login together — never on a
 * login pattern alone, which any user could mimic in a display name.
 */
export interface ArtifactAuthor {
  login: string
  type: string
}

/**
 * One submitted review on the PR, in the review id-space. Review payloads
 * expose `submitted_at` but no `updated_at`, so reviews carry no timestamps
 * here and cannot feed the edit signal.
 */
export interface ReviewArtifact {
  id: number
  author: ArtifactAuthor | null
}

/**
 * One review (inline) comment on the PR. `reviewId` is REST's
 * `pull_request_review_id` — the review the comment was created under. It is
 * what lets a comment created inline by a mediated review submit be traced to
 * that review's journal row (the submit journals ONE id: the review's), and,
 * in reverse, what lets a mediated reply vouch for the implicit review GitHub
 * mints around it. `createdAt`/`updatedAt` are REST's `created_at` and
 * `updated_at` when present; GitHub sets them identical at creation and bumps
 * `updated_at` on edit, which powers the informational edit signal.
 */
export interface ReviewCommentArtifact {
  id: number
  author: ArtifactAuthor | null
  reviewId: number | null
  createdAt?: string | null
  updatedAt?: string | null
}

/** One issue (conversation-tab) comment on the PR, with the same optional timestamps. */
export interface IssueCommentArtifact {
  id: number
  author: ArtifactAuthor | null
  createdAt?: string | null
  updatedAt?: string | null
}

/** Everything currently on GitHub for one PR that the detector reconciles. */
export interface PullArtifacts {
  reviews: ReviewArtifact[]
  reviewComments: ReviewCommentArtifact[]
  issueComments: IssueCommentArtifact[]
}

/**
 * Journaled GitHub ids split along the two axes the reconcile must not
 * conflate:
 *
 *   - ID-SPACE: review ids and comment ids are disjoint GitHub id-spaces
 *     whose numeric values can collide, so each artifact kind is checked only
 *     against ids known to live in its own space.
 *   - PROVENANCE: an endpoint either CREATED the artifact it journals or
 *     merely TOUCHED an artifact someone else created, and only creation is
 *     evidence of mediation. `submitReview` creates a review (review space);
 *     `replyToThread` creates a reply (comment space). But `resolveThread`
 *     journals the resolved thread's ROOT comment and `addReaction` the
 *     comment reacted to — ids of comments revu did NOT create. Pooling those
 *     touch rows with creation rows would let a contractor launder an
 *     out-of-band bot comment by reacting to it (or resolving its thread)
 *     through revu: the touch row is legitimate, the comment is not.
 *
 * `reviewIds` and `createdCommentIds` are therefore the ONLY sets that can
 * absolve an artifact. `touchedIds` feeds the informational
 * `unmatchedJournal` check exclusively. The journal-write instants (kept per
 * creating row when the source rows carry them) power the equally
 * informational `editedAfterMediation` signal.
 */
export interface JournaledIds {
  /** Review ids journaled by `submitReview` — review-space creations. */
  reviewIds: ReadonlySet<number>
  /**
   * Comment ids journaled by `replyToThread` — the only endpoint whose own id
   * absolves a comment DIRECTLY. (`submitReviewComment` also creates comments,
   * but each is absolved via its parent review's id, so those ids are
   * deliberately touch-classified instead — see `splitJournaledIds`.)
   */
  createdCommentIds: ReadonlySet<number>
  /**
   * Comment ids journaled by touch-only endpoints (`resolveThread`,
   * `addReaction`, and anything unknown). Never absolves; informational only.
   */
  touchedIds: ReadonlySet<number>
  /** Journal-write instant per `submitReview` id, when the row carried one. */
  reviewJournaledAt?: ReadonlyMap<number, string>
  /** Journal-write instant per `replyToThread` id, when the row carried one. */
  createdCommentJournaledAt?: ReadonlyMap<number, string>
}

/** The kinds of artifact an out-of-band write can surface as. */
export type OutOfBandKind = 'review' | 'review_comment' | 'issue_comment'

/** One bot-authored artifact the journal cannot account for — a bypass. */
export interface OutOfBandWrite {
  kind: OutOfBandKind
  id: number
  authorLogin: string
}

/**
 * A journaled id with no matching artifact on GitHub: a mediated write that
 * was later deleted (or a resolved/reacted-to comment that has since been
 * removed). The write itself went THROUGH revu, so this is never a violation —
 * it is reported separately, as information only.
 */
export interface UnmatchedJournalEntry {
  idSpace: 'review' | 'comment'
  githubId: number
}

/**
 * A bot comment whose `updated_at` shows a post-creation mutation: the
 * informational trace of residual channel (4) in the module header — an
 * out-of-band PATCH rewrite of an artifact whose id the journal legitimately
 * holds. Informational, not a violation: GitHub can bump `updated_at` for
 * benign server-side reasons, so this is a signal to inspect, not proof.
 * Reviews cannot appear here (their payloads expose no `updated_at`).
 */
export interface EditedAfterMediation {
  kind: 'review_comment' | 'issue_comment'
  id: number
  authorLogin: string
  createdAt: string
  updatedAt: string
}

/** What one detection run concludes. */
export interface OutOfBandReport {
  /** Bot-authored artifacts the journal's creating rows cannot account for: the violations. */
  outOfBand: OutOfBandWrite[]
  /** Journaled ids absent from GitHub: mediated-then-deleted, informational only. */
  unmatchedJournal: UnmatchedJournalEntry[]
  /** Bot comments edited after creation: possible out-of-band rewrites, informational only. */
  editedAfterMediation: EditedAfterMediation[]
}

/**
 * The journal row slice the split consumes: the id, the endpoint (the
 * provenance and id-space discriminator), and — when the caller has it — the
 * row's write instant, which feeds the informational edit signal.
 */
export type AuditJournalRow = Pick<AuditEntry, 'githubId' | 'endpoint'> &
  Partial<Pick<AuditEntry, 'createdAt'>>

/**
 * Split raw journal rows by endpoint into id-space AND provenance.
 * `submitReview` is the only review-space (and review-creating) endpoint;
 * `replyToThread` is the only comment endpoint whose id absolves a comment
 * DIRECTLY. `submitReviewComment` (a review's inline-comment creations) is
 * deliberately touch-classified, NOT creation-classified — each inline comment
 * is already absolved via its parent review's id, so its own id is kept out of
 * the absolving set to hold detection to a single absolution path. Every other
 * endpoint — `resolveThread`, `addReaction`, and any endpoint unknown to this
 * rule — journals the id of a comment revu merely touched, so it lands in
 * `touchedIds`, which never absolves anything: an unknown endpoint can only
 * widen the informational unmatched report. Journal-write instants are kept
 * per creating row, first row winning (the creation instant), for the edit
 * signal.
 */
export function splitJournaledIds(entries: readonly AuditJournalRow[]): JournaledIds {
  const reviewIds = new Set<number>()
  const createdCommentIds = new Set<number>()
  const touchedIds = new Set<number>()
  const reviewJournaledAt = new Map<number, string>()
  const createdCommentJournaledAt = new Map<number, string>()
  for (const entry of entries) {
    if (entry.endpoint === 'submitReview') {
      reviewIds.add(entry.githubId)
      if (entry.createdAt !== undefined && !reviewJournaledAt.has(entry.githubId)) {
        reviewJournaledAt.set(entry.githubId, entry.createdAt)
      }
    } else if (entry.endpoint === 'replyToThread') {
      createdCommentIds.add(entry.githubId)
      if (entry.createdAt !== undefined && !createdCommentJournaledAt.has(entry.githubId)) {
        createdCommentJournaledAt.set(entry.githubId, entry.createdAt)
      }
    } else {
      // `resolveThread`, `addReaction`, `submitReviewComment`, and any unknown
      // endpoint. `submitReviewComment` (a review's inline-comment creations) is
      // deliberately here, NOT in `createdCommentIds`: each inline comment is
      // already absolved via its parent review's id, so keeping its own id out of
      // the absolving set holds detection to a single absolution path. Never move
      // it to `createdCommentIds` — that would widen the absolution surface for no
      // gain (and a laundering risk if the review-id linkage ever changed).
      touchedIds.add(entry.githubId)
    }
  }
  return { reviewIds, createdCommentIds, touchedIds, reviewJournaledAt, createdCommentJournaledAt }
}

/**
 * GitHub timestamps are second-resolution ISO-8601 UTC and identical at
 * creation, so a `created_at` → `updated_at` gap of at least a full second is
 * the smallest observable evidence of a post-creation mutation.
 */
const MEANINGFUL_EDIT_GAP_MS = 1000

/** Parse an ISO-8601 instant to epoch milliseconds, or `null` when unparseable. */
function parseInstant(iso: string): number | null {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/**
 * The pure detector: compare what is on GitHub against what the journal can
 * account for. No I/O — both sides are handed in.
 *
 * Per artifact kind:
 *
 *   - A bot-authored REVIEW is mediated if its id was journaled by
 *     `submitReview`, OR if a review comment journaled by `replyToThread`
 *     names it as parent (`pull_request_review_id`). The reverse linkage
 *     exists because GitHub wraps every standalone reply in an implicit
 *     COMMENTED review whose id revu never sees — without it, every mediated
 *     reply would raise a persistent false `review` finding. It cannot be
 *     laundered: a submitted review cannot have comments appended through the
 *     API, and a contractor cannot mint a comment carrying a journaled id, so
 *     a journaled reply pointing at a review means GitHub minted that review
 *     for the mediated reply itself.
 *   - A bot-authored REVIEW COMMENT is mediated if its own id was journaled
 *     by `replyToThread` (the comment id-space's only CREATING endpoint) OR
 *     its parent review's id was journaled by `submitReview` — a mediated
 *     submit creates its inline comments in the same POST but journals only
 *     the review id, so the comments are vouched for through
 *     `pull_request_review_id`. Touch-only rows (`resolveThread`,
 *     `addReaction`) never absolve: they hold ids of comments revu did not
 *     create, and treating them as proof of mediation would let a contractor
 *     absolve an out-of-band bot comment by touching it through revu.
 *   - A bot-authored ISSUE COMMENT is out-of-band UNCONDITIONALLY: revu's write
 *     surface never creates one (its writes are reviews, review comments,
 *     reactions, and thread resolutions), so no journal row can testify to one.
 *     The journal is deliberately not consulted — an `addReaction` row may hold
 *     an issue comment's id (revu reacted TO it), and a reaction to a comment
 *     must not absolve the comment itself.
 *   - A NON-bot artifact (an org member posting as themselves) is ignored
 *     entirely: attribution for real users is GitHub's own.
 *
 * `botLogin` is REQUIRED: bot-authorship means `type === 'Bot'` AND the exact
 * configured login (`<slug>[bot]`), so another App's traffic on the same PR
 * (dependabot[bot], github-actions[bot], …) is never attributed to this
 * journal. Without the login there is no sound way to narrow `Bot`-typed
 * authors to this deployment.
 *
 * Alongside the violations, every bot comment whose `updated_at` sits
 * meaningfully after its `created_at` — and after its journal row's write
 * instant, when one is known — is reported as the informational
 * `editedAfterMediation` signal (residual channel (4) in the module header).
 * The journal comparison uses the host's clock against GitHub's, so skew can
 * suppress a borderline signal; it can never create a violation.
 */
export function detectOutOfBandWrites(
  journaled: JournaledIds,
  artifacts: PullArtifacts,
  opts: { botLogin: string },
): OutOfBandReport {
  const isBot = (author: ArtifactAuthor | null): author is ArtifactAuthor =>
    author !== null && author.type === 'Bot' && author.login === opts.botLogin

  const outOfBand: OutOfBandWrite[] = []
  const editedAfterMediation: EditedAfterMediation[] = []

  const noteEditIfAny = (
    kind: EditedAfterMediation['kind'],
    artifact: { id: number; createdAt?: string | null; updatedAt?: string | null },
    authorLogin: string,
    journaledAtIso: string | undefined,
  ): void => {
    if (typeof artifact.createdAt !== 'string' || typeof artifact.updatedAt !== 'string') return
    const created = parseInstant(artifact.createdAt)
    const updated = parseInstant(artifact.updatedAt)
    if (created === null || updated === null) return
    if (updated - created < MEANINGFUL_EDIT_GAP_MS) return
    if (journaledAtIso !== undefined) {
      const journaledAt = parseInstant(journaledAtIso)
      if (journaledAt !== null && updated <= journaledAt) return
    }
    editedAfterMediation.push({
      kind,
      id: artifact.id,
      authorLogin,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    })
  }

  // The reverse linkage for implicit reviews: every review id named as parent
  // by a comment that `replyToThread` created. Built from review comments only
  // — `replyToThread` creates nothing in the issue-comment id-space.
  const reviewIdsVouchedByCreatedComments = new Set<number>()
  for (const comment of artifacts.reviewComments) {
    if (comment.reviewId !== null && journaled.createdCommentIds.has(comment.id)) {
      reviewIdsVouchedByCreatedComments.add(comment.reviewId)
    }
  }

  for (const review of artifacts.reviews) {
    if (!isBot(review.author)) continue
    if (journaled.reviewIds.has(review.id)) continue
    if (reviewIdsVouchedByCreatedComments.has(review.id)) continue
    outOfBand.push({ kind: 'review', id: review.id, authorLogin: review.author.login })
  }

  for (const comment of artifacts.reviewComments) {
    if (!isBot(comment.author)) continue
    noteEditIfAny(
      'review_comment',
      comment,
      comment.author.login,
      journaled.createdCommentJournaledAt?.get(comment.id) ??
        (comment.reviewId !== null
          ? journaled.reviewJournaledAt?.get(comment.reviewId)
          : undefined),
    )
    if (journaled.createdCommentIds.has(comment.id)) continue
    if (comment.reviewId !== null && journaled.reviewIds.has(comment.reviewId)) continue
    outOfBand.push({
      kind: 'review_comment',
      id: comment.id,
      authorLogin: comment.author.login,
    })
  }

  for (const comment of artifacts.issueComments) {
    if (!isBot(comment.author)) continue
    // No journal row can create an issue comment, so no journal instant applies.
    noteEditIfAny('issue_comment', comment, comment.author.login, undefined)
    outOfBand.push({
      kind: 'issue_comment',
      id: comment.id,
      authorLogin: comment.author.login,
    })
  }

  // The informational inverse: journaled ids that no longer match anything on
  // GitHub. Presence is checked per id-space against ALL artifacts regardless
  // of author, because a comment-space journal row may reference a comment revu
  // only touched (a resolved thread's member-authored root, a reacted-to
  // comment) — such a row is accounted for by the comment's existence, not its
  // authorship. The comment-space presence set spans review AND issue comments
  // (two GitHub id-spaces) because `addReaction` journals whichever kind was
  // reacted to; the union is used ONLY for this informational check, never to
  // absolve an artifact, so a cross-space numeric collision here cannot mask a
  // violation — at worst it hides a "since deleted" note. Created and touched
  // comment ids are pooled here for the same reason: presence, not provenance,
  // is what the unmatched check measures.
  const presentReviewIds = new Set(artifacts.reviews.map((r) => r.id))
  const presentCommentIds = new Set([
    ...artifacts.reviewComments.map((c) => c.id),
    ...artifacts.issueComments.map((c) => c.id),
  ])
  const journaledCommentIds = new Set([...journaled.createdCommentIds, ...journaled.touchedIds])
  const unmatchedJournal: UnmatchedJournalEntry[] = []
  for (const id of journaled.reviewIds) {
    if (!presentReviewIds.has(id)) unmatchedJournal.push({ idSpace: 'review', githubId: id })
  }
  for (const id of journaledCommentIds) {
    if (!presentCommentIds.has(id)) unmatchedJournal.push({ idSpace: 'comment', githubId: id })
  }

  return { outOfBand, unmatchedJournal, editedAfterMediation }
}

// ————————————————————————————————————————————————————————————————
// The host-side reconcile (injected client + journal → detector)
// ————————————————————————————————————————————————————————————————

/**
 * The three list reads the reconcile needs, as a narrow slice of the full
 * client so a test fake implements exactly these. `getPullReviewComments` is
 * the flat every-comment-on-the-PR list — the per-review comment read cannot
 * find a comment whose parent review is unknown.
 */
export type OutOfBandReadClient = Pick<
  GithubClient,
  'getPullReviews' | 'getPullReviewComments' | 'getIssueComments'
>

/**
 * The journal slice the reconcile reads: the audit rows for one PR, of which
 * the GitHub id, the endpoint (the provenance and id-space discriminator),
 * and — when available — the row's write instant matter here. A real
 * `DirectStore` satisfies this structurally; a fake is a filter over an array.
 */
export interface AuditJournalReader {
  listAudit(filter?: { pr?: number }): readonly AuditJournalRow[]
}

export interface OutOfBandReconcileDeps {
  github: OutOfBandReadClient
  journal: AuditJournalReader
  repo: RepoRef
  /**
   * The deployment's bot login (`<slug>[bot]`). Required: it is the only
   * sound way to narrow `Bot`-typed authors to this one App, and without it
   * every other bot's traffic (dependabot[bot], github-actions[bot], …) would
   * be held against this journal.
   */
  botLogin: string
}

/** One PR's detection outcome, tagged with the PR it belongs to. */
export interface PullOutOfBandReport extends OutOfBandReport {
  pr: number
}

/** GitHub's per-page maximum; fewer pages means fewer requests per reconcile. */
const PER_PAGE = 100

/** Fetch every page of a paginated list, honoring the `Link: rel="next"`-derived flag. */
async function paginate(
  fetchPage: (params: PageParams) => Promise<Page<unknown>>,
): Promise<unknown[]> {
  const items: unknown[] = []
  let page = 1
  for (;;) {
    const result = await fetchPage({ page, perPage: PER_PAGE })
    items.push(...result.items)
    if (!result.hasNext) break
    page += 1
  }
  return items
}

/**
 * Map a raw REST `user` object onto the two fields authorship needs, or `null`
 * when absent/malformed (a deleted account renders as `user: null`). A null
 * author can never classify as the bot, so it is ignored by detection.
 */
function mapAuthor(user: unknown): ArtifactAuthor | null {
  if (user === null || typeof user !== 'object') return null
  const u = user as { login?: unknown; type?: unknown }
  if (typeof u.login !== 'string' || typeof u.type !== 'string') return null
  return { login: u.login, type: u.type }
}

/** A raw REST timestamp field when it is a string, else `null` (absent or malformed). */
function mapInstant(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Map raw list items, dropping any without a numeric `id`. GitHub assigns
 * every artifact one, so a missing id marks a non-artifact payload; without an
 * id there is nothing to reconcile a finding against.
 */
function mapArtifacts<T>(rawItems: unknown[], mapOne: (raw: { id: number; user?: unknown } & Record<string, unknown>) => T): T[] {
  const out: T[] = []
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== 'object') continue
    const r = raw as { id?: unknown } & Record<string, unknown>
    if (typeof r.id !== 'number') continue
    out.push(mapOne(r as { id: number; user?: unknown } & Record<string, unknown>))
  }
  return out
}

/**
 * Reconcile ONE pull request: list its submitted reviews, ALL its review
 * comments (the flat list), and its issue comments from GitHub; read its
 * journal rows; and run the pure detector over the two. The three lists are
 * fully paginated — truncating any of them could hide a bypass on a later
 * page. The GitHub fetch precedes the journal read on purpose; see the
 * point-in-time notes in the module header.
 */
export async function reconcilePullOutOfBand(
  deps: OutOfBandReconcileDeps,
  prNumber: number,
): Promise<PullOutOfBandReport> {
  const { github, journal, repo } = deps

  const rawReviews = await paginate((p) =>
    github.getPullReviews(repo.owner, repo.repo, prNumber, p),
  )
  const rawReviewComments = await paginate((p) =>
    github.getPullReviewComments(repo.owner, repo.repo, prNumber, p),
  )
  const rawIssueComments = await paginate((p) =>
    github.getIssueComments(repo.owner, repo.repo, prNumber, p),
  )

  const artifacts: PullArtifacts = {
    reviews: mapArtifacts(rawReviews, (r) => ({ id: r.id, author: mapAuthor(r.user) })),
    reviewComments: mapArtifacts(rawReviewComments, (r) => ({
      id: r.id,
      author: mapAuthor(r.user),
      reviewId:
        typeof r.pull_request_review_id === 'number' ? r.pull_request_review_id : null,
      createdAt: mapInstant(r.created_at),
      updatedAt: mapInstant(r.updated_at),
    })),
    issueComments: mapArtifacts(rawIssueComments, (r) => ({
      id: r.id,
      author: mapAuthor(r.user),
      createdAt: mapInstant(r.created_at),
      updatedAt: mapInstant(r.updated_at),
    })),
  }

  // Only THIS PR's journal rows participate: a row journaled against another
  // PR proves nothing about writes landing here.
  const journaled = splitJournaledIds(journal.listAudit({ pr: prNumber }))

  const report = detectOutOfBandWrites(journaled, artifacts, { botLogin: deps.botLogin })
  return { pr: prNumber, ...report }
}

/** Reconcile a set of pull requests sequentially, one report per PR. */
export async function reconcileOutOfBand(
  deps: OutOfBandReconcileDeps,
  prNumbers: readonly number[],
): Promise<PullOutOfBandReport[]> {
  const reports: PullOutOfBandReport[] = []
  for (const pr of prNumbers) {
    reports.push(await reconcilePullOutOfBand(deps, pr))
  }
  return reports
}
