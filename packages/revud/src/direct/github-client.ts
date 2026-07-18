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

  constructor(status: number, path: string, bodyExcerpt: string) {
    super(`GitHub request GET ${path} failed with HTTP ${status}: ${bodyExcerpt}`)
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

/** Parse a `Link` header for a `rel="next"` relation (GitHub pagination). */
function hasNextLink(link: string | null): boolean {
  if (!link) return false
  return /;\s*rel="next"/.test(link)
}

/**
 * Build the authenticated client. Every request sends `Authorization: Bearer
 * <token>` (token from the `TokenSource`), the pinned `X-GitHub-Api-Version`, a
 * JSON `Accept`, and a `User-Agent` (GitHub rejects requests without one). The
 * token is read fresh per call and confined to the header.
 */
export function createGithubClient(opts: GithubClientOptions): GithubClient {
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
  }
}
