import { join } from 'node:path'
import { installDiskStorage } from './storage'
import { loadMock } from './mock-bridge'
import { startLoopbackAlias, startServer } from './server'
import type { RevuMode } from './api-router'
import { DirectStartupError, resolveDirectContext } from './direct/context'
import { createDirectApi } from './direct/direct-api'
import { resolveBotLogin } from './direct/session'
import { createGithubClient } from './direct/github-client'
import { openDirectStore, resolveDirectDataDir } from './direct/store'
import { createBrokerWriteDecorator } from './direct/write-decorator'
import { createFileCredentialTokenSource } from './broker/token-source'
import { createPollLoop } from './broker/poll-loop'
import {
  createReviewerAssignments,
  resolveReviewersFile,
} from './broker/reviewer-assignment'

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

/** The transport modes the daemon can boot into. */
export type BootMode = Extract<RevuMode, 'mock' | 'direct' | 'broker'>

/**
 * Resolve the boot mode from CLI args and the environment. `--direct` (or
 * `REVU_MODE=direct`) selects direct mode; `REVU_MODE=broker` selects broker
 * mode (the same engine against a host-injected ambient credential, bound to
 * loopback); anything else defaults to mock, which keeps the daemon's historical
 * behavior exactly. An unrecognized mode is rejected with a clear message so a
 * mistyped mode fails loudly.
 */
export function resolveMode(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): BootMode {
  const flaggedDirect = argv.includes('--direct')
  const mode = flaggedDirect ? 'direct' : (env.REVU_MODE ?? 'mock')
  if (mode === 'mock' || mode === 'direct' || mode === 'broker') return mode
  throw new Error(
    `REVU_MODE="${mode}" is not supported — use "mock" (default), "direct" (or pass --direct), or "broker".`,
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
  if (mode === 'broker') {
    await mainBroker(env)
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
 * and handled at the entry point). Then open the durable SQLite store and bind
 * the read/persist surface (sync engine + store) that serves sync, snapshot,
 * drafts, viewed, and preferences. GraphQL threads and the write path stay
 * `not_implemented` until they land.
 *
 * The token is never logged: only the resolved repo, viewer login, and data dir
 * appear in the startup line. The store lives under
 * `${XDG_DATA_HOME:-~/.local/share}/revu`, so a restart loses no draft.
 */
async function mainDirect(env: Record<string, string | undefined>): Promise<void> {
  const port = resolvePort(env)
  const distDir = resolveDistDir(env)
  const repoOverride = resolveRepoOverride(process.argv.slice(2), env)

  const context = await resolveDirectContext({
    env,
    ...(repoOverride !== undefined ? { repoOverride } : {}),
  })

  // Opening the store reads the store-version row once and migrates in place; a
  // present-but-unreadable row throws here, failing startup loudly rather than
  // reseeding over real drafts.
  const dataDir = resolveDirectDataDir(env)
  const store = openDirectStore({ dataDir, env })
  const directApi = createDirectApi({
    session: context.session,
    github: context.github,
    repo: context.repo,
    store,
    // The local-first blob provider reads the git clone via the same runner and
    // directory startup validated, so blob bytes come free from local git.
    runner: context.runner,
    cwd: context.cwd,
  })

  const server = startServer({
    port,
    distDir,
    directSession: context.session,
    directApi,
    mode: 'direct',
  })

  const shutdown = (signal: string): void => {
    try {
      store.close()
    } finally {
      server.stop(true)
      console.log(`revud: ${signal} received, stopped.`)
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  console.log(
    `revud: serving ${distDir} on http://localhost:${server.port} ` +
      `(mode=direct, repo=${context.repo.owner}/${context.repo.repo}, ` +
      `viewer=${context.session.viewerLogin ?? '?'}, data=${dataDir})`,
  )
}

/**
 * Broker-mode boot: the SAME engine as direct, run in a disposable workspace
 * against a GitHub credential an external host injects into the workspace's
 * credential file, and bound to loopback. It differs from direct mode in exactly
 * three ways, and reuses everything else:
 *
 *   1. The `TokenSource` is `createFileCredentialTokenSource(...)` — it reads the
 *      injected `~/.git-credentials` (or `REVU_CREDENTIALS_FILE`) fresh on every
 *      request rather than shelling out to `gh`.
 *   2. Boot tolerates an absent credential and never probes the viewer. The host
 *      writes and refreshes the file on its own schedule, so it may legitimately
 *      be missing for a short window at container start. `validateToken: false`
 *      skips the boot-time token probe that direct mode uses to fail fast, so the
 *      daemon starts anyway; the awaiting state is surfaced per request (as
 *      `broker_unreachable`) instead of stopping the process. Identity resolves
 *      locally from git config (the `Human` — the stable draft/audit key), so the
 *      session is real from boot; a GitHub App installation token cannot resolve
 *      its own login via `GET /user` (GitHub answers 403), so the bot's login,
 *      when writes are enabled, comes from `REVU_BOT_LOGIN` instead. No GitHub
 *      call is made at boot at all.
 *   3. The server binds `127.0.0.1`, reachable only over loopback inside the
 *      workspace; the host reaches it through a forwarded port.
 *
 * Broker WRITES require a configured bot identity. When `REVU_BOT_LOGIN` names
 * the GitHub App's bot login, the session self-identifies as that bot
 * (`brokerLogin` = `viewerLogin` = the bot login — which makes the self-approval
 * guard and the submit idempotency re-check correct: the bot recognizes its own
 * pull requests and its own prior reviews) and the api is assembled with the
 * broker `WriteDecorator`: every body is stamped with the human's display name
 * via the shared prefix, and every confirmed write is journaled to the
 * append-only audit log under the human's id. When `REVU_BOT_LOGIN` is unset
 * the daemon is reads-only: the router gates the four write endpoints (submit
 * review, reply, resolve/unresolve, react) to `not_implemented`, because
 * without a self-identity a retried submit could double-post and APPROVE would
 * run without the self-review guard. Reads (sync, snapshot, blobs, reconcile)
 * are fully served either way. The token is never logged: only the resolved
 * repo, write configuration, and data dir appear in the startup line.
 */
async function mainBroker(env: Record<string, string | undefined>): Promise<void> {
  const port = resolvePort(env)
  const distDir = resolveDistDir(env)
  const repoOverride = resolveRepoOverride(process.argv.slice(2), env)

  const context = await resolveDirectContext({
    env,
    // Read the ambient host-injected credential rather than shelling out to `gh`.
    tokenSource: createFileCredentialTokenSource({ env }),
    // The credential may not be present yet at boot; do not halt on its absence.
    validateToken: false,
    ...(repoOverride !== undefined ? { repoOverride } : {}),
  })

  const dataDir = resolveDirectDataDir(env)
  const store = openDirectStore({ dataDir, env })

  // The bot login the App posts as (deployment config; `null` when reads-only).
  // Resolved before the poll loop because the loop derives `canApprove` from it.
  const botLogin = resolveBotLogin(env)

  // The host-side reviewers file (assignments + the login→human map), read from
  // alongside the SQLite store so it survives a workspace rebuild. The poll loop
  // re-reads it each tick, so a lead's edit takes effect without a restart.
  const reviewers = createReviewerAssignments(resolveReviewersFile(dataDir, env))

  // The live pulls-list poll loop: a dedicated client over the SAME injected
  // credential source (stateless — it re-reads the file per request, so a second
  // client shares no mutable state with the sync client). It issues one
  // conditional list every ~30s and serves `/v1/pulls` from an in-memory cache;
  // a 304 round is free against the shared bucket. The loop tolerates an
  // awaiting credential per tick without crashing. The author / reviewer /
  // approvability annotations ride on each pull's meta: `authorHumanId` from the
  // durable `pr_author` store (host-populated by the collector; a narrow
  // `getPrAuthor` read seam is all the loop needs), `assignedReviewerHumanIds`
  // from the reviewers file, and `canApprove` from the bot login.
  const pollClient = createGithubClient({ tokenSource: context.tokenSource })
  const pollLoop = createPollLoop({
    client: pollClient,
    facts: { getPullFacts: pollClient.getPullFacts, getCompare: pollClient.getCompare },
    repo: context.repo,
    prAuthor: { getPrAuthor: (pr) => store.getPrAuthor(pr) },
    reviewers,
    botLogin,
  })

  // Writes are enabled exactly when the deployment configured the bot login the
  // GitHub App posts as (resolved above as `botLogin`). The session (built from
  // the same env) already self-identifies as that bot, and the stamping +
  // journaling decorator is injected so every mediated write carries the human's
  // stamped name and lands one audit_log row. The router gates broker writes on
  // the api's `brokerWritesEnabled` capability, which only that decorator
  // confers: without the bot login no decorator is injected, the capability
  // stays false, and all four write routes answer 501 — the default passthrough
  // is structurally unreachable by a broker write.
  const brokerApi = createDirectApi({
    session: context.session,
    github: context.github,
    repo: context.repo,
    store,
    runner: context.runner,
    cwd: context.cwd,
    // Serve `/v1/pulls` LIVE from the poll cache.
    pullList: pollLoop,
    ...(botLogin !== null
      ? { writeDecorator: createBrokerWriteDecorator(context.session, store) }
      : {}),
  })

  // Warm the cache and begin the ~30s cadence now that the api is assembled.
  pollLoop.start()

  const serveOptions = {
    port,
    distDir,
    directSession: context.session,
    directApi: brokerApi,
    mode: 'broker' as const,
    // Loopback only: the injected credential never rides an interface anyone
    // outside the workspace can reach.
    hostname: '127.0.0.1',
  }
  const server = startServer(serveOptions)
  // Serve the IPv6 loopback too, on the same port. Inside a container
  // `localhost` usually resolves to `::1` first, so a caller that dials the
  // name rather than the address finds nothing listening. Still loopback, so
  // exposure is unchanged; null when the container has no IPv6 at all.
  const serverV6 = startLoopbackAlias({ ...serveOptions, port: server.port })

  const shutdown = (signal: string): void => {
    try {
      pollLoop.stop()
      store.close()
    } finally {
      server.stop(true)
      serverV6?.stop(true)
      console.log(`revud: ${signal} received, stopped.`)
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  console.log(
    `revud: serving ${distDir} on http://127.0.0.1:${server.port} ` +
      `(mode=broker, writes=${botLogin === null ? 'disabled (no REVU_BOT_LOGIN)' : `enabled as ${botLogin}`}, ` +
      `repo=${context.repo.owner}/${context.repo.repo}, ` +
      `human=${context.session.human.id}, data=${dataDir})`,
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
