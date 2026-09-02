import { join } from 'node:path'
import { installDiskStorage } from './storage'
import { loadMock } from './mock-bridge'
import { startLoopbackAlias, startServer } from './server'
import type { RevuMode } from './api-router'
import type { CommandRunner } from './direct/command-runner'
import {
  DirectStartupError,
  requireGithubContext,
  resolveDirectContext,
} from './direct/context'
import { createDirectApi } from './direct/direct-api'
import { discoverRepoRoot, repoIdentity } from './direct/local-git'
import { createLocalReviewSurface } from './direct/local-surface'
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

/** The flag that switches the local-only capability on. */
const LOCAL_ONLY_FLAG = '--local-only'

/** The environment variable that switches the same capability on without a flag. */
const LOCAL_ONLY_ENV_VAR = 'REVU_LOCAL_ONLY'

/** The values `REVU_LOCAL_ONLY` accepts, and what each one means. */
const LOCAL_ONLY_VALUES = new Map<string, boolean>([
  ['1', true],
  ['true', true],
  ['0', false],
  ['false', false],
])

/**
 * Whether a usable GitHub repository is a precondition for starting — the switch
 * behind reviews of local branches, which need no origin, no token, and no
 * viewer.
 *
 * The switch is EXPLICIT, and deliberately not automatic. Relaxing the
 * requirement whenever repo or token resolution fails would be friendlier and
 * much riskier: a transient `gh` failure inside a genuine GitHub clone would
 * silently boot a daemon that can only serve local reviews and shows an empty
 * inbox, which reads to its user as data loss rather than as a degraded mode.
 * With neither the flag nor the variable set the requirement stands, so the
 * existing boot is unchanged.
 *
 * This is NOT a mode. Modes are about credential custody and bind address;
 * local reviews are a capability that rides inside direct and broker mode, which
 * is why nothing here touches `resolveMode` or `BootMode`.
 *
 * An unrecognized variable value is refused rather than read as "off", because
 * `REVU_LOCAL_ONLY=yes` silently meaning "keep requiring GitHub" is the same
 * silent degradation in miniature: the user asked for a local-only daemon and
 * would learn otherwise only at the first failure.
 */
export function resolveGithubRequirement(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (argv.includes(LOCAL_ONLY_FLAG)) return false
  const raw = env[LOCAL_ONLY_ENV_VAR]
  if (raw === undefined || raw.length === 0) return true
  const localOnly = LOCAL_ONLY_VALUES.get(raw.trim().toLowerCase())
  if (localOnly === undefined) {
    throw new Error(
      `${LOCAL_ONLY_ENV_VAR}="${raw}" is not a recognized value — use 1/true to serve ` +
        `local reviews without a GitHub repository, or 0/false (the default) to require one.`,
    )
  }
  return !localOnly
}

/**
 * Refuse a boot whose local-only switch would otherwise be silently ignored.
 *
 * Only the direct boot path consults the GitHub requirement, so with the
 * switch set and any other mode resolved the daemon would come up as if the
 * switch had never been given — by default a MOCK daemon serving fixture data
 * to a user who asked for a local-only one, discoverable only at the first
 * confusing answer. That is the same silent degradation the unrecognized
 * `REVU_LOCAL_ONLY` value is refused for, one level up, and it is refused the
 * same way: loudly, at boot, with the fix in the message.
 */
export function assertLocalOnlySupported(mode: BootMode, requireGithub: boolean): void {
  if (requireGithub || mode === 'direct') return
  throw new Error(
    `${LOCAL_ONLY_FLAG} (or ${LOCAL_ONLY_ENV_VAR}) serves local reviews inside direct ` +
      `mode, but the resolved mode is "${mode}", which would ignore it. Pass --direct ` +
      `(or set REVU_MODE=direct) alongside the switch.`,
  )
}

/**
 * The repository a local review surface would be built over: where its git
 * commands run, and the identity its rows are keyed under.
 */
export interface LocalSurfaceRoot {
  /** The repository's discovered toplevel — never a starting working directory. */
  root: string
  /** `owner/name` when an origin remote parses, otherwise the toplevel path. */
  repo: string
}

/**
 * Discover the repository a local review surface would act on, or `null` when
 * there is none.
 *
 * The root is DISCOVERED rather than assumed, and that is the whole point of
 * this function. The boot context carries a bare process working directory that
 * nothing resolved; handing that to the local surface would read blobs and write
 * refs against whichever directory the daemon happened to be started in, which
 * is a different repository whenever it was started from a subdirectory or a
 * linked worktree. The identity is then read from the discovered root for the
 * same reason, so both halves describe one repository.
 *
 * A failure is a returned `null`, not a throw: a daemon with no repository is a
 * daemon with no local reviews — never one that pins into the wrong repository —
 * and expressing that as a value keeps the decision out of boot's control flow.
 * A bare repository is one of those failures: `rev-parse --show-toplevel` exits
 * zero there and prints nothing, which discovery reports as a failure rather
 * than as an empty working directory.
 */
export async function resolveLocalSurfaceRoot(
  runner: CommandRunner,
  cwd: string,
): Promise<LocalSurfaceRoot | null> {
  const discovered = await discoverRepoRoot(runner, cwd)
  if (!discovered.ok) return null
  const identity = await repoIdentity(runner, discovered.root)
  if (!identity.ok) return null
  return { root: discovered.root, repo: identity.identity }
}

/** The startup line's parts, each already resolved by the caller. */
export interface DirectStartupLine {
  distDir: string
  port: number
  /** `owner/name`, or `null` when this daemon has no GitHub repository. */
  repo: string | null
  /** The viewer's GitHub login, or `null` when none was probed. */
  viewer: string | null
  dataDir: string
}

/**
 * The direct-mode startup line, as a pure builder.
 *
 * Two things are pinned about it. The bound port is read back out of this line
 * by the suites that spawn a daemon, so the `http://localhost:PORT` shape is a
 * contract rather than a formatting choice. And an absent repo or viewer is
 * OMITTED rather than interpolated: `repo=undefined/undefined` and `viewer=?`
 * both describe a daemon nobody configured, when the truth is a daemon
 * configured for local reviews alone.
 */
export function directStartupLine(line: DirectStartupLine): string {
  const facts = [
    'mode=direct',
    ...(line.repo !== null ? [`repo=${line.repo}`] : []),
    ...(line.viewer !== null ? [`viewer=${line.viewer}`] : []),
    `data=${line.dataDir}`,
  ]
  return `revud: serving ${line.distDir} on http://localhost:${line.port} (${facts.join(', ')})`
}

/**
 * Boot the daemon. The mode is resolved from CLI args and the environment, then
 * threaded explicitly from here down to the router: the router never reads the
 * environment, so the mock-only dev routes cannot be re-enabled after boot by a
 * changed env var. Direct mode and mock mode take different boot paths but the
 * default (mock) behavior is byte-for-byte unchanged. The local-only switch is
 * checked against the resolved mode up front, so setting it outside direct mode
 * is a refusal rather than a no-op.
 */
export async function main(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const argv = process.argv.slice(2)
  const mode = resolveMode(argv, env)
  // The local-only switch is validated for EVERY mode, before any boot path
  // runs: a set switch with a non-direct mode resolved refuses to start rather
  // than booting a daemon the switch never configured.
  assertLocalOnlySupported(mode, resolveGithubRequirement(argv, env))
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
 * Reviews of local branches are wired here as a CAPABILITY of this same boot,
 * never as a mode of their own: `resolveGithubRequirement` decides whether the
 * GitHub half is a precondition, and the local surface is assembled over the
 * repository this daemon actually sits in. With the requirement lifted the
 * GitHub half may be absent ENTIRELY — a repository with no `origin` remote,
 * or one whose credential could not be obtained — and the api then reports no
 * GitHub capability, so the router refuses the GitHub-only routes with a
 * message naming what is missing.
 * Nothing is narrowed to a repository here, because there may be none to narrow
 * to. The repository is DISCOVERED once —
 * the context's own working directory is a bare `process.cwd()` that nothing
 * resolved, so threading it would read blobs and write refs against whichever
 * directory the daemon was started in rather than against the repository that
 * directory belongs to. When discovery finds nothing, no surface is assembled
 * and every id from the local band answers a typed not-found, because a daemon
 * with no repository must serve no local reviews rather than pin into the wrong
 * repository.
 *
 * The token is never logged: only the resolved repo, viewer login, and data dir
 * appear in the startup line. The store lives under
 * `${XDG_DATA_HOME:-~/.local/share}/revu`, so a restart loses no draft.
 */
async function mainDirect(env: Record<string, string | undefined>): Promise<void> {
  const argv = process.argv.slice(2)
  const port = resolvePort(env)
  const distDir = resolveDistDir(env)
  const repoOverride = resolveRepoOverride(argv, env)
  const requireGithub = resolveGithubRequirement(argv, env)

  // Resolved WITHOUT narrowing to the GitHub-backed shape: with the requirement
  // lifted an unusable GitHub half is typed-absent rather than blank, and the
  // boot carries that absence forward instead of refusing to start on it. That
  // refusal is what previously made a local-only daemon impossible in a
  // repository with no `origin` — the one deployment it exists for. The half is
  // all-or-nothing: a clone whose GitHub half stands up end to end — token
  // obtained, viewer probed — keeps repo, client, and viewer together, and
  // anything less (no origin, no usable credential, an unreachable GitHub, or
  // a probe it refuses) drops all three, so the boot never carries a
  // repository its write guards have no viewer to stand behind.
  const context = await resolveDirectContext({
    env,
    requireGithub,
    ...(repoOverride !== undefined ? { repoOverride } : {}),
  })

  // Opening the store reads the store-version row once and migrates in place; a
  // present-but-unreadable row throws here, failing startup loudly rather than
  // reseeding over real drafts.
  const dataDir = resolveDirectDataDir(env)
  const store = openDirectStore({ dataDir, env })

  // Resolved ONCE, and from the context's working directory only as a starting
  // point: everything downstream is handed the discovered toplevel instead.
  const localRoot = await resolveLocalSurfaceRoot(context.runner, context.cwd)
  const localReviews =
    localRoot === null
      ? undefined
      : createLocalReviewSurface({
          store,
          runner: context.runner,
          toplevel: localRoot.root,
          repo: localRoot.repo,
          session: context.session,
        })

  // The GitHub half is passed on exactly as the context holds it: both halves
  // together, or neither. The api reports the result as its `githubEnabled`
  // capability and the router refuses the GitHub-only routes on it, so nothing
  // downstream needs a stand-in repository to interpolate into a request path.
  const github = context.github
  const repo = context.repo

  const directApi = createDirectApi({
    session: context.session,
    ...(github !== undefined && repo !== undefined ? { github, repo } : {}),
    store,
    // The local-first blob provider reads the git clone via the same runner and
    // directory startup validated, so blob bytes come free from local git.
    runner: context.runner,
    cwd: context.cwd,
    ...(localReviews !== undefined ? { localReviews } : {}),
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
    directStartupLine({
      distDir,
      port: server.port,
      // Absent when the boot holds no GitHub half — no origin resolved, or
      // the half was dropped whole for want of a credential. Printed as
      // nothing rather than as a placeholder, for the same reason the viewer
      // is: a blank `repo=/` describes a daemon pinned to a repository that
      // does not exist, which is a different problem.
      repo: repo === undefined ? null : `${repo.owner}/${repo.repo}`,
      // Absent exactly when the repo is: the GitHub half is all-or-nothing,
      // so a kept repository always carries a probed viewer and a dropped one
      // carries neither. Printed as nothing rather than as a placeholder:
      // `viewer=?` describes a daemon whose viewer could not be read, which
      // is a different problem.
      viewer: context.session.viewerLogin ?? null,
      dataDir,
    }),
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

  // Broker mode mediates GitHub for a repo, so it too narrows to the
  // GitHub-backed shape: the poll loop and the api both address a real
  // owner/name, never a blank one.
  const context = requireGithubContext(
    await resolveDirectContext({
      env,
      // Read the ambient host-injected credential rather than shelling out to `gh`.
      tokenSource: createFileCredentialTokenSource({ env }),
      // The credential may not be present yet at boot; do not halt on its absence.
      validateToken: false,
      ...(repoOverride !== undefined ? { repoOverride } : {}),
    }),
  )

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
