import { join } from 'node:path'
import { installDiskStorage } from './storage'
import { loadMock } from './mock-bridge'
import { startServer } from './server'

/**
 * Entry point for the revu daemon. One Bun process serves the built frontend
 * and the `RevuApi` contract over a single port, backed by the app's mock
 * adapter as the semantics oracle (the mock is never duplicated). Broker-side
 * state persists to disk through a `localStorage` polyfill, so a restart loses
 * no draft.
 */

export const REVUD_PACKAGE = '@revu/revud'

/** Default HTTP port; overridable with `REVU_PORT`. */
export const DEFAULT_PORT = 4780

/** Resolve the port from the environment, falling back to the default. */
export function resolvePort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.REVU_PORT
  if (raw === undefined || raw.length === 0) return DEFAULT_PORT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`REVU_PORT must be an integer in 0..65535, got "${raw}".`)
  }
  return n
}

/** Resolve where the built frontend lives; overridable with `REVU_DIST_DIR`. */
export function resolveDistDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.REVU_DIST_DIR
  if (configured && configured.length > 0) return configured
  // Default: the app package's build output, relative to the repo root cwd.
  return join(process.cwd(), 'packages', 'app', 'dist')
}

/** Assert the only supported transport mode. `mock` is the sole mode for now. */
export function assertMode(env: Record<string, string | undefined> = process.env): 'mock' {
  const mode = env.REVU_MODE ?? 'mock'
  if (mode !== 'mock') {
    throw new Error(`REVU_MODE="${mode}" is not supported yet — only "mock" is available.`)
  }
  return mode
}

/**
 * Boot the daemon: assert env, install the disk-backed storage BEFORE the mock
 * loads (so the store hydrates from disk), load the reused mock, start the
 * server, and register a synchronous flush on SIGTERM/SIGINT so a shutdown
 * loses no in-flight write.
 */
export async function main(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const mode = assertMode(env)
  const port = resolvePort(env)
  const distDir = resolveDistDir(env)

  const { dataDir } = installDiskStorage(env)
  const mock = await loadMock()
  // The mode is threaded explicitly from here down to the router: the router
  // never reads the environment, so the mock-only dev routes cannot be
  // re-enabled after boot by a changed env var.
  const server = startServer({ port, distDir, mock, mode })

  const shutdown = (signal: string): void => {
    try {
      mock.store.flush()
    } finally {
      server.stop(true)
      console.log(`revud: ${signal} received, flushed and stopped.`)
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  console.log(
    `revud: serving ${distDir} on http://localhost:${server.port} ` +
      `(mode=${mode}, data=${dataDir})`,
  )
}

// Run when invoked directly (`bun run packages/revud/src/index.ts`), not when
// imported by a test.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
