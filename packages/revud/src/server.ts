import { existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { Server } from 'bun'
import type { MockBundle } from './mock-bridge'
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
}

/** Resolve a URL pathname to a safe absolute path inside `distDir`, or null. */
function resolveStaticPath(distDir: string, pathname: string): string | null {
  // Strip the leading slash and normalize; reject any path that escapes distDir.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  const abs = join(distDir, rel)
  if (!abs.startsWith(distDir)) return null
  return abs
}

/**
 * Build the request handler. Serves `/api/*` from the mock, otherwise static
 * files from `distDir` with an `index.html` SPA fallback.
 */
export function createFetchHandler(
  distDir: string,
  mock: MockBundle,
): (req: Request) => Promise<Response> {
  const indexPath = join(distDir, 'index.html')

  return async function fetch(req: Request): Promise<Response> {
    const apiResponse = await handleApi(req, mock)
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
 * Start the daemon. Asserts `dist/` exists (a clear build-first error otherwise)
 * and that the mode is `mock`, then serves on `port`. Returns the Bun `Server`.
 */
export function startServer(opts: ServeOptions): Server {
  if (!existsSync(opts.distDir) || !existsSync(join(opts.distDir, 'index.html'))) {
    throw new Error(
      `revud: built frontend not found at ${opts.distDir}. ` +
        `Build the app first (e.g. \`bun run build:app\`) before starting revud.`,
    )
  }

  const fetch = createFetchHandler(opts.distDir, opts.mock)
  return Bun.serve({ port: opts.port, fetch })
}
