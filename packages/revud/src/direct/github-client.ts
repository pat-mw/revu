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

export interface GithubClient {
  /** The authenticated viewer (`GET /user`). Throws `GithubRequestError` on a non-2xx. */
  getViewer(): Promise<GithubViewer>
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

  async function getJson(path: string): Promise<unknown> {
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
    return (await res.json()) as unknown
  }

  return {
    async getViewer(): Promise<GithubViewer> {
      const body = (await getJson('/user')) as { login?: unknown; id?: unknown }
      if (typeof body.login !== 'string' || typeof body.id !== 'number') {
        throw new GithubRequestError(200, '/user', 'response missing login/id')
      }
      return { login: body.login, id: body.id }
    },
  }
}
