import type {
  FileBlob,
  FileViewedState,
  HttpErrorBody,
  HumanPreferences,
  PullListResponse,
  RateLimitInfo,
  ReactionKey,
  ReactionRollup,
  ReconcileReport,
  ReviewComment,
  ReviewDraft,
  ReviewThread,
  RevuApi,
  Session,
  Snapshot,
  SubmitResult,
  SubmitReviewInput,
} from '@revu/shared'
import {
  ApiError,
  ROUTES,
  apiErrorFromHttp,
  fillPath,
  validateDraftResponse,
  validateFileBlob,
  validateFileViewedState,
  validateHttpErrorBody,
  validateHumanPreferences,
  validatePullListResponse,
  validateRateLimitInfo,
  validateReactionRollup,
  validateReconcileReport,
  validateReviewComment,
  validateReviewDraft,
  validateReviewThread,
  validateReviewThreads,
  validateSession,
  validateSnapshotResponse,
  validateSubmitResult,
} from '@revu/shared'
import type { RouteName } from '@revu/shared'

/**
 * The HTTP transport: every `RevuApi` method dispatches through the shared
 * `ROUTES` table and talks to `revud` over `fetch`. The daemon serves the SAME
 * mock semantics behind HTTP, so this adapter is a faithful shell — the app's
 * state layer (optimistic writes, rollback, reconcile routing) behaves exactly
 * as it does against the in-browser mock.
 *
 * Two client-side codes are synthesized here because they never ride the wire:
 * a rejected/aborted `fetch` (no HTTP response arrived) surfaces as
 * `ApiError('network')`, and an error status whose body is not a valid error
 * envelope (e.g. a reverse proxy's HTML) surfaces as `ApiError('broker_unreachable')`.
 * A well-formed `{ code, message, resetAt? }` body is turned back into its typed
 * `ApiError` via `apiErrorFromHttp`, so the app's existing per-code error copy
 * keeps working (`resetAt` carried through for `rate_limited`).
 *
 * `listPulls` is the sole conditional surface: it sends `If-None-Match` and, on
 * a `304` (no body), reconstructs the `PullListResponse` from adapter-closure
 * cache per the shared 304 rule. Dev builds additionally validate every response
 * so a drifting server is caught early; production trusts the server, and the
 * validation branch is tree-shaken out under a top-level `import.meta.env.DEV`.
 */

/** How a request body/headers/signal reach `fetch`; all fields optional. */
interface RequestOptions {
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  query?: string
}

export function createHttpApi(baseUrl: string): RevuApi {
  // Trim a trailing slash so `base + '/api/...'` never doubles up.
  const root = baseUrl.replace(/\/+$/, '')

  // Last successful list response, for the 304 reconstruction. A 304 carries no
  // body, so items and rateLimit are replayed from here.
  let cachedList: PullListResponse | null = null

  /**
   * Issue one request against a named route. Builds the URL from the shared
   * route table, sends a JSON body when given, and normalizes every failure to
   * an `ApiError`. Returns the raw `Response` so conditional callers
   * (`listPulls`) can inspect status and headers; other callers use `send`.
   */
  async function request(
    name: RouteName,
    params: Record<string, string | number>,
    opts: RequestOptions = {},
  ): Promise<Response> {
    const route = ROUTES[name]
    const url = root + fillPath(route.path, params) + (opts.query ?? '')
    const headers: Record<string, string> = { ...opts.headers }
    let body: string | undefined
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body)
      headers['content-type'] = 'application/json; charset=utf-8'
    }

    let res: Response
    try {
      res = await fetch(url, { method: route.method, headers, body, signal: opts.signal })
    } catch (err) {
      // No HTTP response arrived: a dropped connection or an aborted request.
      // Both surface as the client-side-only `network` code, matching the mock,
      // which throws on abort and on a simulated network drop — never swallowed.
      throw new ApiError(
        'network',
        err instanceof Error ? err.message : 'The request could not reach the daemon.',
      )
    }

    if (res.status >= 400) {
      throw await errorFromResponse(res)
    }
    return res
  }

  /** `request`, then parse the JSON body (tolerating an empty body). */
  async function send(
    name: RouteName,
    params: Record<string, string | number>,
    opts: RequestOptions = {},
  ): Promise<unknown> {
    const res = await request(name, params, opts)
    const text = await res.text()
    return text.length === 0 ? undefined : (JSON.parse(text) as unknown)
  }

  /**
   * Turn a `>=400` response into the typed error the UI catches. A valid
   * `{ code, message, resetAt? }` envelope maps via `apiErrorFromHttp`; anything
   * that is not a valid envelope (proxy HTML, a truncated body) is not trustable
   * as a contract error, so it degrades to `broker_unreachable`.
   */
  async function errorFromResponse(res: Response): Promise<ApiError> {
    let raw: unknown
    try {
      const text = await res.text()
      raw = text.length === 0 ? undefined : (JSON.parse(text) as unknown)
    } catch {
      return new ApiError(
        'broker_unreachable',
        `The daemon returned an unreadable ${res.status} response.`,
      )
    }
    let envelope: HttpErrorBody
    try {
      envelope = validateHttpErrorBody(raw)
    } catch {
      return new ApiError(
        'broker_unreachable',
        `The daemon returned a ${res.status} response that was not a recognized error.`,
      )
    }
    return apiErrorFromHttp(res.status, envelope)
  }

  const dev = import.meta.env.DEV

  const api: RevuApi = {
    async getSession(): Promise<Session> {
      const body = await send('getSession', {})
      return dev ? validateSession(body) : (body as Session)
    },

    async listPulls(opts?: { etag?: string }): Promise<PullListResponse> {
      const headers = opts?.etag !== undefined ? { 'if-none-match': opts.etag } : undefined
      const res = await request('listPulls', {}, { headers })

      if (res.status === 304) {
        // No body on a 304. Reconstruct the response the app expects from the
        // last-known list: cached items and rateLimit replayed, the ETag echoed
        // (prefer the response header, fall back to what we sent), notModified
        // flagged. A 304 before any 200 is a server contract violation.
        await res.body?.cancel()
        const etag = res.headers.get('etag') ?? opts?.etag ?? cachedList?.etag ?? ''
        const rate = rateLimitFromHeaders(res.headers) ?? cachedList?.rateLimit
        if (!cachedList || !rate) {
          throw new ApiError(
            'broker_unreachable',
            'The daemon replied 304 Not Modified before any full list was fetched.',
          )
        }
        return {
          items: cachedList.items,
          etag,
          notModified: true,
          rateLimit: rate,
        }
      }

      const text = await res.text()
      const parsed = JSON.parse(text) as unknown
      const list = dev ? validatePullListResponse(parsed) : (parsed as PullListResponse)
      cachedList = list
      return list
    },

    async syncPull(prNumber: number, opts?: { signal?: AbortSignal }): Promise<Snapshot> {
      const body = await send('syncPull', { n: prNumber }, { signal: opts?.signal })
      // A partial snapshot is a 200 value, never an error — returned as-is.
      return dev ? validateSnapshotResponse(body) as Snapshot : (body as Snapshot)
    },

    async getSnapshot(prNumber: number): Promise<Snapshot | null> {
      // A never-synced PR is a 200 `null` body, never a 404-as-error.
      const body = await send('getSnapshot', { n: prNumber })
      return dev ? validateSnapshotResponse(body ?? null) : (body as Snapshot | null)
    },

    async getBlob(sha: string): Promise<FileBlob> {
      const body = await send('getBlob', { sha })
      return dev ? validateFileBlob(body) : (body as FileBlob)
    },

    async listReviewThreads(prNumber: number): Promise<ReviewThread[]> {
      const body = await send('listReviewThreads', { n: prNumber })
      return dev ? validateReviewThreads(body) : (body as ReviewThread[])
    },

    async replyToThread(
      prNumber: number,
      threadId: string,
      body: string,
    ): Promise<ReviewComment> {
      const res = await send('replyToThread', { n: prNumber, threadId }, { body: { body } })
      return dev ? validateReviewComment(res) : (res as ReviewComment)
    },

    async resolveThread(
      prNumber: number,
      threadId: string,
      resolved: boolean,
    ): Promise<ReviewThread> {
      const res = await send('resolveThread', { n: prNumber, threadId }, { body: { resolved } })
      return dev ? validateReviewThread(res) : (res as ReviewThread)
    },

    async addReaction(
      prNumber: number,
      commentId: number,
      reaction: ReactionKey,
    ): Promise<ReactionRollup> {
      // The route path carries only the comment id; the owning PR rides as a
      // `?pr=` query param so the daemon can locate the comment.
      const res = await send(
        'addReaction',
        { id: commentId },
        { body: { reaction }, query: `?pr=${prNumber}` },
      )
      return dev ? validateReactionRollup(res) : (res as ReactionRollup)
    },

    async submitReview(input: SubmitReviewInput): Promise<SubmitResult> {
      // `head_moved` / `forbidden` come back as 200 values, never errors.
      const res = await send('submitReview', { n: input.prNumber }, { body: input })
      return dev ? validateSubmitResult(res) : (res as SubmitResult)
    },

    async reconcileDraft(prNumber: number): Promise<ReconcileReport> {
      const body = await send('reconcileDraft', { n: prNumber })
      return dev ? validateReconcileReport(body) : (body as ReconcileReport)
    },

    async getDraft(prNumber: number): Promise<ReviewDraft | null> {
      const body = await send('getDraft', { n: prNumber })
      return dev ? validateDraftResponse(body ?? null) : (body as ReviewDraft | null)
    },

    async saveDraft(draft: ReviewDraft): Promise<ReviewDraft> {
      const body = await send('saveDraft', { n: draft.prNumber }, { body: draft })
      return dev ? validateReviewDraft(body) : (body as ReviewDraft)
    },

    async discardDraft(prNumber: number): Promise<void> {
      // The daemon answers with `{ ok: true }`; the return value is discarded.
      await send('discardDraft', { n: prNumber })
    },

    async getFileViewed(prNumber: number): Promise<FileViewedState> {
      const body = await send('getFileViewed', { n: prNumber })
      return dev ? validateFileViewedState(body) : (body as FileViewedState)
    },

    async setFileViewed(
      prNumber: number,
      path: string,
      viewed: boolean,
      blobSha: string | null,
    ): Promise<FileViewedState> {
      const res = await send(
        'setFileViewed',
        { n: prNumber },
        { body: { path, viewed, blobSha } },
      )
      return dev ? validateFileViewedState(res) : (res as FileViewedState)
    },

    async getPreferences(): Promise<HumanPreferences> {
      const body = await send('getPreferences', {})
      return dev ? validateHumanPreferences(body) : (body as HumanPreferences)
    },

    async setPreferences(patch: Partial<HumanPreferences>): Promise<HumanPreferences> {
      const res = await send('setPreferences', {}, { body: patch })
      return dev ? validateHumanPreferences(res) : (res as HumanPreferences)
    },

    async getRateLimit(): Promise<RateLimitInfo> {
      const body = await send('getRateLimit', {})
      return dev ? validateRateLimitInfo(body) : (body as RateLimitInfo)
    },
  }
  return api
}

/**
 * Read a `RateLimitInfo` from response headers if the daemon carries them on a
 * `304`. `revud` today emits only the `ETag` on its 304, so this returns `null`
 * and the caller replays the cached rateLimit — matching the shared 304 rule
 * ("from response headers if present, else last-known").
 */
function rateLimitFromHeaders(headers: Headers): RateLimitInfo | null {
  const limit = headers.get('x-ratelimit-limit')
  const remaining = headers.get('x-ratelimit-remaining')
  const used = headers.get('x-ratelimit-used')
  const reset = headers.get('x-ratelimit-reset')
  if (limit === null || remaining === null || used === null || reset === null) {
    return null
  }
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    used: Number(used),
    reset,
  }
}
