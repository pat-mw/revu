/**
 * The HTTP surface of the `RevuApi` contract: the route table, the error
 * envelope, and the small set of non-error transport semantics that the app's
 * flows depend on. Both `revud` (the daemon that serves the contract over HTTP)
 * and the fetch adapter (which consumes it) import from here so the wire mapping
 * is defined exactly once.
 *
 * This module MIRRORS `./api/client` (the method set) and `./api/types` (the
 * error codes). When a type and a value here ever disagree, the type is the
 * source of truth — see the integration guide §0 "The shape of the thing".
 */

import type { ApiErrorCode } from './api/types'
import { ApiError } from './api/types'

// ————————————————————————————————————————————————————————————————
// Route table — one entry per RevuApi method
// ————————————————————————————————————————————————————————————————

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface Route {
  method: HttpMethod
  /**
   * Path template. Segments prefixed with `:` are parameters filled by
   * `fillPath`: `:n` (prNumber), `:sha` (blob sha), `:threadId`, `:id`
   * (commentId).
   */
  path: string
}

/**
 * Every `RevuApi` method maps to exactly one route, keyed by method name.
 * `snake`/`camel` casing follows the wire types unchanged; bodies are JSON.
 *
 * `listPulls` is the only conditional surface (see `CONDITIONAL_LIST_ROUTE`):
 * the client sends `If-None-Match`, the server answers `ETag` and may reply
 * `304 Not Modified`, which costs nothing against the shared rate bucket.
 */
export const ROUTES = {
  getSession: { method: 'GET', path: '/api/session' },
  /** Conditional: request `If-None-Match`, respond `ETag` / `304`. */
  listPulls: { method: 'GET', path: '/api/pulls' },
  syncPull: { method: 'POST', path: '/api/pulls/:n/sync' },
  getSnapshot: { method: 'GET', path: '/api/pulls/:n/snapshot' },
  getBlob: { method: 'GET', path: '/api/blobs/:sha' },
  listReviewThreads: { method: 'GET', path: '/api/pulls/:n/threads' },
  /** Body `{ body }`. */
  replyToThread: { method: 'POST', path: '/api/pulls/:n/threads/:threadId/reply' },
  /** Body `{ resolved }`. */
  resolveThread: { method: 'POST', path: '/api/pulls/:n/threads/:threadId/resolve' },
  /** Body `{ reaction }`. */
  addReaction: { method: 'POST', path: '/api/comments/:id/reactions' },
  /**
   * Body is `SubmitReviewInput`. `{ status: 'head_moved' }` comes back as an
   * HTTP 200 value, NEVER an error status — see `TRANSPORT_SEMANTICS`.
   */
  submitReview: { method: 'POST', path: '/api/pulls/:n/review' },
  reconcileDraft: { method: 'GET', path: '/api/pulls/:n/reconcile' },
  getDraft: { method: 'GET', path: '/api/pulls/:n/draft' },
  saveDraft: { method: 'PUT', path: '/api/pulls/:n/draft' },
  discardDraft: { method: 'DELETE', path: '/api/pulls/:n/draft' },
  getFileViewed: { method: 'GET', path: '/api/pulls/:n/viewed' },
  /** Body `{ path, viewed, blobSha }`. */
  setFileViewed: { method: 'PUT', path: '/api/pulls/:n/viewed' },
  getPreferences: { method: 'GET', path: '/api/preferences' },
  /** Body is a partial `HumanPreferences` patch, e.g. `{ diffMode }`. */
  setPreferences: { method: 'PUT', path: '/api/preferences' },
  getRateLimit: { method: 'GET', path: '/api/rate-limit' },
} as const satisfies Record<string, Route>

/**
 * Deliberately ABSENT from the table: the daemon's dev-panel routes —
 * `GET /api/dev`, `PUT /api/dev`, and `POST /api/dev/reset`. They are not part
 * of the `RevuApi` contract (no `RevuApi` method maps to them) and exist ONLY
 * when the daemon runs in mock mode: they select the acting human, toggle
 * simulated latency/failures, and reseed the store from fixtures, all
 * unauthenticated. In any other mode the daemon's router refuses to dispatch
 * them and the paths 404 — identity must come from the channel, never from a
 * client-settable value, and no unauthenticated route may wipe stored drafts.
 * No client adapter may build on them.
 */

/** Method names present in the route table — one per `RevuApi` method. */
export type RouteName = keyof typeof ROUTES

/**
 * The single ETag/304 surface. `listPulls` is safe to poll: a 304 is free
 * against the shared rate bucket, so it is the only genuinely live read.
 * No other route is conditional.
 */
export const CONDITIONAL_LIST_ROUTE: RouteName = 'listPulls'

/**
 * The exact rule both `revud` and the fetch adapter follow on the `listPulls`
 * conditional path, so they cannot diverge on how a `304` is realized.
 *
 * A `304 Not Modified` carries NO body. `revud` MUST emit an `ETag` on the
 * `200` list response and reply `304` when the request's `If-None-Match`
 * matches. On a `304` the client resolves a `PullListResponse` reconstructed as:
 *
 *   {
 *     items:       <its last-known items>,
 *     etag:        <the If-None-Match it sent / echoed ETag>,
 *     notModified: true,
 *     rateLimit:   <from response headers if present, else last-known>,
 *   }
 *
 * The mock has no real HTTP layer, so it returns a full body with
 * `notModified: true` directly; the HTTP transport realizes the SAME
 * `PullListResponse` via the 304 path. Either way the app sees one shape.
 */
export const CONDITIONAL_LIST_304_RULE =
  'listPulls 304 Not Modified carries no body: revud emits an ETag on the 200 response and replies 304 when If-None-Match matches; on a 304 the client resolves a PullListResponse of { items: last-known items, etag: the If-None-Match it sent / echoed ETag, notModified: true, rateLimit: from response headers if present else last-known }. The mock returns a full body with notModified: true because it has no real HTTP layer; the HTTP transport realizes the same PullListResponse via the 304 path.' as const

/**
 * Substitute `:name` segments in a path template with the given params.
 * Used by both `revud`'s router (to declare handlers) and the client adapter
 * (to build request URLs). Values are URL-encoded; an unresolved `:name`
 * segment is a programming error and throws. An empty-string value is rejected
 * the same way `undefined` is — it would silently emit an empty `//` segment.
 */
export function fillPath(
  template: string,
  params: Record<string, string | number>,
): string {
  return template
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment
      const key = segment.slice(1)
      const value = params[key]
      if (value === undefined || value === '') {
        throw new Error(`fillPath: missing param ":${key}" for template "${template}"`)
      }
      return encodeURIComponent(String(value))
    })
    .join('/')
}

// ————————————————————————————————————————————————————————————————
// Error envelope + status mapping
// ————————————————————————————————————————————————————————————————

/**
 * The JSON body of every error response. `resetAt` is carried only for
 * `rate_limited` (the ISO timestamp when the shared bucket resets), mirroring
 * `ApiError.resetAt`. The app's error copy switches on `code` directly.
 */
export interface HttpErrorBody {
  code: ApiErrorCode
  message: string
  resetAt?: string
}

/**
 * Status code per error code. `network` is deliberately absent: it is a
 * CLIENT-SIDE-ONLY code, synthesized by the adapter when `fetch` itself
 * rejects (no HTTP response arrived). It NEVER appears on the wire and has no
 * status.
 */
export const HTTP_STATUS_BY_CODE: Record<Exclude<ApiErrorCode, 'network'>, number> = {
  rate_limited: 429,
  broker_unreachable: 502,
  conflict: 409,
  not_found: 404,
  forbidden: 403,
}

/** Serialize an `ApiError` into its wire body. Used by `revud`. */
export function errorBodyFromApiError(err: ApiError): HttpErrorBody {
  const body: HttpErrorBody = { code: err.code, message: err.message }
  if (err.resetAt !== undefined) body.resetAt = err.resetAt
  return body
}

/**
 * The HTTP status for an `ApiError`. Throws if the code is `network`, because a
 * `network` error is synthesized client-side and must never be serialized onto
 * the wire.
 */
export function statusForApiError(err: ApiError): number {
  if (err.code === 'network') {
    throw new Error(
      'ApiError code "network" is client-side only and cannot be serialized to an HTTP status',
    )
  }
  return HTTP_STATUS_BY_CODE[err.code]
}

/**
 * Reconstruct an `ApiError` from an HTTP error response. Used by the adapter to
 * turn a `{ code, message, resetAt? }` body back into the typed error the UI
 * catches. `resetAt` is carried through for `rate_limited`.
 */
export function apiErrorFromHttp(status: number, body: HttpErrorBody): ApiError {
  void status
  return new ApiError(body.code, body.message, body.resetAt)
}

// ————————————————————————————————————————————————————————————————
// The three non-error transport semantics
// ————————————————————————————————————————————————————————————————

/**
 * Three responses look like failures but are NOT errors. Every implementation
 * of this contract — mock, `revud`, and any real adapter — must preserve them
 * verbatim, and the client must never treat them as error statuses:
 *
 * 1. `submitReview` returns `{ status: 'head_moved', currentHeadSha, newCommits }`
 *    as an HTTP 200 value, NEVER an error status. The review bar routes into
 *    reconcile on it instead of failing.
 *
 * 2. `syncPull` may resolve with `Snapshot.partial` non-null — a sync that died
 *    partway names what is missing. That is an HTTP 200 body, not an error.
 *
 * 3. `getSnapshot` returns HTTP 200 with a JSON `null` body for a never-synced
 *    PR. NEVER 404-as-error.
 */
export const TRANSPORT_SEMANTICS = {
  submitReviewHeadMovedIs200:
    "submitReview returns { status: 'head_moved', ... } as an HTTP 200 value, never an error status — the review bar routes into reconcile on it.",
  syncPullPartialIs200:
    'syncPull may resolve with Snapshot.partial non-null (a sync that died partway) — HTTP 200, not an error.',
  getSnapshotNullIs200:
    'getSnapshot returns HTTP 200 with a JSON null body for a never-synced PR — never 404-as-error.',
} as const
