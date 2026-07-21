import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, normalize, relative, isAbsolute } from 'node:path'
import type { Server } from 'bun'
import type { Session } from '@revu/shared'
import type { MockBundle } from './mock-bridge'
import type { RevuMode } from './api-router'
import type { DirectApi } from './direct/direct-api'
import { handleApi } from './api-router'
import { handleDirectApi } from './direct-router'
import { handleImageProxy } from './image-proxy'

/**
 * The single-port HTTP server. One Bun process serves the built frontend as
 * static files AND the `/api/*` contract, so there is no CORS and one URL opens
 * everything.
 *
 * Routing:
 *   - `/api/*` → the reused mock adapter via the API router.
 *   - `/image-proxy` → the server-side image fetch for remote images in
 *     comment bodies (its own module; it never touches session or credential
 *     state).
 *   - an existing file under `dist/` → that file (content type from `Bun.file`).
 *   - any other non-file path → `dist/index.html`, so client-side routing works
 *     (SPA fallback).
 */

export interface ServeOptions {
  port: number
  distDir: string
  /**
   * The reused mock bundle. Present for mock (and the eventual broker) mode,
   * which serve the `RevuApi` from the mock store. Absent in direct mode, which
   * serves the real session and a `not_implemented` placeholder for the rest.
   */
  mock?: MockBundle
  /**
   * The session built at startup in direct mode (git-config identity + the
   * authenticated GitHub viewer). Present only in direct mode; the direct router
   * returns it from `GET /api/session` and never re-derives it per request.
   */
  directSession?: Session
  /**
   * The direct-mode read/persist surface (sync engine + durable store). Present
   * only in direct mode; the direct router dispatches sync/snapshot/draft/viewed/
   * preferences routes to it.
   */
  directApi?: DirectApi
  /**
   * The transport mode the daemon was booted with. Threaded explicitly into
   * the router (never read from the environment per-request) so the mock-only
   * dev routes are provably unreachable in any other mode.
   */
  mode: RevuMode
  /**
   * The interface to bind. Omitted for mock/direct, where the default binds all
   * interfaces (a developer reaches the daemon from the host). Broker mode sets
   * `'127.0.0.1'` so the daemon is reachable only over loopback inside its
   * disposable workspace and the host reaches it exclusively through a forwarded
   * port — the injected credential never rides an interface anyone else can dial.
   */
  hostname?: string
}

/**
 * Resolve a URL pathname to a safe absolute path inside `distDir`, or null when
 * the path escapes `distDir`.
 *
 * Containment is checked via `relative(distDir, abs)`: a path that resolves
 * outside starts with `..` (or is absolute on Windows across drives), so it is
 * rejected. A plain `startsWith(distDir)` prefix test is avoided because a
 * sibling directory such as `${distDir}-evil` shares the prefix and would pass.
 */
export function resolveStaticPath(distDir: string, pathname: string): string | null {
  const abs = join(distDir, normalize(decodeURIComponent(pathname)))
  const rel = relative(distDir, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

/**
 * Build the app's Content-Security-Policy from the built `index.html`.
 *
 * The CSP is load-bearing, not hygiene: comment bodies deliberately render raw
 * HTML and diagrams, so the policy is the backstop when a sanitizer bug lets
 * markup through. `script-src` is `'self'` plus a hash per inline script found
 * in the actual served `index.html` (the no-flash theme snippet), computed from
 * the file so the policy can never drift from the markup. Remote images ride
 * `/image-proxy`, which is what makes `img-src 'self'` honest. `style-src`
 * carries `'unsafe-inline'` because React style attributes (diff tints, the
 * command palette) and mermaid's embedded stylesheet require it — a style
 * injection cannot reach the network here, since every fetching directive is
 * pinned to `'self'` or `'none'`. `frame-src 'self'` exists for the sandboxed
 * `srcdoc` diagram frames; `object-src`/`base-uri`/`form-action 'none'` close
 * the plugin, `<base>`-pivot, and form-exfiltration routes outright, and
 * `frame-ancestors 'none'` refuses embedding of the app itself.
 */
export function buildContentSecurityPolicy(indexHtml: string): string {
  const hashes: string[] = []
  const inlineScript = /<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi
  for (const match of indexHtml.matchAll(inlineScript)) {
    const body = match[1] ?? ''
    if (body.trim() === '') continue
    hashes.push(`'sha256-${createHash('sha256').update(body).digest('base64')}'`)
  }
  return [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/**
 * Stamp the security headers every response carries; `csp` is added only for
 * HTML (the policy governs documents — putting it on JSON and assets is inert
 * noise). `nosniff` keeps a response from being reinterpreted as a scriptable
 * type, and the referrer policy keeps PR-derived URLs out of outbound requests.
 */
export function applySecurityHeaders(res: Response, csp?: string): Response {
  res.headers.set('x-content-type-options', 'nosniff')
  res.headers.set('referrer-policy', 'no-referrer')
  if (csp !== undefined) res.headers.set('content-security-policy', csp)
  return res
}

/**
 * Serve a static asset from `distDir`, falling back to `index.html` for any
 * unknown non-file path (SPA routing). Shared by every mode's handler so static
 * serving behaves identically regardless of how `/api/*` is answered. Only
 * GET/HEAD reach here; any other method on a non-API path is a 405. HTML
 * responses carry the CSP from `csp()` (computed lazily from the served
 * `index.html`, once).
 */
async function serveStatic(
  distDir: string,
  indexPath: string,
  req: Request,
  csp: () => Promise<string>,
): Promise<Response> {
  const url = new URL(req.url)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const staticPath = resolveStaticPath(distDir, url.pathname)
  if (staticPath && staticPath !== distDir) {
    const file = Bun.file(staticPath)
    if (await file.exists()) {
      const res = new Response(file)
      return staticPath.endsWith('.html')
        ? applySecurityHeaders(res, await csp())
        : applySecurityHeaders(res)
    }
  }

  // SPA fallback: unknown, non-file, non-API path → index.html.
  return applySecurityHeaders(new Response(Bun.file(indexPath)), await csp())
}

/**
 * Lazily compute (and cache) the CSP for the served `index.html`. Read at
 * first use rather than handler construction so a handler built against a
 * not-yet-written dist directory still constructs; a missing or unreadable
 * index yields a hashless policy, which fails closed (the inline script would
 * be refused, never allowed too broadly).
 */
function cspProvider(indexPath: string): () => Promise<string> {
  let cached: string | null = null
  return async () => {
    if (cached === null) {
      let indexHtml = ''
      try {
        indexHtml = await Bun.file(indexPath).text()
      } catch {
        // Fall through to the hashless policy.
      }
      cached = buildContentSecurityPolicy(indexHtml)
    }
    return cached
  }
}

/**
 * Build the request handler. Serves `/api/*` from the mock, otherwise static
 * files from `distDir` with an `index.html` SPA fallback. `mode` is forwarded
 * to the API router, which uses it to keep the dev-panel routes mock-only.
 */
export function createFetchHandler(
  distDir: string,
  mock: MockBundle,
  mode: RevuMode,
): (req: Request) => Promise<Response> {
  const indexPath = join(distDir, 'index.html')
  const csp = cspProvider(indexPath)

  return async function fetch(req: Request): Promise<Response> {
    const apiResponse = await handleApi(req, mock, mode)
    if (apiResponse) return applySecurityHeaders(apiResponse)
    const proxyResponse = await handleImageProxy(req)
    if (proxyResponse) return proxyResponse
    return serveStatic(distDir, indexPath, req, csp)
  }
}

/**
 * Build the direct/broker request handler. Serves `/api/*` from the shared direct
 * router (the real session for `getSession`, a `not_implemented` placeholder for
 * the not-yet-built routes) and static files otherwise. The session is fixed for
 * the daemon's lifetime; no request can change it. There is no mock and no dev
 * panel here. `mode` is forwarded to the router so a broker session without a
 * configured bot identity gates the four write endpoints to `not_implemented`,
 * while direct mode (and a bot-identified broker) serves them.
 */
export function createDirectFetchHandler(
  distDir: string,
  session: Session,
  api: DirectApi,
  mode: RevuMode = 'direct',
): (req: Request) => Promise<Response> {
  const indexPath = join(distDir, 'index.html')
  const csp = cspProvider(indexPath)

  return async function fetch(req: Request): Promise<Response> {
    const apiResponse = await handleDirectApi(req, session, api, mode)
    if (apiResponse) return applySecurityHeaders(apiResponse)
    const proxyResponse = await handleImageProxy(req)
    if (proxyResponse) return proxyResponse
    return serveStatic(distDir, indexPath, req, csp)
  }
}

/**
 * Start the daemon. Asserts `dist/` exists (a clear build-first error
 * otherwise), then serves on `port` in the given transport mode. Direct mode
 * serves the real session; every other mode serves the reused mock. Returns the
 * Bun `Server`.
 */
/**
 * Bind the IPv6 loopback in addition to the IPv4 one, on the same port.
 *
 * Binding `127.0.0.1` alone is not enough in practice. Inside a container
 * `localhost` frequently resolves to `::1` first, so a caller that dials the
 * name — an editor's port forwarder, most notably — reaches an address nothing
 * is listening on and reports the port closed. `curl` hides this by retrying
 * over IPv4; a forwarder generally does not.
 *
 * `::1` is still loopback, so this changes nothing about exposure: the daemon
 * remains unreachable from any other container on the shared bridge, which is
 * the property that matters. Binding `::` would break that and is not this.
 *
 * Best-effort by design. A container with IPv6 disabled cannot bind `::1` at
 * all, and failing to serve at all there would be far worse than serving on one
 * family — so the error is swallowed and the IPv4 listener stands alone.
 */
export function startLoopbackAlias(opts: ServeOptions): Server | null {
  try {
    return startServer({ ...opts, hostname: '::1' })
  } catch {
    return null
  }
}

export function startServer(opts: ServeOptions): Server {
  if (!existsSync(opts.distDir) || !existsSync(join(opts.distDir, 'index.html'))) {
    throw new Error(
      `revud: built frontend not found at ${opts.distDir}. ` +
        `Build the app first (e.g. \`bun run build:app\`) before starting revud.`,
    )
  }

  let fetch: (req: Request) => Promise<Response>
  if (opts.mode === 'direct' || opts.mode === 'broker') {
    // Broker mode runs the SAME engine as direct — the only difference is upstream
    // (the injected credential source and the loopback bind), so the request
    // surface, session, and read/persist API are assembled identically and served
    // by the same handler. The one broker-only per-request behavior (an absent
    // credential mapping to `broker_unreachable`) lives in the shared router.
    if (opts.directSession === undefined) {
      throw new Error(`revud: ${opts.mode} mode requires a resolved session.`)
    }
    if (opts.directApi === undefined) {
      throw new Error(`revud: ${opts.mode} mode requires a resolved read/persist surface.`)
    }
    fetch = createDirectFetchHandler(opts.distDir, opts.directSession, opts.directApi, opts.mode)
  } else {
    if (opts.mock === undefined) {
      throw new Error(`revud: ${opts.mode} mode requires the mock bundle.`)
    }
    fetch = createFetchHandler(opts.distDir, opts.mock, opts.mode)
  }
  return Bun.serve({
    port: opts.port,
    fetch,
    ...(opts.hostname !== undefined ? { hostname: opts.hostname } : {}),
  })
}
