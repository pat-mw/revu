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
}

const DEFAULT_BASE_URL = 'https://api.github.com'

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
  }
}
