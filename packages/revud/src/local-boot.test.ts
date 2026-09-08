/**
 * The boot decisions the local review capability adds to direct mode, and the
 * one thing it must never add.
 *
 * A `main*` function is assertable only by spawning a process, so each decision
 * is an exported function and boot is wiring over them. That is what makes the
 * five claims below testable at all:
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
 *    unchanged. And a SET switch must never be silently ignored: with any mode
 *    but direct resolved, boot refuses rather than serving a daemon the switch
 *    never configured.
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
 * 5. **The surface is assembled ONCE, and every boot shares that assembly.**
 *    Because local reviews ride inside a mode rather than being one, every boot
 *    that assembles a read/persist surface has to assemble the same one. While
 *    each boot wired the local half for itself, nothing said so: one discovered
 *    a repository and passed a surface, another passed none, and the difference
 *    was invisible in the type system until a workspace asked the second kind of
 *    daemon for a review of a local branch pair and was told the id did not
 *    exist. One shared assembler makes the two agree by construction, and it is
 *    an exported function for the same reason every decision above is one. The
 *    block below pins what it now owns: the local half is identical whichever
 *    shape of boot calls it, the repository it acts on is the discovered
 *    toplevel, the GitHub half travels exactly as the context holds it, and the
 *    plumbing a boot genuinely owns — a poll cache, a credential-bound
 *    branch-pair listing, a write decorator — still reaches the api.
 */
import { describe, expect, test } from 'bun:test'
import { ApiError, LOCAL_REVIEW_ID_BASE } from '@revu/shared'
import type {
  GhRef,
  PullListItem,
  PullListResponse,
  RateLimitInfo,
  Session,
} from '@revu/shared'
import type { CommandResult, CommandRunner } from './direct/command-runner'
import type { PullListSource } from './direct/direct-api'
import { createDirectApi } from './direct/direct-api'
import type { SupersedingPullClient } from './direct/github-client'
import { throwingGithubClient } from './direct/github-write-stubs'
import type { SupersedingPullSource } from './direct/local-archive'
import type { RepoRef } from './direct/repo'
import type { DirectStore } from './direct/store'
import { openDirectStore } from './direct/store'
import type { TokenSource } from './direct/token-source'
import type { WriteDecorator } from './direct/write-decorator'
import type { DirectContext } from './direct/context'
import { resolveDirectContext } from './direct/context'
import { handleDirectApi } from './direct-router'
import {
  assertLocalOnlySupported,
  createBootApi,
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

describe('assertLocalOnlySupported', () => {
  test('the switch with a non-direct mode refuses to boot rather than being ignored', () => {
    // Only the direct boot path consults the GitHub requirement, so with any
    // other mode resolved the daemon would boot as if the switch had never
    // been given — a mock daemon serving fixtures to a user who asked for a
    // local-only one. That is the same silent degradation the unrecognized
    // REVU_LOCAL_ONLY value is refused for, one level up, and it is refused
    // the same way: loudly, at boot.
    expect(() => assertLocalOnlySupported('mock', false)).toThrow()
    expect(() => assertLocalOnlySupported('broker', false)).toThrow()
  })

  test('the refusal names the mode that would ignore the switch, and the fix', () => {
    let message = ''
    try {
      assertLocalOnlySupported('mock', false)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('mock')
    expect(message).toContain('--local-only')
    expect(message).toContain('--direct')
  })

  test('direct mode with the switch boots', () => {
    expect(() => assertLocalOnlySupported('direct', false)).not.toThrow()
  })

  test('without the switch every mode boots unchanged', () => {
    expect(() => assertLocalOnlySupported('mock', true)).not.toThrow()
    expect(() => assertLocalOnlySupported('direct', true)).not.toThrow()
    expect(() => assertLocalOnlySupported('broker', true)).not.toThrow()
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
// Block 3b — a local-only boot inside a GitHub clone.
// ————————————————————————————————————————————————————————————————————————————

describe('a local-only boot inside a GitHub clone without a credential', () => {
  test('a GitHub-band write cannot reach the write path with an absent viewer', async () => {
    // The runner answers as a genuine clone would — the origin parses — while
    // `gh` is unauthenticated and no env token is set. The GitHub half must
    // then drop WHOLE rather than keep a repo no client can authenticate to:
    // a kept repo would make the daemon report itself GitHub-capable while its
    // session carries no viewer, and the write guards keyed on the viewer
    // login (the self-review gate, the submit idempotency re-check) silently
    // invert on a blank one — refusing every verdict and double-posting
    // retried submits.
    const runner = fakeRunner({
      [ORIGIN_ARGV]: OK('git@github.com:acme/revu.git\n'),
      'git config user.name': OK('Dana Reeve\n'),
      'git config user.email': OK('dana.reeve@example.test\n'),
      'gh auth token': FAILED(1, 'gh: not logged in'),
    })
    let fetchCalls = 0
    const context = await resolveDirectContext({
      runner,
      fetchImpl: async (url: string) => {
        fetchCalls += 1
        throw new Error(`unexpected GitHub request: ${url}`)
      },
      env: {},
      requireGithub: false,
    })

    expect(context.repo).toBeUndefined()
    expect(context.github).toBeUndefined()
    expect(context.session.viewerLogin).toBeUndefined()

    // Assembled exactly as boot assembles it: both halves together, or neither.
    const store = openDirectStore({ dataDir: ':memory:' })
    try {
      const github = context.github
      const repo = context.repo
      const api = createDirectApi({
        session: context.session,
        ...(github !== undefined && repo !== undefined ? { github, repo } : {}),
        store,
      })
      expect(api.githubEnabled).toBe(false)

      // The router refuses the GitHub-band write before dispatch, naming the
      // missing repository, so the write path never runs against the absent
      // viewer — and nothing along the way issued a GitHub request.
      const res = await handleDirectApi(
        new Request('http://localhost/api/pulls/204/review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prNumber: 204,
            expectedHeadSha: 'h'.repeat(40),
            event: 'APPROVE',
            body: 'ship it',
            comments: [],
          }),
        }),
        context.session,
        api,
      )
      expect(res?.status).toBe(501)
      const body = (await res?.json()) as { code: string; message: string }
      expect(body.code).toBe('not_implemented')
      expect(/no GitHub repository/i.test(body.message)).toBe(true)
      expect(fetchCalls).toBe(0)
    } finally {
      store.close()
    }
  })
})

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

  test('the GitHub facts travel together: both printed, or both omitted', () => {
    // The GitHub half is all-or-nothing at resolve time: a boot that kept its
    // repository proved a credential and probed its viewer, and a boot that
    // could not produce one dropped both. The line renders the only two shapes
    // a direct boot yields — never a repo without a viewer, which would print
    // a daemon claiming GitHub capability its write guards cannot back.
    const kept = directStartupLine({
      distDir: '/dist',
      port: 4780,
      repo: 'acme/revu',
      viewer: 'dana',
      dataDir: '/data',
    })
    expect(kept).toContain('repo=acme/revu')
    expect(kept).toContain('viewer=dana')

    const dropped = directStartupLine({
      distDir: '/dist',
      port: 4780,
      repo: null,
      viewer: null,
      dataDir: '/data',
    })
    expect(dropped).not.toContain('repo=')
    expect(dropped).not.toContain('viewer=')
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

// ————————————————————————————————————————————————————————————————————————————
// Block 5 — the shared assembly.
// ————————————————————————————————————————————————————————————————————————————

/** The clone every assembly below is booted inside, and where it was started. */
const CLONE_ROOT = '/repo'
const INSIDE_CLONE = '/repo/packages/app'
const OUTSIDE_ANY_CLONE = '/tmp/not-a-repo'
const CLONE_ORIGIN = 'git@github.com:acme/revu.git'

/** The identity discovery reads off that origin, in both of its spellings. */
const CLONE_IDENTITY = 'acme/revu'
const CLONE_REPO_REF: RepoRef = { owner: 'acme', repo: 'revu' }

/** The branch pair the seeded review names, fully qualified and bare. */
const BASE_REF = 'refs/heads/main'
const HEAD_REF = 'refs/heads/feature'
const BASE_BRANCH = 'main'
const HEAD_BRANCH = 'feature'

/**
 * A runner that answers `rev-parse --show-toplevel` PER DIRECTORY, the way git
 * does: inside the clone the toplevel is the clone, and anywhere else there is
 * no repository at all. Everything else fails loudly, so a command the assembly
 * did not need is a wiring mistake rather than a silent empty result.
 *
 * Answering per directory is what makes the pair of assemblies below differ in
 * exactly one thing — the directory the daemon was started in — instead of in
 * two fixtures that could have diverged for any reason.
 */
function cloneRunner(): FakeRunner {
  const calls: Invocation[] = []
  return {
    calls,
    async run(argv: string[], opts?: { cwd?: string }): Promise<CommandResult> {
      calls.push({ argv: [...argv], cwd: opts?.cwd })
      const key = argv.join(' ')
      const cwd = opts?.cwd ?? ''
      const inside = cwd === CLONE_ROOT || cwd.startsWith(`${CLONE_ROOT}/`)
      if (key === TOPLEVEL_ARGV) {
        return inside
          ? OK(`${CLONE_ROOT}\n`)
          : FAILED(128, 'fatal: not a git repository (or any of the parent directories)')
      }
      if (key === ORIGIN_ARGV) return OK(`${CLONE_ORIGIN}\n`)
      return FAILED(128, `the clone runner has no answer for ${JSON.stringify(key)}`)
    },
  }
}

/**
 * A credential source that fails if it is ever consulted.
 *
 * Assembling the read/persist surface must reach GitHub for nothing: the local
 * half is git and the store, and the GitHub half is carried through exactly as
 * the context holds it. A token fetched during assembly would be hidden work
 * done on a path a `--local-only` boot has no credential for at all.
 */
const REFUSING_TOKENS: TokenSource = {
  getToken(): Promise<string> {
    throw new Error('assembling the api must not fetch a GitHub credential')
  },
}

/**
 * The branch-pair listing a GitHub-backed CONTEXT carries, recording the
 * repository each question was asked about. The repository is in the record
 * because that is the thing binding it to a context can get wrong.
 */
function contextPairClient(log: string[]): SupersedingPullClient {
  return {
    async listOpenPullsForPair(owner, repo, pair) {
      log.push(`context:${owner}/${repo}:${pair.headRef}...${pair.baseRef}`)
      return []
    },
  }
}

/**
 * The branch-pair listing a CALLER passes, already bound to its own repository —
 * broker mode passes the one its poll loop's client already holds. It names no
 * repository for exactly that reason: the binding was made before it got here.
 */
function callerPairSource(log: string[]): SupersedingPullSource {
  return {
    async listOpenPullsForPair(pair) {
      log.push(`caller:${pair.headRef}...${pair.baseRef}`)
      return []
    },
  }
}

/** A GitHub-backed context over one working directory, and nothing else varying. */
function githubBackedContext(
  cwd: string,
  runner: CommandRunner,
  pairs: SupersedingPullClient,
): DirectContext {
  return {
    session: SESSION,
    tokenSource: REFUSING_TOKENS,
    runner,
    cwd,
    repo: CLONE_REPO_REF,
    github: throwingGithubClient(),
    supersedingPulls: pairs,
  }
}

/**
 * A context that resolved no GitHub half — no origin, no credential, no viewer —
 * which is the deployment reviews of local branch pairs exist for. The absence
 * is typed rather than blank, so there is no stand-in repository to pass on.
 */
function repositorylessContext(cwd: string, runner: CommandRunner): DirectContext {
  return { session: SESSION, tokenSource: REFUSING_TOKENS, runner, cwd }
}

/** The allowance the poll half reports; a merged list carries it through. */
const POLL_RATE_LIMIT: RateLimitInfo = {
  limit: 5000,
  remaining: 4999,
  used: 1,
  reset: '2026-01-01T00:00:00.000Z',
}

/** A pull-request row of the kind a poll cache serves. */
function pollRow(number: number): PullListItem {
  const side = (ref: string): GhRef => ({
    ref,
    sha: 'a'.repeat(40),
    label: `acme:${ref}`,
    repo: { full_name: CLONE_IDENTITY, default_branch: BASE_BRANCH },
  })
  return {
    pull: {
      id: number,
      node_id: `PR_${number}`,
      number,
      state: 'open',
      draft: false,
      merged_at: null,
      title: `pull ${number}`,
      body: null,
      user: { login: 'carol', id: 9, node_id: '', avatar_url: '', html_url: '', type: 'User' },
      labels: [],
      requested_reviewers: [],
      head: side(HEAD_BRANCH),
      base: side(BASE_BRANCH),
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    broker: {
      authorHumanId: null,
      canApprove: true,
      unresolvedThreads: 0,
      assignedReviewerHumanIds: [],
      compareKey: `${'a'.repeat(40)}...${'a'.repeat(40)}`,
      commitCount: 1,
    },
  }
}

/** A poll cache serving a fixed set of rows, as broker mode's loop does. */
function pollSourceServing(items: PullListItem[]): PullListSource {
  return {
    listPulls(): PullListResponse {
      return { items, etag: 'W/"poll-1"', notModified: false, rateLimit: POLL_RATE_LIMIT }
    },
  }
}

/**
 * A decorator that declares the broker write capability. Declaring it is the
 * ONLY way an api can hold it — the capability is read off the decorator
 * actually injected — so this is what makes "the decorator reached the api" an
 * observable fact rather than an assumption about the parts object.
 */
function brokerShapedDecorator(): WriteDecorator {
  return {
    decorateBody: (body: string): string => `**Dana Reeve** (contractor)\n\n${body}`,
    recordWrite: (): void => {},
    brokerWritesEnabled: true,
  }
}

/** One in-memory store carrying one recorded local review, and that review's id. */
function storeWithOneLocalReview(): { store: DirectStore; localId: number } {
  const store = openDirectStore({ dataDir: ':memory:' })
  const { id } = store.createLocalReview({
    repo: CLONE_IDENTITY,
    baseRef: BASE_REF,
    headRef: HEAD_REF,
    title: 'a review of a local branch pair',
  })
  return { store, localId: id }
}

/**
 * The typed code a synchronous call refused with — `null` when it returned, and
 * a described string when it threw something the contract has no code for, so a
 * plain error can never be mistaken for the typed refusal being asserted.
 */
function refusalCode(call: () => unknown): string | null {
  try {
    call()
  } catch (err) {
    if (err instanceof ApiError) return err.code
    return `untyped: ${err instanceof Error ? err.name : String(err)}`
  }
  return null
}

/** The git the local surface ran, with the discovery commands taken out. */
function surfaceInvocations(runner: FakeRunner): Invocation[] {
  return runner.calls.filter((call) => {
    const key = call.argv.join(' ')
    return key !== TOPLEVEL_ARGV && key !== ORIGIN_ARGV
  })
}

describe('createBootApi assembles the local surface for every boot', () => {
  test('a broker-shaped assembly answers the local band from the surface itself', async () => {
    const { store, localId } = storeWithOneLocalReview()
    try {
      // The parts a broker boot brings that a direct boot does not: a poll
      // cache to serve the list from, and a stamping write decorator.
      const api = await createBootApi({
        context: githubBackedContext(INSIDE_CLONE, cloneRunner(), contextPairClient([])),
        store,
        pullList: pollSourceServing([]),
        writeDecorator: brokerShapedDecorator(),
      })

      // The seeded review sits in the reserved band, so the answers below are
      // about the band and not about some ordinary number.
      expect(localId).toBeGreaterThanOrEqual(LOCAL_REVIEW_ID_BASE)

      // The surface's OWN methods answer: the listing carries the recorded
      // review, and the band id resolves to a review that has simply never been
      // synced. An unwired daemon can produce neither — it refuses both.
      expect(api.listLocalReviews().map((review) => review.id)).toEqual([localId])
      expect(api.getSnapshot(localId)).toBeNull()
    } finally {
      store.close()
    }
  })

  test('the same assembly started outside any repository refuses the local band', async () => {
    const { store, localId } = storeWithOneLocalReview()
    try {
      // Identical in every part but the working directory — same session, same
      // repository, same client, same store, same row. Without this the claim
      // above is about an api that could never have refused, which is no claim
      // about the wiring at all.
      const api = await createBootApi({
        context: githubBackedContext(OUTSIDE_ANY_CLONE, cloneRunner(), contextPairClient([])),
        store,
        pullList: pollSourceServing([]),
        writeDecorator: brokerShapedDecorator(),
      })

      expect(refusalCode(() => api.listLocalReviews())).toBe('not_found')
      expect(refusalCode(() => api.getSnapshot(localId))).toBe('not_found')
    } finally {
      store.close()
    }
  })

  test('the surface acts on the DISCOVERED toplevel, not on the starting directory', async () => {
    const { store, localId } = storeWithOneLocalReview()
    const runner = cloneRunner()
    try {
      const api = await createBootApi({
        context: githubBackedContext(INSIDE_CLONE, runner, contextPairClient([])),
        store,
      })

      // The sync's git runs against a runner that answers nothing, so it fails.
      // The rejection is the fixture's limit and not the claim: what is asserted
      // is the directory the commands were issued in on the way there.
      await expect(api.syncPull(localId)).rejects.toThrow()

      const issued = surfaceInvocations(runner)
      expect(issued.length).toBeGreaterThan(0)
      for (const call of issued) {
        expect(call.cwd).toBe(CLONE_ROOT)
        expect(call.cwd).not.toBe(INSIDE_CLONE)
      }
    } finally {
      store.close()
    }
  })

  test('a direct-shaped assembly is wired identically for the local half', async () => {
    const { store, localId } = storeWithOneLocalReview()
    try {
      const brokerShaped = await createBootApi({
        context: githubBackedContext(INSIDE_CLONE, cloneRunner(), contextPairClient([])),
        store,
        pullList: pollSourceServing([]),
        writeDecorator: brokerShapedDecorator(),
      })
      // No poll cache, no decorator, no listing seam of its own — everything a
      // direct boot declines to bring.
      const directShaped = await createBootApi({
        context: githubBackedContext(INSIDE_CLONE, cloneRunner(), contextPairClient([])),
        store,
      })

      // Pinned against the seed FIRST. Two apis that both refused would agree
      // with each other just as exactly as two that both serve.
      expect(directShaped.listLocalReviews().map((review) => [review.id, review.repo])).toEqual([
        [localId, CLONE_IDENTITY],
      ])
      expect(directShaped.getSnapshot(localId)).toBeNull()

      // And only then against each other: the two modes' local surfaces differ
      // in nothing, because there is only one of them.
      expect(directShaped.listLocalReviews()).toEqual(brokerShaped.listLocalReviews())
      expect(directShaped.getSnapshot(localId)).toEqual(brokerShaped.getSnapshot(localId))

      // The local surface alone is a review list, so a direct boot that brought
      // no poll cache still serves one.
      expect(directShaped.pullListEnabled).toBe(true)
    } finally {
      store.close()
    }
  })

  test('a context with no repository yields no GitHub capability and still serves the band', async () => {
    const { store, localId } = storeWithOneLocalReview()
    try {
      const api = await createBootApi({
        context: repositorylessContext(INSIDE_CLONE, cloneRunner()),
        store,
      })

      // No stand-in repository was invented to fill the absent half, and the
      // local half is untouched by that absence: the two are independent.
      expect(api.githubEnabled).toBe(false)
      expect(api.listLocalReviews().map((review) => review.id)).toEqual([localId])
    } finally {
      store.close()
    }
  })

  test('a GitHub-backed context yields the capability', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    try {
      const api = await createBootApi({
        context: githubBackedContext(INSIDE_CLONE, cloneRunner(), contextPairClient([])),
        store,
      })

      expect(api.githubEnabled).toBe(true)
    } finally {
      store.close()
    }
  })

  test('a caller-supplied branch-pair listing is used INSTEAD of one bound from the context', async () => {
    const { store, localId } = storeWithOneLocalReview()
    try {
      const fromContext: string[] = []
      const fromCaller: string[] = []
      const api = await createBootApi({
        context: githubBackedContext(INSIDE_CLONE, cloneRunner(), contextPairClient(fromContext)),
        store,
        supersedingPulls: callerPairSource(fromCaller),
      })

      // The archive check runs ahead of the sync's git work, and that git work
      // then fails against a runner answering nothing. Which listing was
      // consulted can only be read off the recorders for that reason — the
      // sync's own outcome says nothing about it.
      await expect(api.syncPull(localId)).rejects.toThrow()

      expect(fromCaller).toEqual([`caller:${HEAD_BRANCH}...${BASE_BRANCH}`])
      expect(fromContext).toEqual([])
    } finally {
      store.close()
    }
  })

  test('a context-supplied listing is bound to the context repository when the caller passes none', async () => {
    const { store, localId } = storeWithOneLocalReview()
    try {
      const fromContext: string[] = []
      const api = await createBootApi({
        context: githubBackedContext(INSIDE_CLONE, cloneRunner(), contextPairClient(fromContext)),
        store,
      })

      await expect(api.syncPull(localId)).rejects.toThrow()

      // The repository in the record is the context's own, spelled out rather
      // than derived from anything the call carried: binding is the step that
      // decides which repository a pair is asked about, and a per-call one would
      // make "the repository this daemon serves" an argument.
      expect(fromContext).toEqual([`context:acme/revu:${HEAD_BRANCH}...${BASE_BRANCH}`])
    } finally {
      store.close()
    }
  })

  test('a caller-supplied pull list reaches the api and merges with the local half', async () => {
    const { store, localId } = storeWithOneLocalReview()
    try {
      const merged = await createBootApi({
        context: githubBackedContext(INSIDE_CLONE, cloneRunner(), contextPairClient([])),
        store,
        pullList: pollSourceServing([pollRow(101)]),
      })
      // The same assembly with the poll cache withheld. `pullListEnabled` alone
      // could not tell these two apart — the local surface raises it on its own
      // — so the served rows are what the claim rests on.
      const localOnly = await createBootApi({
        context: githubBackedContext(INSIDE_CLONE, cloneRunner(), contextPairClient([])),
        store,
      })

      expect(merged.pullListEnabled).toBe(true)
      expect(merged.listPulls(null).items.map((item) => item.pull.number)).toEqual([101, localId])
      expect(localOnly.listPulls(null).items.map((item) => item.pull.number)).toEqual([localId])
    } finally {
      store.close()
    }
  })

  test('a caller-supplied write decorator reaches the api, and its absence fails closed', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    try {
      const stamping = await createBootApi({
        context: githubBackedContext(INSIDE_CLONE, cloneRunner(), contextPairClient([])),
        store,
        writeDecorator: brokerShapedDecorator(),
      })
      const passthrough = await createBootApi({
        context: githubBackedContext(INSIDE_CLONE, cloneRunner(), contextPairClient([])),
        store,
      })

      expect(stamping.brokerWritesEnabled).toBe(true)
      expect(passthrough.brokerWritesEnabled).toBe(false)
    } finally {
      store.close()
    }
  })
})
