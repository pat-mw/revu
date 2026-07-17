import type { ReactionKey, SubmitReviewInput } from '@revu/shared'
import {
  ApiError,
  ROUTES,
  ValidationError,
  errorBodyFromApiError,
  statusForApiError,
  validateReactionBody,
  validateReplyBody,
  validateResolveBody,
  validateReviewDraft,
  validateSetViewedBody,
  validateSubmitReviewInput,
} from '@revu/shared'
import type { DevStateShape, MockBundle } from './mock-bridge'

/**
 * The `/api/*` router: dispatches each route in the shared `ROUTES` table to the
 * matching reused mock adapter method and serializes the result to the wire.
 *
 * The contract's three non-error transport semantics are honored by NOT special-
 * casing them: they are ordinary 200 JSON values.
 *   - `getSnapshot` on a never-synced PR returns HTTP 200 with a `null` body.
 *   - `syncPull` returns HTTP 200 even when `Snapshot.partial` is non-null.
 *   - `submitReview` returns HTTP 200 with `{ status: 'head_moved' }` (or
 *     `forbidden`) as a value, never an error status.
 * An adapter that THROWS an `ApiError` is mapped to `statusForApiError` /
 * `errorBodyFromApiError`; anything else is a 500.
 *
 * `listPulls` is the sole conditional surface: it emits an `ETag` and answers
 * `304 Not Modified` with no body when the request's `If-None-Match` matches.
 *
 * After every MUTATING handler the reused store is flushed to disk before the
 * response is sent, so a restart between the mutation and the debounced write
 * loses nothing.
 */

/** JSON response with the app-expected content type. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value ?? null), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Serialize a thrown error to its wire envelope.
 *
 * `network` is a special case: it is a CLIENT-SIDE-ONLY code with no HTTP status
 * (`statusForApiError` throws for it), so it is never contractually on the wire.
 * The mock reuses it in-process to model a dropped connection — thrown for a
 * failed sync AND for a failed write, not only mid-sync (any mutation made
 * before the throw is already persisted). The in-process daemon has no real
 * socket to drop, so it surfaces the mock's `network` throw as an ENVELOPED 5xx
 * carrying the `network` code/message. The eventual fetch adapter reconstructs
 * an `ApiError('network')` either from that `{ code: 'network' }` body or from a
 * genuine `fetch` reject; the durable outcome (partial/write kept, retry
 * completes) is unchanged.
 *
 * A `ValidationError` (a request body that failed shape validation) or a
 * `SyntaxError` (a body that is not valid JSON) is a CLIENT error, mapped to a
 * 400, not a 5xx. Any other non-`ApiError` throw is a genuine bug and becomes a
 * generic 500.
 */
function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    if (err.code === 'network') {
      return json(errorBodyFromApiError(err), 500)
    }
    return json(errorBodyFromApiError(err), statusForApiError(err))
  }
  if (err instanceof ValidationError || err instanceof SyntaxError) {
    return badRequest(err.message)
  }
  const message = err instanceof Error ? err.message : String(err)
  return json({ code: 'broker_unreachable', message }, 500)
}

/** Parse a `:n`-style integer path param; `null` when absent or malformed. */
function intParam(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isInteger(n) ? n : null
}

interface RouteMatch {
  name: keyof typeof ROUTES
  params: Record<string, string>
}

/**
 * Match a method + path against the shared route table. Path templates use
 * `:name` segments; matched values are decoded. Returns the route name and its
 * captured params, or `null` when nothing matches.
 */
function matchRoute(method: string, pathname: string): RouteMatch | null {
  const segments = pathname.split('/').filter((s) => s.length > 0)
  for (const [name, route] of Object.entries(ROUTES)) {
    if (route.method !== method) continue
    const template = route.path.split('/').filter((s) => s.length > 0)
    if (template.length !== segments.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < template.length; i++) {
      const t = template[i]
      const s = segments[i]
      if (t.startsWith(':')) {
        params[t.slice(1)] = decodeURIComponent(s)
      } else if (t !== s) {
        ok = false
        break
      }
    }
    if (ok) return { name: name as keyof typeof ROUTES, params }
  }
  return null
}

async function readJsonBody(req: Request): Promise<unknown> {
  const text = await req.text()
  if (text.length === 0) return undefined
  return JSON.parse(text) as unknown
}

/** A 400 for a malformed request (bad param or invalid JSON body). */
function badRequest(message: string): Response {
  return json({ code: 'not_found', message } satisfies { code: 'not_found'; message: string }, 400)
}

/**
 * Handle one `/api/*` request. Returns `null` when the path is not an API route
 * (the caller then serves static assets). The request's `AbortSignal` is passed
 * into `syncPull` so a client that aborts the HTTP request cancels the in-flight
 * sync exactly as an in-process signal would.
 */
export async function handleApi(req: Request, mock: MockBundle): Promise<Response | null> {
  const url = new URL(req.url)
  // Treat both `/api/...` and an exact `/api` as API paths, so a bare `/api`
  // returns the JSON 404 from the no-route branch rather than the SPA fallback.
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return null

  const dev = await handleDev(req, url, mock)
  if (dev) return dev

  const match = matchRoute(req.method, url.pathname)
  if (!match) {
    return json(
      { code: 'not_found', message: `No route for ${req.method} ${url.pathname}.` },
      404,
    )
  }

  const { api, store } = mock
  const { name, params } = match
  const n = intParam(params.n)

  try {
    switch (name) {
      case 'getSession':
        return json(await api.getSession())

      case 'listPulls': {
        const ifNoneMatch = req.headers.get('if-none-match') ?? undefined
        const res = await api.listPulls(ifNoneMatch !== undefined ? { etag: ifNoneMatch } : undefined)
        if (ifNoneMatch !== undefined && ifNoneMatch === res.etag) {
          // A matching conditional request: 304 with no body, the ETag echoed.
          return new Response(null, { status: 304, headers: { etag: res.etag } })
        }
        return new Response(JSON.stringify(res), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            etag: res.etag,
          },
        })
      }

      case 'syncPull': {
        if (n === null) return badRequest('Malformed pull number.')
        // Pass the request's AbortSignal straight through: aborting the HTTP
        // request cancels the in-flight sync without corrupting store state.
        const snap = await api.syncPull(n, { signal: req.signal })
        store.flush()
        return json(snap)
      }

      case 'getSnapshot': {
        if (n === null) return badRequest('Malformed pull number.')
        // Never-synced PR resolves to null → HTTP 200 with a JSON null body.
        return json(await api.getSnapshot(n))
      }

      case 'getBlob':
        return json(await api.getBlob(params.sha))

      case 'listReviewThreads': {
        if (n === null) return badRequest('Malformed pull number.')
        return json(await api.listReviewThreads(n))
      }

      case 'replyToThread': {
        if (n === null) return badRequest('Malformed pull number.')
        const body = validateReplyBody(await readJsonBody(req))
        const comment = await api.replyToThread(n, params.threadId, body.body)
        store.flush()
        return json(comment)
      }

      case 'resolveThread': {
        if (n === null) return badRequest('Malformed pull number.')
        const body = validateResolveBody(await readJsonBody(req))
        const thread = await api.resolveThread(n, params.threadId, body.resolved)
        store.flush()
        return json(thread)
      }

      case 'addReaction': {
        const commentId = intParam(params.id)
        if (commentId === null) return badRequest('Malformed comment id.')
        // The route addresses a comment by its global id; the reused adapter
        // needs the owning PR to locate it. The client carries the PR it is
        // reacting within — accepted as a `?pr=` query param (path contract
        // unchanged) or a `prNumber` field alongside `{ reaction }`.
        const raw = (await readJsonBody(req)) as Record<string, unknown> | undefined
        const body = validateReactionBody(raw)
        const prFromQuery = intParam(url.searchParams.get('pr') ?? undefined)
        const prFromBody =
          raw && typeof raw.prNumber === 'number' ? raw.prNumber : null
        const prNumber = prFromQuery ?? prFromBody
        if (prNumber === null) {
          return badRequest('addReaction requires the owning pull number (?pr= or prNumber).')
        }
        const rollup = await api.addReaction(prNumber, commentId, body.reaction as ReactionKey)
        store.flush()
        return json(rollup)
      }

      case 'submitReview': {
        if (n === null) return badRequest('Malformed pull number.')
        const input = validateSubmitReviewInput(await readJsonBody(req)) as SubmitReviewInput
        // Act on the PR named in the path, not a mismatched body `prNumber`.
        if (input.prNumber !== n) {
          return badRequest('Path pull number does not match body prNumber.')
        }
        // head_moved / forbidden come back as 200 values, never error statuses.
        const result = await api.submitReview(input)
        store.flush()
        return json(result)
      }

      case 'reconcileDraft': {
        if (n === null) return badRequest('Malformed pull number.')
        return json(await api.reconcileDraft(n))
      }

      case 'getDraft': {
        if (n === null) return badRequest('Malformed pull number.')
        // No draft resolves to null → HTTP 200 with a JSON null body.
        return json(await api.getDraft(n))
      }

      case 'saveDraft': {
        if (n === null) return badRequest('Malformed pull number.')
        // Untrusted HTTP input enters here, and the draft flows to a keyed
        // store write (`state.drafts[draft.humanId][draft.prNumber]`). Validate
        // the full ReviewDraft shape (this also forces `prNumber` to a number,
        // closing that write-key vector) instead of trusting the raw body.
        const draft = validateReviewDraft(await readJsonBody(req))
        // Reject a prototype-polluting `humanId`: these keys would resolve
        // `state.drafts[humanId]` to `Object.prototype`, so the store's `??=`
        // never reassigns and the next write pollutes the global prototype. A
        // real `humanId` is a lowercase-email id, never one of these names.
        if (
          draft.humanId === '__proto__' ||
          draft.humanId === 'constructor' ||
          draft.humanId === 'prototype'
        ) {
          return badRequest('Invalid draft humanId.')
        }
        // Act on the PR named in the path, not a mismatched body `prNumber`.
        if (draft.prNumber !== n) {
          return badRequest('Path pull number does not match body prNumber.')
        }
        const saved = await api.saveDraft(draft)
        store.flush()
        return json(saved)
      }

      case 'discardDraft': {
        if (n === null) return badRequest('Malformed pull number.')
        await api.discardDraft(n)
        store.flush()
        return json({ ok: true })
      }

      case 'getFileViewed': {
        if (n === null) return badRequest('Malformed pull number.')
        return json(await api.getFileViewed(n))
      }

      case 'setFileViewed': {
        if (n === null) return badRequest('Malformed pull number.')
        const body = validateSetViewedBody(await readJsonBody(req))
        const state = await api.setFileViewed(n, body.path, body.viewed, body.blobSha)
        store.flush()
        return json(state)
      }

      case 'getRateLimit':
        return json(await api.getRateLimit())

      default: {
        // Exhaustiveness guard: every RouteName above is handled.
        const _never: never = name
        return json({ code: 'not_found', message: `Unhandled route ${String(_never)}.` }, 404)
      }
    }
  } catch (err) {
    // A mutation may have persisted a partial (e.g. a mid-sync drop stores
    // fetched blobs and a partial snapshot) and then thrown. The success-path
    // flush never ran, so flush here to make that partial durable before we
    // respond. `store.flush` writes current state atomically and is idempotent,
    // so flushing on a read-path error is harmless; guard it so a flush failure
    // cannot mask the original error.
    try {
      store.flush()
    } catch {
      // Ignore: surface the original error below.
    }
    return errorResponse(err)
  }
}

/**
 * The dev-panel HTTP surface, backed by the reused `mockDev` / `store`, so the
 * existing dev panel keeps working over the same one port:
 *   - `GET  /api/dev`        → current DevState + humans + rate.
 *   - `PUT  /api/dev`        → patch humanId / latency / failureMode.
 *   - `POST /api/dev/reset`  → reseed the store from fixtures.
 * Returns `null` when the path is not a dev route.
 */
async function handleDev(req: Request, url: URL, mock: MockBundle): Promise<Response | null> {
  const { dev, store } = mock

  if (url.pathname === '/api/dev/reset') {
    if (req.method !== 'POST') return methodNotAllowed()
    dev.reset()
    store.flush()
    return json({ dev: dev.get(), humans: dev.listHumans(), rate: dev.getRate() })
  }

  if (url.pathname === '/api/dev') {
    if (req.method === 'GET') {
      return json({ dev: dev.get(), humans: dev.listHumans(), rate: dev.getRate() })
    }
    if (req.method === 'PUT') {
      let patch: Partial<DevStateShape>
      try {
        patch = (await readJsonBody(req)) as Partial<DevStateShape>
      } catch {
        return badRequest('Malformed dev patch body.')
      }
      if (typeof patch.humanId === 'string') dev.setHuman(patch.humanId)
      if (typeof patch.latency === 'string') dev.setLatency(patch.latency)
      if (typeof patch.failureMode === 'string') dev.setFailureMode(patch.failureMode)
      store.flush()
      return json({ dev: dev.get(), humans: dev.listHumans(), rate: dev.getRate() })
    }
    return methodNotAllowed()
  }

  return null
}

function methodNotAllowed(): Response {
  return json({ code: 'not_found', message: 'Method not allowed.' }, 405)
}
