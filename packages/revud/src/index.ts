import { join } from 'node:path'
import { installDiskStorage } from './storage'
import { loadMock } from './mock-bridge'
import { startServer } from './server'
import type { RevuMode } from './api-router'
import { DirectStartupError, resolveDirectContext } from './direct/context'

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

/** The transport modes the daemon can boot into today. `broker` is reserved. */
export type BootMode = Extract<RevuMode, 'mock' | 'direct'>

/**
 * Resolve the boot mode from CLI args and the environment. `--direct` (or
 * `REVU_MODE=direct`) selects direct mode; anything else defaults to mock, which
 * keeps the daemon's historical behavior exactly. `broker` is not yet a boot
 * option and is rejected with a clear message so a mistyped mode fails loudly.
 */
export function resolveMode(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): BootMode {
  const flaggedDirect = argv.includes('--direct')
  const mode = flaggedDirect ? 'direct' : (env.REVU_MODE ?? 'mock')
  if (mode === 'mock' || mode === 'direct') return mode
  throw new Error(
    `REVU_MODE="${mode}" is not supported — use "mock" (default) or "direct" (or pass --direct).`,
  )
}

/**
 * Read the explicit repository override from `--repo owner/name` or
 * `REVU_REPO`. The flag wins over the env var. Returns `undefined` when neither
 * is set, so resolution falls back to the `origin` remote.
 */
export function resolveRepoOverride(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const idx = argv.indexOf('--repo')
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1]
  const inline = argv.find((a) => a.startsWith('--repo='))
  if (inline !== undefined) return inline.slice('--repo='.length)
  return env.REVU_REPO
}

/**
 * Boot the daemon. The mode is resolved from CLI args and the environment, then
 * threaded explicitly from here down to the router: the router never reads the
 * environment, so the mock-only dev routes cannot be re-enabled after boot by a
 * changed env var. Direct mode and mock mode take different boot paths but the
 * default (mock) behavior is byte-for-byte unchanged.
 */
export async function main(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const mode = resolveMode(process.argv.slice(2), env)
  if (mode === 'direct') {
    await mainDirect(env)
    return
  }
  await mainMock(env)
}

/**
 * Mock-mode boot: install the disk-backed storage BEFORE the mock loads (so the
 * store hydrates from disk), load the reused mock, start the server, and
 * register a synchronous flush on SIGTERM/SIGINT so a shutdown loses no in-flight
 * write. This path is unchanged from the daemon's original behavior.
 */
async function mainMock(env: Record<string, string | undefined>): Promise<void> {
  const port = resolvePort(env)
  const distDir = resolveDistDir(env)

  const { dataDir } = installDiskStorage(env)
  const mock = await loadMock()
  const server = startServer({ port, distDir, mock, mode: 'mock' })

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
      `(mode=mock, data=${dataDir})`,
  )
}

/**
 * Direct-mode boot: resolve the target repo, prove a GitHub token is obtainable,
 * and build the real session — all guarded, so a missing repo/token stops the
 * daemon with a clear message and non-zero exit (thrown as `DirectStartupError`
 * and handled at the entry point). There is no mock store and no disk-backed
 * broker document here: the sync and draft stores do not exist yet, so this boot
 * only serves the session and a `not_implemented` placeholder for the rest.
 *
 * The token is never logged: only the resolved repo and viewer login appear in
 * the startup line.
 */
async function mainDirect(env: Record<string, string | undefined>): Promise<void> {
  const port = resolvePort(env)
  const distDir = resolveDistDir(env)
  const repoOverride = resolveRepoOverride(process.argv.slice(2), env)

  const context = await resolveDirectContext({
    env,
    ...(repoOverride !== undefined ? { repoOverride } : {}),
  })

  const server = startServer({ port, distDir, directSession: context.session, mode: 'direct' })

  const shutdown = (signal: string): void => {
    server.stop(true)
    console.log(`revud: ${signal} received, stopped.`)
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  console.log(
    `revud: serving ${distDir} on http://localhost:${server.port} ` +
      `(mode=direct, repo=${context.repo.owner}/${context.repo.repo}, ` +
      `viewer=${context.session.viewerLogin ?? '?'})`,
  )
}

// Run when invoked directly (`bun run packages/revud/src/index.ts`), not when
// imported by a test.
if (import.meta.main) {
  main().catch((err: unknown) => {
    // A DirectStartupError is a user-facing refuse-to-start (no token, not a
    // GitHub repo): its message is already actionable, so print it plainly and
    // exit non-zero. Any other failure prints its message the same way.
    if (err instanceof DirectStartupError) {
      console.error(`revud: ${err.message}`)
    } else {
      console.error(err instanceof Error ? err.message : String(err))
    }
    process.exit(1)
  })
}
