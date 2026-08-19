import type {
  CreateLocalReviewInput,
  ReactionKey,
  Session,
  SubmitReviewInput,
} from '@revu/shared'
import {
  ApiError,
  errorBodyFromApiError,
  isValidRefName,
  normalizeRefName,
  ROUTES,
  statusForApiError,
  ValidationError,
  validateCreateLocalReviewInput,
  validateReactionBody,
  validateReplyBody,
  validateResolveBody,
  validateReviewDraft,
  validateSetPreferencesBody,
  validateSetViewedBody,
  validateSubmitReviewInput,
} from '@revu/shared'
import type { RevuMode } from './api-router'
import { PollUnavailableError } from './broker/poll-loop'
import { AwaitingCredentialError } from './broker/token-source'
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
 * `addReaction`) is served here in direct mode, and in broker mode ONLY when
 * the api carries the broker write capability (`api.brokerWritesEnabled` —
 * conferred solely by the stamping + journaling write decorator, which boot
 * injects exactly when the bot self-identity is configured); a broker api
 * without it is reads-only and gates all four to `not_implemented` (501)
 * before any write runs. Contract semantics enforced on the served write path:
 *   - `submitReview` returns `head_moved`/`forbidden` as a 200-level VALUE, never
 *     an error status — it is an ordinary JSON body.
 *   - A submit that hits a 422 (a comment failed validation despite the guard)
 *     surfaces as `conflict` (409); the store draft is retained by the surface,
 *     never discarded on failure.
 *   - `addReaction`'s route carries only the comment id, so the owning PR rides
 *     as a `?pr=<n>` query param (or a `prNumber` body field), mirroring the mock
 *     router; it is shared-and-honest (one GitHub user, one reaction).
 *
 * Three of the four local-review routes are served here — `GET /api/branches`,
 * `POST /api/local-reviews` and `GET /api/local-reviews` — against the local
 * surface the api was assembled with, and a typed `not_found` (404) when it was
 * assembled without one. `DELETE /api/local-reviews/:n` is deliberately NOT
 * served and keeps its honest `not_implemented` (501): deleting a local review
 * means deciding what becomes of its snapshot, its cached blobs, and every
 * human's draft and viewed marks on it, which is a retention policy rather than
 * a row delete.
 *
 * Both refs of a creation request are validated and fully qualified HERE, before
 * the request reaches anything that can run git. The shared body validator
 * checks shape only — two strings — and a string is not yet a ref name: a value
 * beginning with `-` is read by git as an option, and `git check-ref-format` is
 * no defense against it (it exits 0 on `refs/heads/--upload-pack=x`). The
 * rejection is what makes the value safe, and it happens before the value is
 * passed on at all.
 *
 * `GET /api/pulls` is served whenever the api declares the list capability
 * (`api.pullListEnabled`) — a broker poll cache, a local review surface, or both
 * merged into one conditional list. The gate is the capability rather than the
 * deployment mode, so a direct daemon that records local reviews can list them,
 * while an api carrying no list source at all keeps the honest
 * `not_implemented` (501) instead of the 404 its `listPulls` would throw.
 *
 * Routes that belong to the not-yet-built GraphQL thread read still answer a
 * typed `not_implemented` (501). Unknown API paths 404; non-API paths return
 * `null` so the caller serves static assets. There is no mock and no dev panel
 * in direct mode.
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
 * the GraphQL thread read (`listReviewThreads`) lands. The write path
 * (submitReview, replyToThread, resolveThread, addReaction), `getBlob` (a
 * content-addressed store read), the rate-limit read and `reconcileDraft` (a
 * pure read of snapshot + draft state) are all served below.
 *
 * `listReviewThreads` stays here for local reviews too, and not merely for want
 * of an implementation: local threads ride the mutable half of the snapshot, so
 * a second, separately served read of them could disagree with the snapshot the
 * client is already rendering — two sources of truth for one set of threads.
 *
 * `listPulls` is NOT here. It is served below whenever the api carries a list
 * source, and falls through to the honest 501 only when it carries none.
 */
const NOT_IMPLEMENTED_ROUTES: ReadonlySet<string> = new Set<string>([
  ROUTES.listReviewThreads.path,
])

/**
 * The four write endpoints, gated to `not_implemented` in BROKER mode whenever
 * the api lacks the broker write capability. Correct broker writes need two
 * things at once: identity-dependent behavior (the self-approval guard, submit
 * idempotency-by-self, own-comment detection) that reads a resolved bot login
 * — a GitHub App installation token cannot resolve its own login from GitHub
 * (`GET /user` answers 403), so it exists only when the deployment configures
 * `REVU_BOT_LOGIN` — AND the stamping + journaling `WriteDecorator`, without
 * which a mediated write would post unstamped as the bare shared bot and leave
 * no audit row. The gate therefore keys on `api.brokerWritesEnabled`, the
 * capability only the broker decorator confers (boot injects it exactly when
 * the bot login is configured): the api structurally cannot be write-enabled
 * without stamping + journaling, so a session-shape/assembly mismatch fails
 * CLOSED to an honest 501, exactly as `listPulls` does. A capable broker
 * serves all four through the same shared write path direct mode uses. Direct
 * mode serves all four unchanged — its writes are gated by mode, not by this
 * capability.
 */
const BROKER_GATED_WRITE_ROUTES: readonly {
  method: string
  path: string
}[] = [
  ROUTES.submitReview,
  ROUTES.replyToThread,
  ROUTES.resolveThread,
  ROUTES.addReaction,
]

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
  // No GitHub credential is present RIGHT NOW: an external host injects it into
  // the workspace asynchronously and may transiently truncate or not-yet-write it.
  // This propagates up from the GitHub client when it tries to build the Bearer
  // header. It is upstream-unavailable, not a client or server bug — surface it as
  // `broker_unreachable` (502, the same "retry shortly" semantics an unreachable
  // upstream gets) so the request fails cleanly and is retriable, never a 500 or a
  // crash. The error carries no token material by contract, so its message is safe
  // to serialize.
  if (err instanceof AwaitingCredentialError) {
    return errorJson('broker_unreachable', err.message, 502)
  }
  // The broker poll loop has no live pull list yet (never warmed, or stale past
  // its failure threshold). This is "live data unavailable", the same retriable
  // semantics an unreachable upstream gets — never a fabricated empty list.
  if (err instanceof PollUnavailableError) {
    return errorJson('broker_unreachable', err.message, 502)
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

/**
 * Validate and fully qualify the two refs of a local-review creation request.
 *
 * Runs BEFORE the request reaches the local surface, so no unvalidated string
 * can become a git argument by any path. `isValidRefName` is the load-bearing
 * screen: it rejects a leading `-` (the option-injection shape), `..`, a
 * trailing `/`, control characters and git's forbidden charset — and it is run
 * on the ref AS GIVEN, because `normalizeRefName` is purely mechanical and
 * would happily qualify a hostile name into a legal-looking one.
 *
 * Both sides are then compared in their qualified form, so the same branch
 * spelled bare and spelled in full is recognised as one side rather than two.
 * A pair naming one ref is `unprocessable` — the request is well-formed but
 * there is nothing to review between a ref and itself. A pair of two different
 * names that happen to sit on the same COMMIT is a different check entirely and
 * belongs where the commits are resolved.
 */
function qualifiedCreateInput(input: CreateLocalReviewInput): CreateLocalReviewInput {
  for (const [side, ref] of [
    ['base', input.baseRef],
    ['head', input.headRef],
  ] as const) {
    if (!isValidRefName(ref)) {
      throw new ApiError(
        'unprocessable',
        `The ${side} ref ${JSON.stringify(ref)} is not a valid git ref name.`,
      )
    }
  }
  const baseRef = normalizeRefName(input.baseRef)
  const headRef = normalizeRefName(input.headRef)
  if (baseRef === headRef) {
    throw new ApiError(
      'unprocessable',
      `Base and head name the same ref (${baseRef}) — a review needs two different sides.`,
    )
  }
  return {
    baseRef,
    headRef,
    ...(input.title !== undefined ? { title: input.title } : {}),
  }
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
  mode: RevuMode = 'direct',
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return null
  const { method } = req
  const path = url.pathname

  // getSession — the real session built at startup.
  if (method === ROUTES.getSession.method && path === ROUTES.getSession.path) {
    return json(session)
  }

  // A broker whose api lacks the broker write capability is reads-only: the
  // four write endpoints answer `not_implemented` (501) before any write
  // executes, the same honest placeholder `listPulls` uses. The capability is
  // conferred only by the stamping + journaling decorator (injected at boot
  // exactly when the bot identity is configured), so the gate opens only when
  // every served write is stamped and journaled. Direct mode falls through
  // unchanged.
  if (mode === 'broker' && !api.brokerWritesEnabled) {
    for (const route of BROKER_GATED_WRITE_ROUTES) {
      if (method === route.method && matchRoute(route.path, path)) {
        return json(
          {
            code: 'not_implemented',
            message:
              `${method} ${path} is not available: this broker has no bot identity ` +
              '(REVU_BOT_LOGIN) configured, so it is reads-only.',
          },
          501,
        )
      }
    }
  }

  try {
    // ——— listPulls: GET /api/pulls, conditional, served from whichever list
    // sources the api carries — the broker poll cache, the local reviews, or
    // both merged. Honors CONDITIONAL_LIST_304_RULE: the client sends
    // If-None-Match, the server emits an ETag on the 200 and replies a bodiless
    // 304 when the ETag matches.
    //
    // Gated on the api's CAPABILITY, never on the deployment mode. Keyed on mode,
    // a direct daemon that does serve local reviews could not list them; keyed on
    // nothing, an api with no list source at all would be handed the request and
    // answer the typed `not_found` its `listPulls` throws — a 404 claiming the
    // resource does not exist, where the honest answer is that this daemon does
    // not serve one. The flag keeps the 501 below for exactly that case. ———
    if (
      api.pullListEnabled &&
      method === ROUTES.listPulls.method &&
      path === ROUTES.listPulls.path
    ) {
      const ifNoneMatch = req.headers.get('if-none-match')
      const result = api.listPulls(ifNoneMatch)
      if (result.notModified) {
        // A 304 carries NO body; the ETag is echoed so the client can keep
        // conditioning on it. The client replays its last-known items.
        return new Response(null, { status: 304, headers: { etag: result.etag } })
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          etag: result.etag,
        },
      })
    }

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

    // ——— getRateLimit: the shared allowance, read live from GitHub. ———
    // Not accumulated here and not summed across workspaces: the bucket belongs
    // to the credential, and every workspace under one installation spends from
    // the same one, so GitHub is already the shared counter.
    if (method === ROUTES.getRateLimit.method && matchRoute(ROUTES.getRateLimit.path, path)) {
      return json(await api.getRateLimit())
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

    // ——— reconcileDraft: GET /api/pulls/:n/reconcile ———
    // A pure read of snapshot + draft state — no writes, the draft is untouched.
    // A missing draft or a never-synced PR surfaces as a typed not_found (404)
    // via the thrown ApiError, matching the mock oracle.
    if (method === ROUTES.reconcileDraft.method) {
      const params = matchRoute(ROUTES.reconcileDraft.path, path)
      if (params) {
        const n = prNumberOf(params)
        if (n === null) return errorJson('not_found', `Bad pull number "${params.n}".`, 404)
        return json(api.reconcileDraft(n))
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

    // ——— listBranches: GET /api/branches ———
    // A git read of the repository this daemon serves, never a store read: no
    // table holds anything about branches, and the listing must offer refs no
    // recorded review has ever named — a remote-tracking base that was never
    // checked out is the ordinary case.
    if (method === ROUTES.listBranches.method && path === ROUTES.listBranches.path) {
      return json(await api.listBranches())
    }

    // ——— listLocalReviews: GET /api/local-reviews ———
    // The only wire path for the two local-only annotations, `dirty` and
    // `archivedPr`; they ride the summary and no other route carries them.
    if (method === ROUTES.listLocalReviews.method && path === ROUTES.listLocalReviews.path) {
      return json(api.listLocalReviews())
    }

    // ——— createLocalReview: POST /api/local-reviews ———
    // Shape first (two strings), then ref validation and qualification, and only
    // then the surface — so a hostile ref is refused before anything downstream
    // could turn it into a git argument. A duplicate branch pair comes back as
    // the review that already exists, at 200: creation is idempotent per pair,
    // and a retry whose first answer was lost must not mint a second review or
    // fail as a conflict.
    if (method === ROUTES.createLocalReview.method && path === ROUTES.createLocalReview.path) {
      const input = validateCreateLocalReviewInput(await readJsonBody(req))
      return json(await api.createLocalReview(qualifiedCreateInput(input)))
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
