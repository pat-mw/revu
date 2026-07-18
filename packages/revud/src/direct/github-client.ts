import type { GhUser, PullSummary, RateLimitInfo } from '@revu/shared'
import { mapUser } from './mappers'
import type { TokenSource } from './token-source'

/**
 * A minimal authenticated GitHub REST client. It carries just enough to read the
 * authenticated viewer (`GET /user`) for session assembly; the sync engine and
 * write path extend it later. It is deliberately injectable — it takes a
 * `fetch`-like function and a `TokenSource` — so tests exercise it with a fake
 * that never opens a socket, and so the real token never has to be present in a
 * unit test.
 *
 * Token custody: the token is pulled from the `TokenSource` per request and set
 * as a Bearer header. It is never logged and never placed in a URL or an error
 * message.
 */

/** The `fetch`-shaped function the client depends on (the global by default, a fake in tests). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** The subset of `GET /user` the session needs: the viewer's own login. */
export interface GithubViewer {
  login: string
  id: number
}

/** A page of a paginated list plus whether GitHub advertised a next page via `Link: rel="next"`. */
export interface Page<T> {
  items: T[]
  hasNext: boolean
}

/** Parameters common to a paginated REST read. */
export interface PageParams {
  /** 1-based page index (GitHub's `page` query parameter). */
  page: number
  /** Items per page; the sync engine uses the max of 100 to minimize requests. */
  perPage: number
}

export interface GithubClientOptions {
  tokenSource: TokenSource
  /** Injected transport; defaults to the global `fetch`. */
  fetchImpl?: FetchLike
  /** Base API URL; defaults to public GitHub. Overridable for a test double. */
  baseUrl?: string
  /**
   * GraphQL endpoint URL; defaults to public GitHub's. Overridable for a test
   * double so the thread read never opens a socket.
   */
  graphqlUrl?: string
}

const DEFAULT_BASE_URL = 'https://api.github.com'
const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql'

/** Pinned REST API version and a descriptive agent, sent on every request. */
const API_VERSION = '2022-11-28'
const USER_AGENT = 'revu-revud'

/**
 * A GitHub request failed at the HTTP layer (a non-2xx status). Carries the
 * status and a short body excerpt for diagnostics. The excerpt is bounded and
 * the token is never part of the request that produced it, so nothing sensitive
 * is captured here.
 */
export class GithubRequestError extends Error {
  readonly status: number

  constructor(status: number, path: string, bodyExcerpt: string, method = 'GET') {
    super(`GitHub request ${method} ${path} failed with HTTP ${status}: ${bodyExcerpt}`)
    this.name = 'GithubRequestError'
    this.status = status
  }
}

/**
 * A GraphQL request failed — either at the HTTP layer (a non-2xx) or because the
 * response carried a top-level `errors` array. The excerpt is bounded and the
 * token is never part of the request that produced it, so nothing sensitive is
 * captured here.
 */
export class GithubGraphqlError extends Error {
  constructor(detail: string) {
    super(`GitHub GraphQL request failed: ${detail}`)
    this.name = 'GithubGraphqlError'
  }
}

/**
 * The GitHub-shaped raw responses the sync engine reads. These mirror the real
 * REST payloads (only the fields the engine consumes are named); the sync engine
 * maps them onto the contract types (`PullFile`, `CommitInfo`, …).
 */

/** Raw `GET /repos/{o}/{r}/pulls/{n}` — the fields the engine derives detail from. */
export interface GhPullDetailRaw {
  head: { sha: string }
  base: { sha: string }
}

/** Raw `GET /repos/{o}/{r}/compare/{base}...{head}` — only the merge base is read. */
export interface GhCompareRaw {
  merge_base_commit: { sha: string }
}

/**
 * The result of one conditional open-pulls list read. `items` are the REST list
 * rows mapped onto the contract's `PullSummary`; `etag` is the ENTITY tag GitHub
 * returned (or the one echoed back on a 304), which the poll loop stores between
 * rounds so the next request can be conditional. `notModified` is true when
 * GitHub answered `304 Not Modified` — a free read against the shared rate
 * bucket — in which case `items` is EMPTY (the caller keeps its last-known list)
 * and the poll loop must not refresh anything. `rateLimit` is read from the
 * response's `x-ratelimit-*` headers so the served list can report live remaining
 * budget; on a 304 GitHub still returns those headers.
 */
export interface PullListPage {
  items: PullSummary[]
  etag: string
  notModified: boolean
  rateLimit: RateLimitInfo | null
}

/**
 * Cheap per-pull facts fetched in ONE batched GraphQL query for the pulls that
 * changed since the last poll — never the whole list. `unresolvedThreads` is the
 * count of a PR's review threads that are not resolved (a `reviewThreads`
 * connection filtered client-side to `isResolved === false`); `commitCount` is
 * the PR's total commit count (`commits.totalCount`). These feed the served
 * list's `BrokerPullMeta` without a full sync.
 */
export interface PullFacts {
  unresolvedThreads: number
  commitCount: number
}

/**
 * The narrow client the broker poll loop depends on: a conditional open-pulls
 * list plus the batched per-pull facts. Kept SEPARATE from `GithubClient` so the
 * many read/write test fakes that implement `GithubClient` need not grow these
 * methods, and so the poll loop's dependency surface is exactly the two calls it
 * makes. `createGithubClient` returns a value that satisfies BOTH interfaces.
 */
export interface PullListClient {
  /**
   * `GET /repos/{o}/{r}/pulls?state=open&per_page=100` with an optional
   * `If-None-Match`. Returns the mapped list rows, the response ETag, whether
   * GitHub answered `304`, and the parsed rate-limit headers. A 304 costs
   * nothing against the shared bucket, which is what makes idle polling cheap.
   * Throws `GithubRequestError` on any non-2xx that is not a 304.
   *
   * ONE page only: `per_page=100` and NO `Link`-header pagination follow-up, so
   * an inbox with more than 100 concurrently-open pulls is capped at the first
   * 100 rows. Accepted for the poll-cache inbox (a review queue that large is out
   * of scope); a paginated sweep would multiply the per-tick cost this cache
   * exists to keep flat.
   */
  listOpenPulls(owner: string, repo: string, etag: string | null): Promise<PullListPage>

  /**
   * One batched GraphQL query returning `{ unresolvedThreads, commitCount }` per
   * requested PR number, for the CHANGED pulls only. The result maps each input
   * number to its facts; a number GitHub could not resolve is omitted. Throws
   * `GithubGraphqlError` on a non-2xx or a top-level `errors` array.
   */
  getPullFacts(
    owner: string,
    repo: string,
    prNumbers: number[],
  ): Promise<Record<number, PullFacts>>
}

/** Raw item from `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1`. */
export interface GhTreeEntry {
  path: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
}

export interface GhTreeRaw {
  tree: GhTreeEntry[]
  /** True when the tree was too large to return whole (rare; handled honestly). */
  truncated: boolean
}

/**
 * Raw `GET /repos/{o}/{r}/git/blobs/{sha}` — one blob by its SHA. GitHub returns
 * the bytes base64-encoded (`encoding: 'base64'`) with the encoded string in
 * `content` and the decoded byte length in `size`. Only these fields are read;
 * the caller decodes and applies the binary heuristic.
 */
export interface GhBlobRaw {
  content: string
  encoding: string
  size: number
}

/**
 * One pending comment as `POST /pulls/{n}/reviews` accepts it. Field names match
 * the contract's `PendingComment` 1:1 (the names were chosen to). `start_line` /
 * `start_side` are present ONLY for a multi-line comment; a single-line comment
 * OMITS them entirely, because GitHub rejects a review comment that carries a
 * `start_line` equal to its `line`.
 */
export interface ReviewCommentInput {
  path: string
  side: 'LEFT' | 'RIGHT'
  line: number
  start_line?: number
  start_side?: 'LEFT' | 'RIGHT'
  body: string
}

/**
 * The body of `POST /repos/{o}/{r}/pulls/{n}/reviews`. `commit_id` pins the
 * review to the exact head the draft targeted (the guard already proved it is
 * current); `event` is the review verdict; `comments` are the inline comments,
 * each mapped from a `PendingComment`. An empty `comments` array posts a review
 * with only a body.
 */
export interface SubmitReviewBody {
  commit_id: string
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
  body: string
  comments: ReviewCommentInput[]
}

/**
 * One entry of a GraphQL `object(oid:)` batch: a blob addressed by its git SHA.
 * `text` is null when GitHub deems the object binary (it does not return text
 * for binaries) or cannot render it, `isBinary` is null when GitHub could not
 * determine the encoding, and `isTruncated` is true when the returned `text`
 * was clipped rather than complete — a caller must never store truncated text
 * as the whole blob. `byteSize` comes straight from the schema. A batch
 * requests many of these under aliased `object()` fields in one query.
 * `isTruncated` is optional so fakes that predate the field stay valid; an
 * absent value reads as "not truncated".
 */
export interface GhGraphqlBlobObject {
  isBinary: boolean | null
  text: string | null
  byteSize: number | null
  isTruncated?: boolean | null
}

/**
 * Raw GraphQL nodes for a PR's review threads. These mirror the GraphQL schema's
 * `PullRequestReviewThread` / `PullRequestReviewComment` shapes (only the fields
 * the normalizer reads are named); the normalizer maps them onto the contract's
 * REST-shaped `ReviewThread` / `ReviewComment`.
 *
 * Two schema facts drive the shape:
 *   - `fullDatabaseId` is a GraphQL `BigInt`, serialized as a JSON STRING, so it
 *     is typed `string | number | null` here and coerced to the REST-numeric id.
 *   - `diffSide` and `subjectType` live on the THREAD, not the comment: a comment
 *     node has no `diffSide` field. The thread's values are pushed onto each of
 *     its comments during normalization.
 */
export interface GhGraphqlPageInfo {
  hasNextPage: boolean
  endCursor: string | null
}

export interface GhReviewCommentNode {
  fullDatabaseId: string | number | null
  path: string | null
  diffHunk: string | null
  line: number | null
  originalLine: number | null
  startLine: number | null
  originalStartLine: number | null
  subjectType: string | null
  body: string | null
  createdAt: string | null
  updatedAt: string | null
  author: { login: string } | null
  pullRequestReview: { fullDatabaseId: string | number | null } | null
  replyTo: { fullDatabaseId: string | number | null } | null
  commit: { oid: string } | null
  originalCommit: { oid: string } | null
  url: string | null
}

export interface GhReviewThreadNode {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string | null
  line: number | null
  originalLine: number | null
  startLine: number | null
  originalStartLine: number | null
  diffSide: string | null
  startDiffSide: string | null
  subjectType: string | null
  resolvedBy: { login: string } | null
  comments: { pageInfo: GhGraphqlPageInfo; nodes: GhReviewCommentNode[] }
}

/**
 * The one endpoint session assembly needs: the authenticated viewer. Kept as a
 * narrow interface so session code (and its tests) depend only on `getViewer`,
 * not on the whole sync read surface.
 */
export interface GithubViewerClient {
  /** The authenticated viewer (`GET /user`). Throws `GithubRequestError` on a non-2xx. */
  getViewer(): Promise<GithubViewer>
}

/**
 * The authenticated REST client. `getViewer` reads the session's own login; the
 * rest are the sync engine's read surface. Every method throws
 * `GithubRequestError` on a non-2xx; the token is confined to the header.
 */
export interface GithubClient extends GithubViewerClient {
  /** `GET /repos/{o}/{r}/pulls/{n}` — pull detail (head/base SHAs live here). */
  getPullDetail(owner: string, repo: string, prNumber: number): Promise<unknown>

  /** `GET /repos/{o}/{r}/compare/{base}...{head}` — the merge base SHA of a compare. */
  getCompare(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<GhCompareRaw>

  /** `GET /repos/{o}/{r}/pulls/{n}/files` — one page of changed files. */
  getPullFiles(
    owner: string,
    repo: string,
    prNumber: number,
    params: PageParams,
  ): Promise<Page<unknown>>

  /** `GET /repos/{o}/{r}/issues/{n}/comments` — one page of conversation comments. */
  getIssueComments(
    owner: string,
    repo: string,
    prNumber: number,
    params: PageParams,
  ): Promise<Page<unknown>>

  /** `GET /repos/{o}/{r}/pulls/{n}/reviews` — one page of submitted reviews. */
  getPullReviews(
    owner: string,
    repo: string,
    prNumber: number,
    params: PageParams,
  ): Promise<Page<unknown>>

  /** `GET /repos/{o}/{r}/pulls/{n}/commits` — one page of PR commits. */
  getPullCommits(
    owner: string,
    repo: string,
    prNumber: number,
    params: PageParams,
  ): Promise<Page<unknown>>

  /** `GET /repos/{o}/{r}/commits/{sha}/check-runs` — check runs for a commit. */
  getCheckRuns(owner: string, repo: string, sha: string): Promise<unknown>

  /** `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` — the full recursive tree of a commit. */
  getTree(owner: string, repo: string, sha: string): Promise<GhTreeRaw>

  /**
   * `GET /repos/{o}/{r}/git/blobs/{sha}` — one blob by its SHA, base64-encoded.
   * The single-blob REST fallback used when local git lacks a SHA and the batch
   * path is not worth a whole GraphQL round trip. Throws `GithubRequestError` on
   * a non-2xx exactly as the other REST reads.
   */
  getBlob(owner: string, repo: string, sha: string): Promise<GhBlobRaw>

  /**
   * Batch-fetch many blobs by SHA in ONE GraphQL query via aliased `object(oid:)`
   * fields (`... on Blob { isBinary text byteSize isTruncated }`). The result maps each input
   * SHA to its blob object, or to `null` when GitHub could not resolve that oid.
   * This is the cold-cache fallback: ~30 blobs per request keeps a large cold
   * sync's API cost low when the local clone is missing the objects. Throws
   * `GithubGraphqlError` on a non-2xx or a top-level `errors` array.
   */
  getBlobObjects(
    owner: string,
    repo: string,
    shas: string[],
  ): Promise<Record<string, GhGraphqlBlobObject | null>>

  /**
   * `POST /graphql` — run one GraphQL query with variables, returning the parsed
   * `data` payload typed as `T`. Throws `GithubGraphqlError` on a non-2xx or when
   * the response carries top-level `errors`. This is the seam the review-thread
   * read (a GraphQL-only concern) is built on; the token is confined to the
   * Bearer header exactly as the REST path does.
   */
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>

  /**
   * One page of a pull request's review threads, in GraphQL vocabulary. `cursor`
   * is the `after` argument for `reviewThreads` — null for the first page. The
   * sync engine paginates with the returned `pageInfo`; the normalizer maps the
   * nodes onto the contract's REST `ReviewThread[]`.
   */
  getReviewThreads(
    owner: string,
    repo: string,
    prNumber: number,
    cursor: string | null,
  ): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: GhReviewThreadNode[] }>

  /**
   * One page of a single thread's comments, addressed by the thread's node id.
   * Called only to drain a thread whose comments exceeded the first page; `cursor`
   * is the `after` argument (null for the first overflow page).
   */
  getThreadComments(
    threadId: string,
    cursor: string | null,
  ): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: GhReviewCommentNode[] }>

  // ——— the write surface ———

  /**
   * `POST /repos/{o}/{r}/pulls/{n}/reviews` — submit one review with its inline
   * comments in a single call. Returns the raw created-review body (the caller
   * maps it onto `ReviewSummary`). Throws `GithubRequestError` on a non-2xx: a
   * `422` here means a comment failed server-side validation (a force-push in the
   * guard-to-post window), which the write path turns into a `conflict` while
   * KEEPING the draft.
   */
  submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    body: SubmitReviewBody,
  ): Promise<unknown>

  /**
   * `POST /repos/{o}/{r}/pulls/{n}/comments/{commentId}/replies` — reply to an
   * existing review comment. The contract addresses a THREAD, but REST wants a
   * COMMENT id; the caller passes the thread's FIRST comment id and GitHub
   * attaches the reply to the thread root. Returns the raw created-comment body
   * (the caller normalizes it onto `ReviewComment`).
   */
  replyToReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<unknown>

  /**
   * `POST /repos/{o}/{r}/pulls/comments/{commentId}/reactions` — add a reaction
   * to a review comment. Returns the raw created-reaction body. GitHub dedupes a
   * reaction per user, and there is one authenticated user here, so a repeated
   * identical reaction is a no-op on the rollup — the shared-and-honest
   * constraint. The caller re-reads the comment's rollup to report it.
   */
  addReaction(
    owner: string,
    repo: string,
    commentId: number,
    reaction: string,
  ): Promise<unknown>

  /**
   * `GET /repos/{o}/{r}/pulls/comments/{commentId}` — one review comment by id,
   * used to read back a comment's current reaction rollup after a reaction POST
   * (GitHub's reaction response carries only the single reaction, not the whole
   * rollup). Returns the raw comment body.
   */
  getReviewComment(owner: string, repo: string, commentId: number): Promise<unknown>

  /**
   * `GET /repos/{o}/{r}/pulls/{n}/reviews/{reviewId}/comments` — one page of the
   * inline comments belonging to ONE submitted review. Used by the submit
   * idempotency re-check: the review-level fields (author, commit, verdict,
   * body) can coincide across two DIFFERENT submits — an empty summary body at
   * the same head is the common case — so before short-circuiting to an
   * existing review as "already posted", the write path proves its inline
   * comments equal the ones this submit carries.
   */
  getReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
    reviewId: number,
    params: PageParams,
  ): Promise<Page<unknown>>

  /**
   * `GET /repos/{o}/{r}/pulls/{n}/comments` — one page of EVERY review comment
   * on the pull request, across all reviews and threads, as one flat paginated
   * list. This is the host-side audit-reconcile read: `getReviewComments`
   * above can only enumerate the comments of a review whose id is already
   * known, but a comment posted directly against the PR (bypassing revu)
   * belongs to no known review — only the flat list is guaranteed to surface
   * it. A read, not a write; it never runs inside a workspace request path.
   */
  getPullReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
    params: PageParams,
  ): Promise<Page<unknown>>

  /**
   * `POST /repos/{o}/{r}/issues/comments/{commentId}/reactions` — add a reaction
   * to an ISSUE (conversation-tab) comment. Issue comments live in a different
   * id namespace than PR review comments and take a different reactions
   * endpoint; the write path picks this one when the target id belongs to a
   * conversation comment in the cached snapshot.
   */
  addIssueCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    reaction: string,
  ): Promise<unknown>

  /**
   * `GET /repos/{o}/{r}/issues/comments/{commentId}` — one issue (conversation)
   * comment by id, used to read back its reaction rollup after a reaction POST,
   * exactly as `getReviewComment` does for a review comment.
   */
  getIssueComment(owner: string, repo: string, commentId: number): Promise<unknown>

  /**
   * Run the GraphQL `resolveReviewThread` / `unresolveReviewThread` mutation for
   * the `PRRT_` thread node id, returning the mutated thread node. Which mutation
   * runs is chosen by `resolved`. Throws `GithubGraphqlError` on a non-2xx or a
   * top-level `errors` array.
   */
  setThreadResolution(
    threadId: string,
    resolved: boolean,
  ): Promise<GhReviewThreadNode>
}

/**
 * The GraphQL query for one page of a PR's review threads with nested comments.
 *
 * `diffSide` / `subjectType` are read at the THREAD level (the comment type has
 * no `diffSide`); `fullDatabaseId` gives the REST-numeric comment id (a `BigInt`,
 * so it arrives as a JSON string). Both connections carry `pageInfo` so a PR with
 * more than 100 threads — or a thread with more than 100 comments — paginates
 * honestly rather than silently truncating.
 */
const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          originalStartLine
          diffSide
          startDiffSide
          subjectType
          resolvedBy { login }
          comments(first:100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              fullDatabaseId
              path
              diffHunk
              line
              originalLine
              startLine
              originalStartLine
              subjectType
              body
              createdAt
              updatedAt
              author { login }
              pullRequestReview { fullDatabaseId }
              replyTo { fullDatabaseId }
              commit { oid }
              originalCommit { oid }
              url
            }
          }
        }
      }
    }
  }
}`

/**
 * One page of a SINGLE thread's comments, addressed by the thread's node id via
 * `node(id:)` — used only when a thread carries more than 100 comments. Fetching
 * the thread directly avoids re-walking the whole `reviewThreads` connection just
 * to reach the one thread whose comments overflowed a page.
 */
const THREAD_COMMENTS_QUERY = `query($threadId:ID!,$after:String) {
  node(id:$threadId) {
    ... on PullRequestReviewThread {
      comments(first:100, after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          fullDatabaseId
          path
          diffHunk
          line
          originalLine
          startLine
          originalStartLine
          subjectType
          body
          createdAt
          updatedAt
          author { login }
          pullRequestReview { fullDatabaseId }
          replyTo { fullDatabaseId }
          commit { oid }
          originalCommit { oid }
          url
        }
      }
    }
  }
}`

/**
 * The selection returned by a resolve/unresolve mutation: the mutated thread in
 * the SAME node shape the read query returns, so the caller normalizes it with
 * the one normalizer. `resolvedBy` reads as the authenticated user (direct mode)
 * or the bot (broker mode); either way the UI already renders it.
 */
const RESOLVED_THREAD_SELECTION = `thread {
        id
        isResolved
        isOutdated
        path
        line
        originalLine
        startLine
        originalStartLine
        diffSide
        startDiffSide
        subjectType
        resolvedBy { login }
        comments(first:100) {
          pageInfo { hasNextPage endCursor }
          nodes {
            fullDatabaseId
            path
            diffHunk
            line
            originalLine
            startLine
            originalStartLine
            subjectType
            body
            createdAt
            updatedAt
            author { login }
            pullRequestReview { fullDatabaseId }
            replyTo { fullDatabaseId }
            commit { oid }
            originalCommit { oid }
            url
          }
        }
      }`

/** `resolveReviewThread` mutation — marks the `PRRT_` thread resolved. */
const RESOLVE_THREAD_MUTATION = `mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) {
    ${RESOLVED_THREAD_SELECTION}
  }
}`

/** `unresolveReviewThread` mutation — reopens the `PRRT_` thread. */
const UNRESOLVE_THREAD_MUTATION = `mutation($threadId:ID!) {
  unresolveReviewThread(input:{threadId:$threadId}) {
    ${RESOLVED_THREAD_SELECTION}
  }
}`

/**
 * Build a GraphQL query that fetches many blobs in one request by aliasing a
 * `object(oid:)` field per SHA. Each object is narrowed with `... on Blob` to
 * read `isBinary`, `text` (null for binaries), `byteSize`, and `isTruncated`
 * (whether GitHub clipped the returned text). The alias is a
 * fixed `b<index>` prefix — never the SHA itself — so a SHA is never
 * interpolated into the query as a field name (GraphQL aliases must match
 * `/^[_A-Za-z][_0-9A-Za-z]*$/`, which a hex SHA satisfies but a defensive prefix
 * guarantees regardless of the oid's shape). SHAs travel as `$o<index>`
 * variables, never spliced into the query string.
 */
function buildBlobObjectsQuery(count: number): string {
  const varDecls: string[] = []
  const fields: string[] = []
  for (let i = 0; i < count; i++) {
    varDecls.push(`$o${i}:GitObjectID!`)
    fields.push(
      `b${i}: object(oid:$o${i}) { ... on Blob { isBinary text byteSize isTruncated } }`,
    )
  }
  return `query($owner:String!,$repo:String!,${varDecls.join(',')}) {
  repository(owner:$owner, name:$repo) {
    ${fields.join('\n    ')}
  }
}`
}

/**
 * Build a GraphQL query that reads cheap facts for MANY pulls in one request by
 * aliasing a `pullRequest(number:)` field per PR number. Each pull reads its
 * `commits.totalCount` and, filtered client-side, the count of unresolved review
 * threads (GraphQL has no server-side `isResolved` filter on the connection, so
 * the first page of `reviewThreads` carries `isResolved` and the caller counts
 * the unresolved ones). The alias is a fixed `p<index>` prefix — never the number
 * itself spliced into the query — and numbers travel as `$n<index>` variables,
 * so nothing caller-derived is interpolated into the query string. The
 * `reviewThreads(first:100)` page covers the overwhelmingly common case; a PR
 * with more than 100 threads under-counts, which is acceptable for an inbox
 * badge (a full sync computes the exact set).
 */
function buildPullFactsQuery(count: number): string {
  const varDecls: string[] = ['$owner:String!', '$repo:String!']
  const fields: string[] = []
  for (let i = 0; i < count; i++) {
    varDecls.push(`$n${i}:Int!`)
    fields.push(
      `p${i}: pullRequest(number:$n${i}) {\n` +
        `      commits { totalCount }\n` +
        `      reviewThreads(first:100) { nodes { isResolved } }\n` +
        `    }`,
    )
  }
  return `query(${varDecls.join(',')}) {
  repository(owner:$owner, name:$repo) {
    ${fields.join('\n    ')}
  }
}`
}

/** Raw shape of one aliased pull node in the batched facts query. */
interface GhPullFactsNode {
  commits: { totalCount: number } | null
  reviewThreads: { nodes: { isResolved: boolean }[] } | null
}

/**
 * Parse GitHub's `x-ratelimit-*` response headers into `RateLimitInfo`. Returns
 * null when the headers are absent (a test double may omit them), so the caller
 * falls back to its last-known value rather than fabricating a bucket. `reset` is
 * a unix-epoch SECONDS integer on the wire; it is rendered to the ISO string the
 * contract carries.
 */
function rateLimitFromHeaders(headers: Headers): RateLimitInfo | null {
  const limit = Number(headers.get('x-ratelimit-limit'))
  const remaining = Number(headers.get('x-ratelimit-remaining'))
  const used = Number(headers.get('x-ratelimit-used'))
  const resetEpoch = Number(headers.get('x-ratelimit-reset'))
  if (
    !Number.isFinite(limit) ||
    !Number.isFinite(remaining) ||
    !Number.isFinite(resetEpoch)
  ) {
    return null
  }
  return {
    limit,
    remaining,
    used: Number.isFinite(used) ? used : limit - remaining,
    reset: new Date(resetEpoch * 1000).toISOString(),
  }
}

/**
 * Map one raw row from `GET /repos/{o}/{r}/pulls` onto the contract's
 * `PullSummary` — EXACTLY the list-shaped fields, never the detail-only counts a
 * list read does not carry. Missing/mistyped fields default to their zero value
 * so a malformed row never throws mid-poll; the served list stays well-typed. The
 * field set matches the mock oracle's `toSummary`, so the broker's list items are
 * shape-identical to mock's.
 */
function mapPullSummaryRow(raw: unknown): PullSummary {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const num = (k: string): number => (typeof p[k] === 'number' ? (p[k] as number) : 0)
  const blankUser: GhUser = {
    login: '',
    id: 0,
    node_id: '',
    avatar_url: '',
    html_url: '',
    type: 'User',
  }
  const requestedReviewers = Array.isArray(p.requested_reviewers)
    ? (p.requested_reviewers as unknown[])
        .map(mapUser)
        .filter((u): u is GhUser => u !== null)
    : []
  const labels = (rawLabels: unknown): PullSummary['labels'] =>
    Array.isArray(rawLabels)
      ? (rawLabels as unknown[])
          .map((l) => {
            const lo = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>
            if (typeof lo.name !== 'string') return null
            return {
              id: typeof lo.id === 'number' ? lo.id : 0,
              name: lo.name,
              color: typeof lo.color === 'string' ? lo.color : '',
              description: typeof lo.description === 'string' ? lo.description : null,
            }
          })
          .filter((l): l is NonNullable<typeof l> => l !== null)
      : []
  const ref = (side: 'head' | 'base'): PullSummary['head'] => {
    const s = (p[side] && typeof p[side] === 'object' ? p[side] : {}) as Record<string, unknown>
    const repo = (s.repo && typeof s.repo === 'object' ? s.repo : {}) as Record<string, unknown>
    return {
      ref: typeof s.ref === 'string' ? s.ref : '',
      sha: typeof s.sha === 'string' ? s.sha : '',
      label: typeof s.label === 'string' ? s.label : '',
      repo: {
        full_name: typeof repo.full_name === 'string' ? repo.full_name : '',
        default_branch:
          typeof repo.default_branch === 'string' ? repo.default_branch : '',
      },
    }
  }
  return {
    id: num('id'),
    node_id: str('node_id'),
    number: num('number'),
    state: p.state === 'closed' ? 'closed' : 'open',
    draft: p.draft === true,
    merged_at: typeof p.merged_at === 'string' ? p.merged_at : null,
    title: str('title'),
    body: typeof p.body === 'string' ? p.body : null,
    user: mapUser(p.user) ?? blankUser,
    labels: labels(p.labels),
    requested_reviewers: requestedReviewers,
    head: ref('head'),
    base: ref('base'),
    created_at: str('created_at'),
    updated_at: str('updated_at'),
  }
}

/** Parse a `Link` header for a `rel="next"` relation (GitHub pagination). */
function hasNextLink(link: string | null): boolean {
  if (!link) return false
  return /;\s*rel="next"/.test(link)
}

/**
 * A content-derived ETag for a mapped list, used ONLY when a 200 response
 * carries no `etag` header. djb2 over `JSON.stringify(items)`, the same weak-ETag
 * scheme the in-browser mock uses, so the derived tag tracks content: two
 * DIFFERENT item sets can never share one tag (which would 304 a client onto
 * stale content), and two IDENTICAL item sets always share one tag (so a
 * conditional client can still 304 across an unchanged, ETag-less list).
 */
function contentEtagForItems(items: PullSummary[]): string {
  let hash = 5381
  const input = JSON.stringify(items)
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0
  }
  return `W/"${hash.toString(16)}"`
}

/**
 * Build the authenticated client. Every request sends `Authorization: Bearer
 * <token>` (token from the `TokenSource`), the pinned `X-GitHub-Api-Version`, a
 * JSON `Accept`, and a `User-Agent` (GitHub rejects requests without one). The
 * token is read fresh per call and confined to the header.
 */
export function createGithubClient(opts: GithubClientOptions): GithubClient & PullListClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const graphqlUrl = opts.graphqlUrl ?? DEFAULT_GRAPHQL_URL

  /** Issue one authenticated GET, returning the parsed body and the raw response. */
  async function getRaw(path: string): Promise<{ body: unknown; res: Response }> {
    const token = await opts.tokenSource.getToken()
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        'user-agent': USER_AGENT,
      },
    })
    if (!res.ok) {
      // Read a bounded excerpt for the error; the token is not in this response.
      const text = await res.text().catch(() => '')
      throw new GithubRequestError(res.status, path, text.slice(0, 200))
    }
    return { body: (await res.json()) as unknown, res }
  }

  async function getJson(path: string): Promise<unknown> {
    return (await getRaw(path)).body
  }

  /**
   * Issue one authenticated conditional GET. When `etag` is present it is sent as
   * `If-None-Match`; a `304 Not Modified` is a SUCCESS here (never an error),
   * returned with `notModified: true` and no body. Any other non-2xx throws
   * `GithubRequestError` exactly as `getRaw` does. The token stays in the header.
   */
  async function getConditional(
    path: string,
    etag: string | null,
  ): Promise<{ body: unknown; res: Response; notModified: boolean }> {
    const token = await opts.tokenSource.getToken()
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': USER_AGENT,
    }
    if (etag !== null && etag.length > 0) headers['if-none-match'] = etag
    const res = await fetchImpl(`${baseUrl}${path}`, { method: 'GET', headers })
    if (res.status === 304) {
      await res.body?.cancel().catch(() => {})
      return { body: null, res, notModified: true }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new GithubRequestError(res.status, path, text.slice(0, 200))
    }
    return { body: (await res.json()) as unknown, res, notModified: false }
  }

  /**
   * Issue one authenticated POST with a JSON body, returning the parsed response.
   * The token is confined to the header exactly as the GET path. A non-2xx throws
   * `GithubRequestError` carrying the status (so a `422` reaches the write path
   * as a status the draft-retention logic can branch on) and a bounded, token-
   * free excerpt. A `204 No Content` (some write endpoints) parses to `null`.
   */
  async function postJson(path: string, jsonBody: unknown): Promise<unknown> {
    const token = await opts.tokenSource.getToken()
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': API_VERSION,
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(jsonBody),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new GithubRequestError(res.status, path, text.slice(0, 200), 'POST')
    }
    if (res.status === 204) return null
    return (await res.json().catch(() => null)) as unknown
  }

  /** GET a paginated list page, reading `hasNext` from the `Link` header. */
  async function getPage(path: string, params: PageParams): Promise<Page<unknown>> {
    const sep = path.includes('?') ? '&' : '?'
    const url = `${path}${sep}per_page=${params.perPage}&page=${params.page}`
    const { body, res } = await getRaw(url)
    const items = Array.isArray(body) ? (body as unknown[]) : []
    return { items, hasNext: hasNextLink(res.headers.get('link')) }
  }

  /**
   * POST one GraphQL query with variables. Same Bearer token and User-Agent as
   * the REST path; the token stays in the header. A non-2xx or a top-level
   * `errors` array becomes a `GithubGraphqlError` with a bounded, token-free
   * excerpt.
   */
  async function postGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await opts.tokenSource.getToken()
    const res = await fetchImpl(graphqlUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new GithubGraphqlError(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const payload = (await res.json()) as { data?: T; errors?: unknown }
    if (payload.errors !== undefined && payload.errors !== null) {
      throw new GithubGraphqlError(JSON.stringify(payload.errors).slice(0, 300))
    }
    if (payload.data === undefined || payload.data === null) {
      throw new GithubGraphqlError('response carried no data')
    }
    return payload.data
  }

  const enc = encodeURIComponent

  return {
    async getViewer(): Promise<GithubViewer> {
      const body = (await getJson('/user')) as { login?: unknown; id?: unknown }
      if (typeof body.login !== 'string' || typeof body.id !== 'number') {
        throw new GithubRequestError(200, '/user', 'response missing login/id')
      }
      return { login: body.login, id: body.id }
    },

    async listOpenPulls(
      owner: string,
      repo: string,
      etag: string | null,
    ): Promise<PullListPage> {
      const path = `/repos/${enc(owner)}/${enc(repo)}/pulls?state=open&per_page=100`
      const { body, res, notModified } = await getConditional(path, etag)
      const githubEtag = res.headers.get('etag')
      const rateLimit = rateLimitFromHeaders(res.headers)
      if (notModified) {
        // A 304 carries no body: the caller keeps its last-known items. A 304 is
        // only ever returned when we sent an If-None-Match, so GitHub echoes that
        // same ETag; fall back to the request tag if the header is somehow absent.
        return { items: [], etag: githubEtag ?? etag ?? '', notModified: true, rateLimit }
      }
      const rows = Array.isArray(body) ? (body as unknown[]) : []
      const items = rows.map(mapPullSummaryRow)
      // A 200 with a GitHub ETag uses it (restart-stable: unchanged content yields
      // the SAME entity tag across a process restart). But a 200 that LACKS an
      // ETag must NOT reuse the prior/request tag — that would freeze one tag over
      // rotating content and 304 conditional clients forever onto stale items.
      // Derive a content-tracking tag from the mapped items instead, so the tag
      // moves iff the content moves.
      const responseEtag =
        githubEtag !== null && githubEtag.length > 0
          ? githubEtag
          : contentEtagForItems(items)
      return {
        items,
        etag: responseEtag,
        notModified: false,
        rateLimit,
      }
    },

    async getPullFacts(
      owner: string,
      repo: string,
      prNumbers: number[],
    ): Promise<Record<number, PullFacts>> {
      const out: Record<number, PullFacts> = {}
      if (prNumbers.length === 0) return out
      const query = buildPullFactsQuery(prNumbers.length)
      const variables: Record<string, unknown> = { owner, repo }
      for (let i = 0; i < prNumbers.length; i++) variables[`n${i}`] = prNumbers[i]
      const data = await postGraphql<{
        repository: Record<string, GhPullFactsNode | null> | null
      }>(query, variables)
      const repository = data.repository
      for (let i = 0; i < prNumbers.length; i++) {
        const node = repository ? repository[`p${i}`] : null
        if (node === null || node === undefined) continue
        const unresolvedThreads = (node.reviewThreads?.nodes ?? []).filter(
          (t) => t.isResolved === false,
        ).length
        out[prNumbers[i]] = {
          unresolvedThreads,
          commitCount: node.commits?.totalCount ?? 0,
        }
      }
      return out
    },

    async getPullDetail(owner: string, repo: string, prNumber: number): Promise<unknown> {
      return getJson(`/repos/${enc(owner)}/${enc(repo)}/pulls/${prNumber}`)
    },

    async getCompare(
      owner: string,
      repo: string,
      base: string,
      head: string,
    ): Promise<GhCompareRaw> {
      const body = (await getJson(
        `/repos/${enc(owner)}/${enc(repo)}/compare/${enc(base)}...${enc(head)}`,
      )) as { merge_base_commit?: { sha?: unknown } }
      const sha = body.merge_base_commit?.sha
      if (typeof sha !== 'string' || sha.length === 0) {
        throw new GithubRequestError(
          200,
          `/repos/${owner}/${repo}/compare`,
          'compare response missing merge_base_commit.sha',
        )
      }
      return { merge_base_commit: { sha } }
    },

    async getPullFiles(
      owner: string,
      repo: string,
      prNumber: number,
      params: PageParams,
    ): Promise<Page<unknown>> {
      return getPage(`/repos/${enc(owner)}/${enc(repo)}/pulls/${prNumber}/files`, params)
    },

    async getIssueComments(
      owner: string,
      repo: string,
      prNumber: number,
      params: PageParams,
    ): Promise<Page<unknown>> {
      return getPage(`/repos/${enc(owner)}/${enc(repo)}/issues/${prNumber}/comments`, params)
    },

    async getPullReviews(
      owner: string,
      repo: string,
      prNumber: number,
      params: PageParams,
    ): Promise<Page<unknown>> {
      return getPage(`/repos/${enc(owner)}/${enc(repo)}/pulls/${prNumber}/reviews`, params)
    },

    async getPullCommits(
      owner: string,
      repo: string,
      prNumber: number,
      params: PageParams,
    ): Promise<Page<unknown>> {
      return getPage(`/repos/${enc(owner)}/${enc(repo)}/pulls/${prNumber}/commits`, params)
    },

    async getCheckRuns(owner: string, repo: string, sha: string): Promise<unknown> {
      return getJson(`/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}/check-runs`)
    },

    async getTree(owner: string, repo: string, sha: string): Promise<GhTreeRaw> {
      const body = (await getJson(
        `/repos/${enc(owner)}/${enc(repo)}/git/trees/${enc(sha)}?recursive=1`,
      )) as { tree?: unknown; truncated?: unknown }
      const tree = Array.isArray(body.tree) ? (body.tree as GhTreeEntry[]) : []
      return { tree, truncated: body.truncated === true }
    },

    async getBlob(owner: string, repo: string, sha: string): Promise<GhBlobRaw> {
      const body = (await getJson(
        `/repos/${enc(owner)}/${enc(repo)}/git/blobs/${enc(sha)}`,
      )) as { content?: unknown; encoding?: unknown; size?: unknown }
      return {
        content: typeof body.content === 'string' ? body.content : '',
        encoding: typeof body.encoding === 'string' ? body.encoding : '',
        size: typeof body.size === 'number' ? body.size : 0,
      }
    },

    async getBlobObjects(
      owner: string,
      repo: string,
      shas: string[],
    ): Promise<Record<string, GhGraphqlBlobObject | null>> {
      const result: Record<string, GhGraphqlBlobObject | null> = {}
      if (shas.length === 0) return result
      const query = buildBlobObjectsQuery(shas.length)
      const variables: Record<string, unknown> = { owner, repo }
      for (let i = 0; i < shas.length; i++) variables[`o${i}`] = shas[i]
      const data = await postGraphql<{
        repository: Record<string, GhGraphqlBlobObject | null> | null
      }>(query, variables)
      const repository = data.repository
      for (let i = 0; i < shas.length; i++) {
        // A blank/absent alias (the oid did not resolve to a Blob) maps to null,
        // so the caller can fall back rather than mint an empty blob.
        const obj = repository ? repository[`b${i}`] : null
        result[shas[i]] = obj ?? null
      }
      return result
    },

    graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      return postGraphql<T>(query, variables)
    },

    async getReviewThreads(
      owner: string,
      repo: string,
      prNumber: number,
      cursor: string | null,
    ): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: GhReviewThreadNode[] }> {
      const data = await postGraphql<{
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: GhGraphqlPageInfo; nodes: GhReviewThreadNode[] }
          } | null
        } | null
      }>(REVIEW_THREADS_QUERY, { owner, repo, number: prNumber, after: cursor })
      const conn = data.repository?.pullRequest?.reviewThreads
      if (conn === undefined || conn === null) {
        return { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
      }
      return { pageInfo: conn.pageInfo, nodes: conn.nodes }
    },

    async getThreadComments(
      threadId: string,
      cursor: string | null,
    ): Promise<{ pageInfo: GhGraphqlPageInfo; nodes: GhReviewCommentNode[] }> {
      const data = await postGraphql<{
        node: { comments: { pageInfo: GhGraphqlPageInfo; nodes: GhReviewCommentNode[] } } | null
      }>(THREAD_COMMENTS_QUERY, { threadId, after: cursor })
      const conn = data.node?.comments
      if (conn === undefined || conn === null) {
        return { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
      }
      return { pageInfo: conn.pageInfo, nodes: conn.nodes }
    },

    async submitReview(
      owner: string,
      repo: string,
      prNumber: number,
      body: SubmitReviewBody,
    ): Promise<unknown> {
      return postJson(`/repos/${enc(owner)}/${enc(repo)}/pulls/${prNumber}/reviews`, body)
    },

    async replyToReviewComment(
      owner: string,
      repo: string,
      prNumber: number,
      commentId: number,
      body: string,
    ): Promise<unknown> {
      // REST attaches a reply to the thread root regardless of which of the
      // thread's comments is addressed; the caller passes the FIRST comment id.
      return postJson(
        `/repos/${enc(owner)}/${enc(repo)}/pulls/${prNumber}/comments/${commentId}/replies`,
        { body },
      )
    },

    async addReaction(
      owner: string,
      repo: string,
      commentId: number,
      reaction: string,
    ): Promise<unknown> {
      return postJson(
        `/repos/${enc(owner)}/${enc(repo)}/pulls/comments/${commentId}/reactions`,
        { content: reaction },
      )
    },

    async getReviewComment(owner: string, repo: string, commentId: number): Promise<unknown> {
      return getJson(`/repos/${enc(owner)}/${enc(repo)}/pulls/comments/${commentId}`)
    },

    async getReviewComments(
      owner: string,
      repo: string,
      prNumber: number,
      reviewId: number,
      params: PageParams,
    ): Promise<Page<unknown>> {
      return getPage(
        `/repos/${enc(owner)}/${enc(repo)}/pulls/${prNumber}/reviews/${reviewId}/comments`,
        params,
      )
    },

    async getPullReviewComments(
      owner: string,
      repo: string,
      prNumber: number,
      params: PageParams,
    ): Promise<Page<unknown>> {
      return getPage(`/repos/${enc(owner)}/${enc(repo)}/pulls/${prNumber}/comments`, params)
    },

    async addIssueCommentReaction(
      owner: string,
      repo: string,
      commentId: number,
      reaction: string,
    ): Promise<unknown> {
      return postJson(
        `/repos/${enc(owner)}/${enc(repo)}/issues/comments/${commentId}/reactions`,
        { content: reaction },
      )
    },

    async getIssueComment(owner: string, repo: string, commentId: number): Promise<unknown> {
      return getJson(`/repos/${enc(owner)}/${enc(repo)}/issues/comments/${commentId}`)
    },

    async setThreadResolution(
      threadId: string,
      resolved: boolean,
    ): Promise<GhReviewThreadNode> {
      const mutation = resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION
      const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread'
      const data = await postGraphql<
        Record<string, { thread: GhReviewThreadNode | null } | null>
      >(mutation, { threadId })
      const thread = data[field]?.thread
      if (thread === undefined || thread === null) {
        throw new GithubGraphqlError(
          `${field} returned no thread for ${threadId}`,
        )
      }
      return thread
    },
  }
}
