/**
 * The three boot decisions the local review capability adds to direct mode, and
 * the one thing it must never add.
 *
 * A `main*` function is assertable only by spawning a process, so each decision
 * is an exported pure function and boot is wiring over them. That is what makes
 * the four claims below testable at all:
 *
 * 1. **Local reviews are a CAPABILITY, never a mode.** The mode axis is about
 *    credential custody and bind address — mock, direct, broker — and a daemon
 *    that serves local reviews is a direct (or broker) daemon with one more
 *    surface wired, not a fourth kind of daemon. The tripwire below asserts the
 *    negative directly: every plausible fourth spelling is REJECTED, and exactly
 *    the three that exist resolve.
 * 2. **The capability is switched on explicitly.** Relaxing the GitHub
 *    requirement automatically whenever repo or token resolution fails is
 *    friendlier and much riskier: a transient `gh` failure inside a genuine
 *    GitHub clone would boot a daemon that can only do local reviews and shows
 *    an empty inbox, which reads to its user as data loss. With no flag and no
 *    environment variable the requirement stands, so the existing boot is
 *    unchanged.
 * 3. **The repository root is DISCOVERED, never assumed.** The boot context
 *    carries a bare process working directory that nothing discovers. Handing
 *    that to the local surface would read blobs and write pin refs against
 *    whichever directory the daemon happened to be started in — a different
 *    repository whenever it is started from a subdirectory or a linked worktree.
 *    When discovery fails there is no local surface at all, because a daemon
 *    with no repository must answer a local id `not_found` rather than pin into
 *    the wrong repository.
 * 4. **The startup line is pinned.** A daemon-spawning test reads the bound port
 *    out of it with a regex, so a reformat breaks every such suite; and a
 *    local-only boot must not print the absent halves as `undefined` or `?`.
 */
import { describe, expect, test } from 'bun:test'
import { ApiError, LOCAL_REVIEW_ID_BASE } from '@revu/shared'
import type { Session } from '@revu/shared'
import type { CommandResult, CommandRunner } from './direct/command-runner'
import { createDirectApi } from './direct/direct-api'
import { throwingGithubClient } from './direct/github-write-stubs'
import { openDirectStore } from './direct/store'
import {
  directStartupLine,
  resolveGithubRequirement,
  resolveLocalSurfaceRoot,
  resolveMode,
} from './index'

// ————————————————————————————————————————————————————————————————————————————
// Block 1 — the fourth-mode tripwire.
// ————————————————————————————————————————————————————————————————————————————

/**
 * Spellings a future author might reach for when adding local reviews as a mode
 * rather than as a capability. Each one must be REJECTED.
 *
 * Asserting that the rejection message names the three real modes is a
 * regression proof, not a tripwire: it stays green after a fourth mode is added,
 * because the message would then name four. Only the rejection itself fails when
 * the axis grows.
 */
const PLAUSIBLE_FOURTH_MODES = ['local', 'local-only', 'localonly', 'offline', 'git'] as const

/** The complete set of modes that exist, and the value each resolves to. */
const REAL_MODES = ['mock', 'direct', 'broker'] as const

describe('the mode axis carries exactly three modes', () => {
  for (const spelling of PLAUSIBLE_FOURTH_MODES) {
    test(`resolveMode rejects "${spelling}" — local reviews are a capability, not a mode`, () => {
      expect(() => resolveMode([], { REVU_MODE: spelling })).toThrow()
    })
  }

  for (const mode of REAL_MODES) {
    test(`resolveMode resolves "${mode}"`, () => {
      expect(resolveMode([], { REVU_MODE: mode })).toBe(mode)
    })
  }

  test('the local-only switch does not select a mode of its own', () => {
    // The switch rides INSIDE direct mode: with it set, the mode is still
    // whatever the mode axis says, which by default is mock.
    expect(resolveMode(['--local-only'], {})).toBe('mock')
    expect(resolveMode(['--direct', '--local-only'], {})).toBe('direct')
  })
})

// ————————————————————————————————————————————————————————————————————————————
// Block 2 — the switch.
// ————————————————————————————————————————————————————————————————————————————

interface RequirementRow {
  readonly what: string
  readonly argv: string[]
  readonly env: Record<string, string | undefined>
  readonly requireGithub: boolean
}

const REQUIREMENT_TABLE: readonly RequirementRow[] = [
  {
    what: 'no flag and no environment variable — the existing boot, unchanged',
    argv: [],
    env: {},
    requireGithub: true,
  },
  {
    what: 'direct mode alone still requires GitHub',
    argv: ['--direct'],
    env: {},
    requireGithub: true,
  },
  {
    what: 'the --local-only flag lifts the requirement',
    argv: ['--local-only'],
    env: {},
    requireGithub: false,
  },
  {
    what: 'REVU_LOCAL_ONLY=1 lifts the requirement',
    argv: [],
    env: { REVU_LOCAL_ONLY: '1' },
    requireGithub: false,
  },
  {
    what: 'REVU_LOCAL_ONLY=true lifts the requirement',
    argv: [],
    env: { REVU_LOCAL_ONLY: 'true' },
    requireGithub: false,
  },
  {
    what: 'REVU_LOCAL_ONLY=0 leaves it in force',
    argv: [],
    env: { REVU_LOCAL_ONLY: '0' },
    requireGithub: true,
  },
  {
    what: 'REVU_LOCAL_ONLY=false leaves it in force',
    argv: [],
    env: { REVU_LOCAL_ONLY: 'false' },
    requireGithub: true,
  },
  {
    what: 'an empty REVU_LOCAL_ONLY is an unset one',
    argv: [],
    env: { REVU_LOCAL_ONLY: '' },
    requireGithub: true,
  },
  {
    what: 'the flag wins over an environment variable that says otherwise',
    argv: ['--local-only'],
    env: { REVU_LOCAL_ONLY: '0' },
    requireGithub: false,
  },
]

describe('resolveGithubRequirement', () => {
  for (const row of REQUIREMENT_TABLE) {
    test(row.what, () => {
      expect(resolveGithubRequirement(row.argv, row.env)).toBe(row.requireGithub)
    })
  }

  test('an unrecognized REVU_LOCAL_ONLY value is refused, never read as "off"', () => {
    // Reading `yes` as off is exactly the silent degradation the explicit switch
    // exists to avoid, one level down: the user asked for a local-only daemon,
    // got a GitHub-requiring one, and finds out at the first failure.
    expect(() => resolveGithubRequirement([], { REVU_LOCAL_ONLY: 'yes' })).toThrow()
  })

  test('the refusal names the variable and the values it accepts', () => {
    let message = ''
    try {
      resolveGithubRequirement([], { REVU_LOCAL_ONLY: 'yes' })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('REVU_LOCAL_ONLY')
    expect(message).toContain('1')
    expect(message).toContain('0')
  })
})

// ————————————————————————————————————————————————————————————————————————————
// Block 3 — root discovery.
// ————————————————————————————————————————————————————————————————————————————

/** One recorded invocation: what was run, and the directory it ran in. */
interface Invocation {
  readonly argv: readonly string[]
  readonly cwd: string | undefined
}

interface FakeRunner extends CommandRunner {
  readonly calls: Invocation[]
}

const OK = (stdout: string): CommandResult => ({ ok: true, code: 0, stdout, stderr: '' })
const FAILED = (code: number, stderr: string): CommandResult => ({
  ok: false,
  code,
  stdout: '',
  stderr,
})

/**
 * A runner that answers from a table keyed on the joined argv, records every
 * invocation with the directory it was asked to run in, and fails loudly for an
 * argv the table does not carry — an unanswered command is a wiring mistake, not
 * a silent empty result.
 */
function fakeRunner(table: Record<string, CommandResult>): FakeRunner {
  const calls: Invocation[] = []
  return {
    calls,
    async run(argv: string[], opts?: { cwd?: string }): Promise<CommandResult> {
      calls.push({ argv: [...argv], cwd: opts?.cwd })
      const key = argv.join(' ')
      const answer = table[key]
      if (answer === undefined) {
        return FAILED(128, `the fake runner has no answer for ${JSON.stringify(key)}`)
      }
      return answer
    },
  }
}

const TOPLEVEL_ARGV = 'git rev-parse --show-toplevel'
const ORIGIN_ARGV = 'git remote get-url origin'

describe('resolveLocalSurfaceRoot', () => {
  test('a subdirectory resolves to the repository toplevel, not to the cwd', async () => {
    const runner = fakeRunner({
      [TOPLEVEL_ARGV]: OK('/repo\n'),
      [ORIGIN_ARGV]: OK('git@github.com:acme/revu.git\n'),
    })

    const resolved = await resolveLocalSurfaceRoot(runner, '/repo/packages/app')

    expect(resolved).not.toBeNull()
    expect(resolved?.root).toBe('/repo')
    // The assertion the context's own working directory fails: it is the
    // subdirectory the daemon started in, and the local surface must never run
    // git there.
    expect(resolved?.root).not.toBe('/repo/packages/app')
  })

  test('the identity comes from the origin remote when one parses', async () => {
    const runner = fakeRunner({
      [TOPLEVEL_ARGV]: OK('/repo\n'),
      [ORIGIN_ARGV]: OK('git@github.com:acme/revu.git\n'),
    })

    const resolved = await resolveLocalSurfaceRoot(runner, '/repo/packages/app')

    expect(resolved?.repo).toBe('acme/revu')
  })

  test('a repository with no origin is identified by its toplevel path', async () => {
    const runner = fakeRunner({
      [TOPLEVEL_ARGV]: OK('/home/dana/scratch\n'),
      [ORIGIN_ARGV]: FAILED(2, 'error: No such remote'),
    })

    const resolved = await resolveLocalSurfaceRoot(runner, '/home/dana/scratch/src')

    expect(resolved?.repo).toBe('/home/dana/scratch')
  })

  test('the identity is read from the discovered root, never from the starting cwd', async () => {
    const runner = fakeRunner({
      [TOPLEVEL_ARGV]: OK('/repo\n'),
      [ORIGIN_ARGV]: OK('git@github.com:acme/revu.git\n'),
    })

    await resolveLocalSurfaceRoot(runner, '/repo/packages/app')

    const origin = runner.calls.find((call) => call.argv.join(' ') === ORIGIN_ARGV)
    expect(origin?.cwd).toBe('/repo')
  })

  test('a linked worktree resolves to the worktree path, not to its parent', async () => {
    const runner = fakeRunner({
      [TOPLEVEL_ARGV]: OK('/work/worktrees/feature\n'),
      [ORIGIN_ARGV]: OK('https://github.com/acme/revu.git\n'),
    })

    const resolved = await resolveLocalSurfaceRoot(runner, '/work/worktrees/feature/packages/app')

    expect(resolved?.root).toBe('/work/worktrees/feature')
    expect(resolved?.root).not.toBe('/work/worktrees')
  })

  test('a non-zero rev-parse resolves to null — there is no repository to review', async () => {
    const runner = fakeRunner({
      [TOPLEVEL_ARGV]: FAILED(128, 'fatal: not a git repository (or any of the parent directories)'),
    })

    expect(await resolveLocalSurfaceRoot(runner, '/tmp/not-a-repo')).toBeNull()
  })

  test('a bare repository resolves to null rather than to an empty root', async () => {
    // `rev-parse --show-toplevel` exits 0 inside a bare repository and prints
    // nothing, so a caller reading only the exit code would thread the empty
    // string as a working directory.
    const runner = fakeRunner({ [TOPLEVEL_ARGV]: OK('\n') })

    expect(await resolveLocalSurfaceRoot(runner, '/srv/git/revu.git')).toBeNull()
  })

  test('a null root means the api is assembled with no local reviews at all', async () => {
    const runner = fakeRunner({
      [TOPLEVEL_ARGV]: FAILED(128, 'fatal: not a git repository'),
    })
    const root = await resolveLocalSurfaceRoot(runner, '/tmp/not-a-repo')
    expect(root).toBeNull()

    const store = openDirectStore({ dataDir: ':memory:' })
    try {
      // Assembled exactly as boot assembles it: the local half is present only
      // when a root was discovered, so a null root contributes no key at all.
      const api = createDirectApi({
        session: SESSION,
        github: throwingGithubClient(),
        repo: { owner: 'acme', repo: 'revu' },
        store,
        ...(root !== null ? { localReviews: buildSurfaceFrom(root) } : {}),
      })

      // A local id must land on the typed not-found the dispatch layer already
      // returns, rather than being pinned into whichever repository the daemon
      // happened to start in — or handed to GitHub as a pull request number.
      let thrown: unknown
      try {
        api.getSnapshot(LOCAL_REVIEW_ID_BASE)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(ApiError)
      expect((thrown as ApiError).code).toBe('not_found')
    } finally {
      store.close()
    }
  })
})

/**
 * Stands in for the surface boot would build from a discovered root. It is never
 * reached: the case that calls it asserts the root is null first, and this
 * throws so a regression that assembled a surface from nothing fails loudly
 * instead of passing with a stub.
 */
function buildSurfaceFrom(root: unknown): never {
  throw new Error(`no local surface may be built from ${JSON.stringify(root)}`)
}

const SESSION: Session = {
  human: {
    id: 'dana.reeve@example.test',
    name: 'Dana Reeve',
    role: 'contractor',
    email: 'dana.reeve@example.test',
  },
  brokerLogin: '',
  workspace: 'local',
}

// ————————————————————————————————————————————————————————————————————————————
// Block 4 — the startup line.
// ————————————————————————————————————————————————————————————————————————————

/**
 * The regex a daemon-spawning suite uses to read the bound port out of the
 * startup line. It is duplicated here deliberately: this is the contract the
 * line must keep, and asserting it here is what turns a reformat into one
 * failure in this file rather than a failure in every suite that spawns a
 * daemon.
 */
const PORT_FROM_STARTUP_LINE = /http:\/\/localhost:(\d+)/

describe('directStartupLine', () => {
  test('the GitHub-capable line is byte-for-byte what it has always been', () => {
    const line = directStartupLine({
      distDir: '/srv/revu/packages/app/dist',
      port: 4780,
      repo: 'acme/revu',
      viewer: 'dana',
      dataDir: '/home/dana/.local/share/revu',
    })

    expect(line).toBe(
      'revud: serving /srv/revu/packages/app/dist on http://localhost:4780 ' +
        '(mode=direct, repo=acme/revu, viewer=dana, data=/home/dana/.local/share/revu)',
    )
  })

  test('an absent repo and an absent viewer print as nothing, never as undefined', () => {
    const line = directStartupLine({
      distDir: '/srv/revu/packages/app/dist',
      port: 4780,
      repo: null,
      viewer: null,
      dataDir: '/home/dana/.local/share/revu',
    })

    expect(line).not.toContain('undefined')
  })

  test('an absent viewer is omitted rather than printed as a question mark', () => {
    const line = directStartupLine({
      distDir: '/srv/revu/packages/app/dist',
      port: 4780,
      repo: null,
      viewer: null,
      dataDir: '/home/dana/.local/share/revu',
    })

    expect(line).not.toContain('viewer=?')
  })

  test('an absent repo still names the mode and the data directory', () => {
    const line = directStartupLine({
      distDir: '/srv/revu/packages/app/dist',
      port: 4780,
      repo: null,
      viewer: null,
      dataDir: '/home/dana/.local/share/revu',
    })

    expect(line).toContain('mode=direct')
    expect(line).toContain('data=/home/dana/.local/share/revu')
  })

  test('a repo with no viewer keeps the repo and drops only the viewer', () => {
    // The ordinary local-only boot inside a GitHub clone: the origin parses, but
    // nothing probed a viewer, so there is no login to print.
    const line = directStartupLine({
      distDir: '/dist',
      port: 4780,
      repo: 'acme/revu',
      viewer: null,
      dataDir: '/data',
    })

    expect(line).toContain('repo=acme/revu')
    expect(line).not.toContain('viewer')
  })

  test('the bound port is readable from the GitHub-capable line', () => {
    const line = directStartupLine({
      distDir: '/dist',
      port: 51234,
      repo: 'acme/revu',
      viewer: 'dana',
      dataDir: '/data',
    })

    expect(PORT_FROM_STARTUP_LINE.exec(line)?.[1]).toBe('51234')
  })

  test('the bound port is readable from the local-only line too', () => {
    const line = directStartupLine({
      distDir: '/dist',
      port: 51234,
      repo: null,
      viewer: null,
      dataDir: '/data',
    })

    expect(PORT_FROM_STARTUP_LINE.exec(line)?.[1]).toBe('51234')
  })
})
