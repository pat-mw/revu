import { existsSync } from 'node:fs'
import { join, normalize, relative, isAbsolute } from 'node:path'
import type { Server } from 'bun'
import type { Session } from '@revu/shared'
import type { MockBundle } from './mock-bridge'
import type { RevuMode } from './api-router'
import type { DirectApi } from './direct/direct-api'
import { handleApi } from './api-router'
import { handleDirectApi } from './direct-router'

/**
 * The single-port HTTP server. One Bun process serves the built frontend as
 * static files AND the `/api/*` contract, so there is no CORS and one URL opens
 * everything.
 *
 * Routing:
 *   - `/api/*` → the reused mock adapter via the API router.
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
 * Serve a static asset from `distDir`, falling back to `index.html` for any
 * unknown non-file path (SPA routing). Shared by every mode's handler so static
 * serving behaves identically regardless of how `/api/*` is answered. Only
 * GET/HEAD reach here; any other method on a non-API path is a 405.
 */
async function serveStatic(distDir: string, indexPath: string, req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const staticPath = resolveStaticPath(distDir, url.pathname)
  if (staticPath && staticPath !== distDir) {
    const file = Bun.file(staticPath)
    if (await file.exists()) {
      return new Response(file)
    }
  }

  // SPA fallback: unknown, non-file, non-API path → index.html.
  return new Response(Bun.file(indexPath))
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

  return async function fetch(req: Request): Promise<Response> {
    const apiResponse = await handleApi(req, mock, mode)
    if (apiResponse) return apiResponse
    return serveStatic(distDir, indexPath, req)
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

  return async function fetch(req: Request): Promise<Response> {
    const apiResponse = await handleDirectApi(req, session, api, mode)
    if (apiResponse) return apiResponse
    return serveStatic(distDir, indexPath, req)
  }
}

/**
 * Start the daemon. Asserts `dist/` exists (a clear build-first error
 * otherwise), then serves on `port` in the given transport mode. Direct mode
 * serves the real session; every other mode serves the reused mock. Returns the
 * Bun `Server`.
 */
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
