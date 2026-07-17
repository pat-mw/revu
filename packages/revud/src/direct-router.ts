import type { Session } from '@revu/shared'
import { ROUTES } from '@revu/shared'

/**
 * The `/api/*` router for direct mode. Only `getSession` is implemented here:
 * it returns the real session built at startup from git config and the
 * authenticated GitHub viewer. Every other `RevuApi` route belongs to the
 * not-yet-built sync engine and write path, so it answers a typed, honest
 * `not_implemented` envelope rather than fabricating data or crashing the
 * server. Unknown paths 404, exactly as mock mode does.
 *
 * The dev-panel routes do not exist here: they are gated to mock mode by the
 * caller, so direct mode never even reaches this router for `/api/dev*`.
 *
 * The session is captured at startup and never re-derived per request: identity
 * is fixed for the life of the daemon, and no request can influence it.
 */

/** JSON response with the app-expected content type. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value ?? null), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * The set of API path templates the contract defines, used to tell a
 * genuinely-unknown path (404) from a known-but-unimplemented route (501). The
 * comparison ignores `:param` segments so `/api/pulls/204/sync` matches the
 * `/api/pulls/:n/sync` template.
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
 * Handle one `/api/*` request in direct mode. Returns `null` when the path is
 * not an API path (the caller then serves static assets).
 *
 *   - `GET /api/session` → the real session, HTTP 200.
 *   - any other route the contract defines → HTTP 501 `{ code: 'not_implemented' }`,
 *     an honest placeholder until the sync engine and write path exist.
 *   - anything else under `/api` → HTTP 404 `{ code: 'not_found' }`.
 */
export function handleDirectApi(req: Request, session: Session): Response | null {
  const url = new URL(req.url)
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return null

  if (req.method === ROUTES.getSession.method && url.pathname === ROUTES.getSession.path) {
    return json(session)
  }

  if (isKnownApiPath(req.method, url.pathname)) {
    return json(
      {
        code: 'not_implemented',
        message: `${req.method} ${url.pathname} is not available in direct mode yet.`,
      },
      501,
    )
  }

  return json(
    { code: 'not_found', message: `No route for ${req.method} ${url.pathname}.` },
    404,
  )
}
