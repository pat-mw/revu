import type { GhUser, ReactionRollup, ReviewComment, ReviewThread } from '@revu/shared'
import type {
  GhGraphqlPageInfo,
  GhReviewCommentNode,
  GhReviewThreadNode,
  GithubClient,
} from './github-client'
import type { RepoRef } from './repo'

/**
 * Normalize a PR's review threads from GraphQL vocabulary onto the contract's
 * REST-shaped `ReviewThread[]`. Review threads (thread grouping, `isResolved`,
 * `isOutdated`) exist only in GraphQL, but the contract keeps ONE comment
 * vocabulary — the REST `ReviewComment` — so the nested comment nodes are
 * narrowed onto that shape here. The function is pure: it takes already-fetched
 * GraphQL nodes and returns contract objects, so the mapping is unit-testable
 * with injected fixtures and never touches the network.
 *
 * The three mappings the schema forces (each confirmed against the live schema):
 *   - `fullDatabaseId` → the REST-numeric comment id. It is a GraphQL `BigInt`,
 *     serialized as a JSON STRING, so it is coerced to a number here.
 *   - `diffSide` → `side`. `diffSide` lives on the THREAD, not the comment (the
 *     comment type has no `diffSide` field), so the thread's value is pushed
 *     onto every comment it holds.
 *   - `diffHunk` → `diff_hunk`, carried verbatim.
 *
 * `isResolved` / `isOutdated` / `resolvedBy` are carried straight from the thread
 * node. An outdated thread reports `line: null` from GitHub; that null is kept
 * honestly rather than invented.
 */

/** A zeroed reaction rollup — the REST shape a `ReviewComment` requires. */
function zeroReactions(): ReactionRollup {
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
 * Coerce a GraphQL `BigInt` id (arriving as a JSON string) to the REST-numeric
 * id the contract carries. A finite number passes through; a non-empty numeric
 * string parses (an empty/blank string does NOT — `Number('')` is 0, which would
 * fabricate a valid-looking id). Anything absent or unparseable returns null so
 * each call site decides: an OPTIONAL id degrades to absent, while the comment's
 * PRIMARY id — the key reply writes and the reactions route address — must fail
 * loudly rather than mint colliding 0s into a persisted snapshot.
 */
function toNumericId(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Coerce a nullable `LEFT`/`RIGHT` GraphQL side to the contract's `side` (defaults to RIGHT). */
function toSide(value: string | null | undefined): 'LEFT' | 'RIGHT' {
  return value === 'LEFT' ? 'LEFT' : 'RIGHT'
}

/** Coerce a nullable side to the contract's nullable `start_side`. */
function toStartSide(value: string | null | undefined): 'LEFT' | 'RIGHT' | null {
  if (value === 'LEFT' || value === 'RIGHT') return value
  return null
}

/** Coerce the GraphQL `subjectType` (`LINE`/`FILE`) to the REST comment `subject_type`. */
function toCommentSubjectType(value: string | null | undefined): 'line' | 'file' {
  return value === 'FILE' ? 'file' : 'line'
}

/** Coerce the GraphQL thread `subjectType` (`LINE`/`FILE`) to the contract `subjectType`. */
function toThreadSubjectType(value: string | null | undefined): 'LINE' | 'FILE' {
  return value === 'FILE' ? 'FILE' : 'LINE'
}

/** A GraphQL `Actor` (only `login` is available) narrowed to the contract's `GhUser`. */
function toUser(author: { login: string } | null | undefined): GhUser {
  return {
    login: typeof author?.login === 'string' ? author.login : '',
    id: 0,
    node_id: '',
    avatar_url: '',
    html_url: '',
    type: 'User',
  }
}

/**
 * Normalize one GraphQL comment node onto the REST `ReviewComment`. `threadSide`
 * and `threadStartSide` come from the parent thread because the comment node
 * itself has no `diffSide`/`startDiffSide`: `side` is the END line's side
 * (thread `diffSide`), `start_side` the START line's (thread `startDiffSide` —
 * a multi-line comment may span from LEFT to RIGHT, so the two can differ).
 * `in_reply_to_id` is present only for a reply (the GraphQL `replyTo` node);
 * `pull_request_review_id` is the review the comment was submitted under, null
 * for a single "add a comment" outside a review.
 */
function normalizeComment(
  node: GhReviewCommentNode,
  threadSide: 'LEFT' | 'RIGHT',
  threadStartSide: 'LEFT' | 'RIGHT' | null,
): ReviewComment {
  const id = toNumericId(node.fullDatabaseId)
  if (id === null) {
    // The comment id keys reply writes, the reactions route, and dedup in the
    // client; fabricating a 0 here would let two comments collide and persist a
    // corrupt snapshot. Fail the sync loudly instead.
    throw new Error(
      `review comment carries no usable fullDatabaseId (got ${JSON.stringify(node.fullDatabaseId)})`,
    )
  }
  const replyToId = toNumericId(node.replyTo?.fullDatabaseId)
  const comment: ReviewComment = {
    id,
    node_id: '',
    pull_request_review_id: toNumericId(node.pullRequestReview?.fullDatabaseId),
    path: typeof node.path === 'string' ? node.path : '',
    diff_hunk: typeof node.diffHunk === 'string' ? node.diffHunk : '',
    commit_id: typeof node.commit?.oid === 'string' ? node.commit.oid : '',
    original_commit_id:
      typeof node.originalCommit?.oid === 'string' ? node.originalCommit.oid : '',
    line: typeof node.line === 'number' ? node.line : null,
    original_line: typeof node.originalLine === 'number' ? node.originalLine : null,
    start_line: typeof node.startLine === 'number' ? node.startLine : null,
    original_start_line:
      typeof node.originalStartLine === 'number' ? node.originalStartLine : null,
    side: threadSide,
    start_side:
      node.startLine === null || node.startLine === undefined
        ? null
        : (threadStartSide ?? threadSide),
    subject_type: toCommentSubjectType(node.subjectType),
    user: toUser(node.author),
    body: typeof node.body === 'string' ? node.body : '',
    created_at: typeof node.createdAt === 'string' ? node.createdAt : '',
    updated_at: typeof node.updatedAt === 'string' ? node.updatedAt : '',
    reactions: zeroReactions(),
    html_url: typeof node.url === 'string' ? node.url : '',
  }
  // `in_reply_to_id` is present only for a reply — carry it only then, so a root
  // comment stays honestly without the field (matching the REST fixtures).
  if (replyToId !== null) {
    comment.in_reply_to_id = replyToId
  }
  return comment
}

/**
 * Normalize one GraphQL thread node onto the contract `ReviewThread`. The thread
 * `id` is the `PRRT_` GraphQL node id (carried verbatim — write routes address
 * threads by it); `diffSide`/`startDiffSide` are read here and pushed onto each
 * comment as `side`/`start_side`, since a comment node has no side fields of
 * its own.
 */
export function normalizeReviewThread(node: GhReviewThreadNode): ReviewThread {
  const side = toSide(node.diffSide)
  const startSide = toStartSide(node.startDiffSide)
  return {
    id: node.id,
    isResolved: node.isResolved === true,
    isOutdated: node.isOutdated === true,
    path: typeof node.path === 'string' ? node.path : '',
    line: typeof node.line === 'number' ? node.line : null,
    originalLine: typeof node.originalLine === 'number' ? node.originalLine : null,
    startLine: typeof node.startLine === 'number' ? node.startLine : null,
    originalStartLine:
      typeof node.originalStartLine === 'number' ? node.originalStartLine : null,
    diffSide: side,
    startDiffSide: startSide,
    subjectType: toThreadSubjectType(node.subjectType),
    resolvedBy:
      node.resolvedBy && typeof node.resolvedBy.login === 'string'
        ? { login: node.resolvedBy.login }
        : null,
    comments: node.comments.nodes.map((c) => normalizeComment(c, side, startSide)),
  }
}

/** Normalize a page of GraphQL thread nodes onto the contract `ReviewThread[]`. */
export function normalizeReviewThreads(nodes: GhReviewThreadNode[]): ReviewThread[] {
  return nodes.map(normalizeReviewThread)
}

/** A tiny request-count sink so the caller can fold GraphQL cost into `syncStats.requests`. */
export interface RequestBump {
  bump(by?: number): void
}

/**
 * Fetch every review thread for a PR and normalize it to the contract shape.
 *
 * Threads are the MUTABLE half — a thread can resolve or a comment land with no
 * commit — so this runs on every sync. It paginates the `reviewThreads`
 * connection via its `pageInfo`, and, for any thread whose comments exceeded a
 * single page, drains the rest by the thread's node id and appends them before
 * normalizing. Every GraphQL request is counted through `counter` so
 * `syncStats.requests` stays honest about the mutable-half cost.
 */
export async function fetchReviewThreads(
  github: GithubClient,
  repo: RepoRef,
  prNumber: number,
  counter: RequestBump,
): Promise<ReviewThread[]> {
  const nodes: GhReviewThreadNode[] = []
  let cursor: string | null = null
  for (;;) {
    const page: { pageInfo: GhGraphqlPageInfo; nodes: GhReviewThreadNode[] } =
      await github.getReviewThreads(repo.owner, repo.repo, prNumber, cursor)
    counter.bump()
    for (const thread of page.nodes) {
      await drainThreadComments(github, thread, counter)
      nodes.push(thread)
    }
    if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) break
    cursor = page.pageInfo.endCursor
  }
  return normalizeReviewThreads(nodes)
}

/**
 * If a thread's comments overflowed the first page, fetch the remaining pages by
 * the thread's node id and append them to the thread node in place, so the
 * normalized thread carries EVERY comment. No-op for the common case of a thread
 * that fit in one page.
 */
async function drainThreadComments(
  github: GithubClient,
  thread: GhReviewThreadNode,
  counter: RequestBump,
): Promise<void> {
  let info = thread.comments.pageInfo
  while (info.hasNextPage && info.endCursor !== null) {
    const next: { pageInfo: GhGraphqlPageInfo; nodes: GhReviewCommentNode[] } =
      await github.getThreadComments(thread.id, info.endCursor)
    counter.bump()
    thread.comments.nodes.push(...next.nodes)
    info = next.pageInfo
  }
}
