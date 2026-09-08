/**
 * What an end-to-end run spawns, decided before anything is spawned.
 *
 * `resolveHarnessOptions` is pure: it turns a driver's intent (a daemon mode, a
 * repository to run inside, a guard module to preload) into the argv, the
 * environment, the working directory and the data directory the harness will
 * use. Because the decision is a value rather than a side effect of starting a
 * process, a test can assert it without a daemon, a built dist or a browser.
 *
 * Two guarantees hold and are covered by tests:
 *
 *   - **The default is byte-identical.** Called with no options it produces
 *     exactly what the harness has always spawned: `bun run <revud entry>` with
 *     the ambient environment plus an ephemeral port, a fresh temp data
 *     directory, the real built app dist, and mock mode. Adding an option must
 *     change only what that option names — `{ mode: 'direct', cwd }` moves the
 *     mode and the working directory and touches nothing else.
 *
 *   - **Ownership decides teardown.** `ownsDataDir` is true only when this
 *     module created the directory itself. The harness removes a data directory
 *     only when it owns it, so a caller that supplies its own directory (a
 *     seeded repository, a fixture it inspects afterwards) always keeps it.
 *
 * A caller `env` is merged last and therefore wins over every default,
 * including the daemon variables set from `mode` and `dataDir`; the dedicated
 * options are the ergonomic path and `env` is the escape hatch below them.
 *
 * This module deliberately imports nothing but Node built-ins — no browser
 * driver — so asserting the spawn decision costs a test run nothing.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** Absolute path to the revud entrypoint and the real built app dist. */
export const REVUD_ENTRY = resolve(import.meta.dir, '../packages/revud/src/index.ts')
export const DIST_DIR = resolve(import.meta.dir, '../packages/app/dist')

/** The daemon backends a driver can ask for; the harness defaults to `mock`. */
export type HarnessMode = 'mock' | 'direct' | 'broker'

/** What a driver asks for. Every field is optional; see the defaults below. */
export interface HarnessOptions {
  /** Daemon backend, passed through as `REVU_MODE`. Defaults to `mock`. */
  mode?: HarnessMode
  /**
   * Data directory for the daemon. When given it is used as-is and never
   * removed; when omitted a fresh temp directory is created and owned.
   */
  dataDir?: string
  /** Working directory for the daemon process, e.g. a seeded git repository. */
  cwd?: string
  /** Extra environment for the daemon. Merged last, so these keys win. */
  env?: Record<string, string>
  /** Module preloaded into the daemon process before its entrypoint runs. */
  preload?: string
}

/** The fully decided spawn: everything the harness needs to start and stop. */
export interface ResolvedHarnessOptions {
  mode: HarnessMode
  dataDir: string
  /** True when `dataDir` was created here, and so may be removed on teardown. */
  ownsDataDir: boolean
  cwd: string | undefined
  env: Record<string, string>
  argv: string[]
}

/** Seams for tests: injecting `makeDataDir` keeps the resolution off the disk. */
export interface HarnessOptionDeps {
  makeDataDir?: () => string
}

/** Mint a fresh, empty data directory so a run starts from pristine fixtures. */
function makeTempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'revu-e2e-'))
}

/**
 * Decide what to spawn. Pure apart from `makeDataDir`, which creates a
 * directory only when the caller supplied none.
 */
export function resolveHarnessOptions(
  options: HarnessOptions = {},
  deps: HarnessOptionDeps = {},
): ResolvedHarnessOptions {
  const mode = options.mode ?? 'mock'
  const ownsDataDir = options.dataDir === undefined
  const dataDir = options.dataDir ?? (deps.makeDataDir ?? makeTempDataDir)()

  // The ambient environment is inherited so the child finds bun, git and the
  // rest of the toolchain. Unset variables are dropped rather than forwarded as
  // `undefined`, which would mean "remove this variable" to the spawn.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.REVU_PORT = '0'
  env.REVU_DATA_DIR = dataDir
  env.REVU_DIST_DIR = DIST_DIR
  env.REVU_MODE = mode
  Object.assign(env, options.env)

  // `--preload` belongs between `run` and the entrypoint: bun applies it to the
  // script it then runs, so the preloaded module's top level executes first.
  const argv =
    options.preload === undefined
      ? ['bun', 'run', REVUD_ENTRY]
      : ['bun', 'run', '--preload', options.preload, REVUD_ENTRY]

  return { mode, dataDir, ownsDataDir, cwd: options.cwd, env, argv }
}
