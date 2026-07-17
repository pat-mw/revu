import { existsSync } from 'node:fs'
import { join, normalize, relative, isAbsolute } from 'node:path'
import type { Server } from 'bun'
import type { MockBundle } from './mock-bridge'
import type { RevuMode } from './api-router'
import { handleApi } from './api-router'

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
  mock: MockBundle
  /**
   * The transport mode the daemon was booted with. Threaded explicitly into
   * the router (never read from the environment per-request) so the mock-only
   * dev routes are provably unreachable in any other mode.
   */
  mode: RevuMode
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

    const url = new URL(req.url)
    // Only GET/HEAD reach static serving; anything else on a non-API path is a 405.
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
}

/**
 * Start the daemon. Asserts `dist/` exists (a clear build-first error
 * otherwise), then serves on `port` in the given transport mode. Returns the
 * Bun `Server`.
 */
export function startServer(opts: ServeOptions): Server {
  if (!existsSync(opts.distDir) || !existsSync(join(opts.distDir, 'index.html'))) {
    throw new Error(
      `revud: built frontend not found at ${opts.distDir}. ` +
        `Build the app first (e.g. \`bun run build:app\`) before starting revud.`,
    )
  }

  const fetch = createFetchHandler(opts.distDir, opts.mock, opts.mode)
  return Bun.serve({ port: opts.port, fetch })
}
