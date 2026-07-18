import type { ReactionKey, Session, SubmitReviewInput } from '@revu/shared'
import {
  ApiError,
  errorBodyFromApiError,
  ROUTES,
  statusForApiError,
  ValidationError,
  validateReactionBody,
  validateReplyBody,
  validateResolveBody,
  validateReviewDraft,
  validateSetPreferencesBody,
  validateSetViewedBody,
  validateSubmitReviewInput,
} from '@revu/shared'
import type { DirectApi } from './direct/direct-api'
import { GithubGraphqlError, GithubRequestError } from './direct/github-client'
import { StoreUnreadableError, StoreWriteError } from './direct/store'

/**
 * The `/api/*` router for direct mode. It serves the real session and the read/
 * persist surface direct mode implements today — sync, snapshot, drafts, viewed,
 * preferences — off a `DirectApi` bound to the authenticated GitHub client and
 * the durable SQLite store.
 *
 * Contract semantics enforced here:
 *   - `GET /api/pulls/:n/snapshot` returns a JSON `null` body (HTTP 200) for a
 *     never-synced PR — NEVER 404-as-error.
 *   - `POST /api/pulls/:n/sync` may resolve a `partial` snapshot; that is a 200
 *     body, not an error.
 *   - A durable write failure surfaces as `persist_failed` (HTTP 500), never a
 *     200 the client would trust as saved.
 *   - Mutation bodies are shape-validated with the shared validators before any
 *     write, and a draft PUT must name the same PR in the path and the body — a
 *     malformed or mismatched body is a 400, never a silent write elsewhere.
 *
 * `GET /api/blobs/:sha` reads the content-addressed store: a synced PR's blobs
 * were provisioned during sync (local git first, then the API), so a present SHA
 * returns its `FileBlob` (HTTP 200) and an absent one is a typed `not_found`
 * (404) — never a fabricated blob.
 *
 * The write path (`submitReview`, `replyToThread`, `resolveThread`,
 * `addReaction`) is served here. Contract semantics enforced on it:
 *   - `submitReview` returns `head_moved`/`forbidden` as a 200-level VALUE, never
 *     an error status — it is an ordinary JSON body.
 *   - A submit that hits a 422 (a comment failed validation despite the guard)
 *     surfaces as `conflict` (409); the store draft is retained by the surface,
 *     never discarded on failure.
 *   - `addReaction`'s route carries only the comment id, so the owning PR rides
 *     as a `?pr=<n>` query param (or a `prNumber` body field), mirroring the mock
 *     router; it is shared-and-honest (one GitHub user, one reaction).
 *
 * Routes that belong to the not-yet-built GraphQL thread read, reconcile, and
 * rate-limit still answer a typed `not_implemented` (501). Unknown API paths 404;
 * non-API paths return `null` so the caller serves static assets. There is no
 * mock and no dev panel in direct mode.
 *
 * The session is captured at startup and never re-derived per request: identity
 * is fixed for the daemon's life and no request can influence it.
 */

/** JSON response with the app-expected content type. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value ?? null), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** An error envelope in the contract's `{ code, message }` shape. */
function errorJson(code: string, message: string, status: number): Response {
  return json({ code, message }, status)
}

/**
 * The routes the not-yet-built parts of the surface own. They stay `501` until
 * the GraphQL thread read (`listReviewThreads`), reconcile (`reconcileDraft`),
 * and the rate-limit read (`getRateLimit`) land. The write path (submitReview,
 * replyToThread, resolveThread, addReaction) is served below. `getBlob` is served
 * — it reads the content-addressed store.
 */
const NOT_IMPLEMENTED_ROUTES: ReadonlySet<string> = new Set<string>([
  ROUTES.listPulls.path,
  ROUTES.listReviewThreads.path,
  ROUTES.reconcileDraft.path,
  ROUTES.getRateLimit.path,
])

/**
 * Match a request path against a route template, returning captured `:param`
 * values, or `null` when the template does not match. `/api/pulls/204/sync`
 * against `/api/pulls/:n/sync` yields `{ n: '204' }`.
 */
function matchRoute(
  template: string,
  pathname: string,
): Record<string, string> | null {
  const t = template.split('/').filter((s) => s.length > 0)
  const p = pathname.split('/').filter((s) => s.length > 0)
  if (t.length !== p.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith(':')) {
      params[t[i].slice(1)] = decodeURIComponent(p[i])
      continue
    }
    if (t[i] !== p[i]) return null
  }
  return params
}

/** Parse `:n` as a positive integer PR number, or `null` when malformed. */
function prNumberOf(params: Record<string, string>): number | null {
  const n = Number(params.n)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Any known contract path? Used to tell a genuinely-unknown path (404) from a
 * known-but-unimplemented one (501). Ignores `:param` segments.
 */
function isKnownApiPath(method: string, pathname: string): boolean {
  const segments = pathname.split('/').filter((s) => s.length > 0)
  for (const route of Object.values(ROUTES)) {
    if (route.method !== method) continue
    const template = route.path.split('/').filter((s) => s.length > 0)
    if (template.length !== segments.length) continue
    let ok = true
    for (let i = 0; i < template.length; i++) {
      const t = template[i]
      if (t.startsWith(':')) continue
      if (t !== segments[i]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/**
 * Translate an error thrown while serving a route into the contract's error
 * envelope. A durable write failure is `persist_failed` (500) — the mutation did
 * not reach disk, so the client must not be told it saved. A present-but-
 * unreadable store row is also `persist_failed`: the daemon's state is corrupt
 * and must not be papered over as an empty read. A GitHub HTTP error is mapped by
 * its status (404 → not_found, 403 → forbidden, 429 → rate_limited, else
 * broker_unreachable). Anything else is a generic 500.
 */
function envelopeForError(err: unknown): Response {
  if (err instanceof StoreWriteError || err instanceof StoreUnreadableError) {
    return errorJson('persist_failed', err.message, 500)
  }
  // A typed `ApiError` (e.g. `getBlob` for an absent SHA) already carries the
  // contract code and message; serialize it to its own status, never a 500.
  if (err instanceof ApiError) {
    const body = errorBodyFromApiError(err)
    return json(body, statusForApiError(err))
  }
  // A request body that failed shape validation is a CLIENT error (400), using
  // the same bad-request envelope the mock-mode router answers with.
  if (err instanceof ValidationError) {
    return errorJson('not_found', err.message, 400)
  }
  if (err instanceof GithubRequestError) {
    if (err.status === 404) return errorJson('not_found', err.message, 404)
    if (err.status === 403) return errorJson('forbidden', err.message, 403)
    if (err.status === 429) return errorJson('rate_limited', err.message, 429)
    if (err.status === 409 || err.status === 422) {
      return errorJson('conflict', err.message, 409)
    }
    return errorJson('broker_unreachable', err.message, 502)
  }
  // A GraphQL failure (a resolve/unresolve mutation) has no HTTP status of its
  // own; surface it as an upstream failure rather than a generic 500.
  if (err instanceof GithubGraphqlError) {
    return errorJson('broker_unreachable', err.message, 502)
  }
  const message = err instanceof Error ? err.message : String(err)
  return errorJson('broker_unreachable', message, 500)
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Handle one `/api/*` request in direct mode against the read/persist surface.
 * Returns `null` when the path is not an API path (the caller serves static
 * assets). The `session` answers `GET /api/session`; `api` answers the rest.
 */
export async function handleDirectApi(
  req: Request,
  session: Session,
  api: DirectApi,
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return null
  const { method } = req
  const path = url.pathname

  // getSession — the real session built at startup.
  if (method === ROUTES.getSession.method && path === ROUTES.getSession.path) {
    return json(session)
  }

  try {
    // ——— syncPull ———
    if (method === ROUTES.syncPull.method) {
      const params = matchRoute(ROUTES.syncPull.path, path)
      if (params) {
        const n = prNumberOf(params)
        if (n === null) return errorJson('not_found', `Bad pull number "${params.n}".`, 404)
        const snapshot = await api.syncPull(n)
        return json(snapshot)
      }
    }

    // ——— getSnapshot: null for never-synced (200), never 404-as-error. ———
    if (method === ROUTES.getSnapshot.method) {
      const params = matchRoute(ROUTES.getSnapshot.path, path)
      if (params) {
        const n = prNumberOf(params)
        if (n === null) return errorJson('not_found', `Bad pull number "${params.n}".`, 404)
        return json(api.getSnapshot(n))
      }
    }

    // ——— getBlob: a content-addressed store read. Present → the FileBlob (200);
    // absent → a typed not_found (404) via the thrown ApiError, never a
    // fabricated blob. ———
    if (method === ROUTES.getBlob.method) {
      const params = matchRoute(ROUTES.getBlob.path, path)
      if (params) {
        const sha = params.sha
        if (sha.length === 0) return errorJson('not_found', 'Bad blob sha.', 404)
        return json(api.getBlob(sha))
      }
    }

    // ——— drafts: GET / PUT / DELETE /api/pulls/:n/draft ———
    if (path.endsWith('/draft')) {
      const params = matchRoute(ROUTES.getDraft.path, path)
      if (params) {
        const n = prNumberOf(params)
        if (n === null) return errorJson('not_found', `Bad pull number "${params.n}".`, 404)
        if (method === 'GET') return json(api.getDraft(n))
        if (method === 'PUT') {
          const draft = validateReviewDraft(await readJsonBody(req))
          // Act on the PR named in the path, not a mismatched body `prNumber` —
          // otherwise a buggy client gets a 200 while the draft it thinks it
          // saved for this PR was written somewhere else.
          if (draft.prNumber !== n) {
            return errorJson(
              'not_found',
              'Path pull number does not match body prNumber.',
              400,
            )
          }
          return json(api.saveDraft(draft))
        }
        if (method === 'DELETE') {
          api.discardDraft(n)
          return json(null)
        }
      }
    }

    // ——— viewed: GET / PUT /api/pulls/:n/viewed ———
    if (path.endsWith('/viewed')) {
      const params = matchRoute(ROUTES.getFileViewed.path, path)
      if (params) {
        const n = prNumberOf(params)
        if (n === null) return errorJson('not_found', `Bad pull number "${params.n}".`, 404)
        if (method === 'GET') return json(api.getFileViewed(n))
        if (method === 'PUT') {
          const body = validateSetViewedBody(await readJsonBody(req))
          return json(api.setFileViewed(n, body.path, body.viewed, body.blobSha))
        }
      }
    }

    // ——— preferences: GET / PUT /api/preferences ———
    if (path === ROUTES.getPreferences.path) {
      if (method === 'GET') return json(api.getPreferences())
      if (method === 'PUT') {
        const patch = validateSetPreferencesBody(await readJsonBody(req))
        return json(api.setPreferences(patch))
      }
    }

    // ——— submitReview: POST /api/pulls/:n/review ———
    // head_moved / forbidden come back as 200 VALUES (never an error status); a
    // 422 becomes `conflict` with the store draft retained by the surface.
    if (method === ROUTES.submitReview.method) {
      const params = matchRoute(ROUTES.submitReview.path, path)
      if (params) {
        const n = prNumberOf(params)
        if (n === null) return errorJson('not_found', `Bad pull number "${params.n}".`, 404)
        const input = validateSubmitReviewInput(await readJsonBody(req)) as SubmitReviewInput
        // Act on the PR named in the path, not a mismatched body `prNumber`.
        if (input.prNumber !== n) {
          return errorJson('not_found', 'Path pull number does not match body prNumber.', 400)
        }
        return json(await api.submitReview(input))
      }
    }

    // ——— replyToThread: POST /api/pulls/:n/threads/:threadId/reply ———
    if (method === ROUTES.replyToThread.method) {
      const params = matchRoute(ROUTES.replyToThread.path, path)
      if (params) {
        const n = prNumberOf(params)
        if (n === null) return errorJson('not_found', `Bad pull number "${params.n}".`, 404)
        const body = validateReplyBody(await readJsonBody(req))
        return json(await api.replyToThread(n, params.threadId, body.body))
      }
    }

    // ——— resolveThread: POST /api/pulls/:n/threads/:threadId/resolve ———
    if (method === ROUTES.resolveThread.method) {
      const params = matchRoute(ROUTES.resolveThread.path, path)
      if (params) {
        const n = prNumberOf(params)
        if (n === null) return errorJson('not_found', `Bad pull number "${params.n}".`, 404)
        const body = validateResolveBody(await readJsonBody(req))
        return json(await api.resolveThread(n, params.threadId, body.resolved))
      }
    }

    // ——— addReaction: POST /api/comments/:id/reactions ———
    // The route carries only the comment id; the owning PR rides as `?pr=<n>` (or
    // a `prNumber` body field), the same accommodation the mock router makes.
    if (method === ROUTES.addReaction.method) {
      const params = matchRoute(ROUTES.addReaction.path, path)
      if (params) {
        const commentId = Number(params.id)
        if (!Number.isInteger(commentId) || commentId <= 0) {
          return errorJson('not_found', `Bad comment id "${params.id}".`, 400)
        }
        const raw = await readJsonBody(req)
        const body = validateReactionBody(raw)
        const prFromQuery = Number(url.searchParams.get('pr'))
        const prNumber =
          Number.isInteger(prFromQuery) && prFromQuery > 0
            ? prFromQuery
            : typeof raw.prNumber === 'number'
              ? raw.prNumber
              : null
        if (prNumber === null) {
          return errorJson(
            'not_found',
            'addReaction requires the owning pull number (?pr= or prNumber).',
            400,
          )
        }
        return json(await api.addReaction(prNumber, commentId, body.reaction as ReactionKey))
      }
    }
  } catch (err) {
    return envelopeForError(err)
  }

  // Known-but-unimplemented contract routes (pull list, GraphQL threads,
  // reconcile, rate limit) answer an honest 501.
  if (isKnownApiPath(method, path)) {
    for (const template of NOT_IMPLEMENTED_ROUTES) {
      if (matchRoute(template, path)) {
        return json(
          {
            code: 'not_implemented',
            message: `${method} ${path} is not available in direct mode yet.`,
          },
          501,
        )
      }
    }
    // A known path whose method is not the one direct mode serves (e.g. a POST to
    // a GET-only route) is also an honest 501 placeholder.
    return json(
      {
        code: 'not_implemented',
        message: `${method} ${path} is not available in direct mode yet.`,
      },
      501,
    )
  }

  return errorJson('not_found', `No route for ${method} ${path}.`, 404)
}
