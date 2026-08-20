/**
 * Retention: the one path that drops a local review's pinned refs, and the
 * structural guards that keep that path from growing a second tier.
 *
 * A local review's file blobs have no second source. The objects its snapshot
 * was read from live in exactly one object database, and a pin ref is what
 * keeps them there. Dropping those refs is therefore the only place in the
 * local path where retention can be lost, so the suite is organised around the
 * two ways a drop can be wrong:
 *
 *   1. **It deletes nothing while reporting success.** Reconstructing a ref name
 *      from a compare key produces `<mergeBase>...<head>`, which git refuses as a
 *      ref name outright — and a delete of a name that cannot exist exits zero.
 *      The fake-runner legs pin the exact argv, so a drop that never discovers
 *      anything is red rather than green.
 *   2. **It deletes and the objects stay pinned anyway, or were never pinned.**
 *      Only real git can answer that, so the last leg runs the whole story: pin,
 *      make the object unreachable, collect hard, prove it survived; then drop,
 *      collect again, prove it is gone. That turns "retention is an explicit
 *      delete rather than an accident of garbage collection" into an assertion.
 *
 * ## Why a source scan sits in a behavioural suite
 *
 * Two of the module's constraints are negatives over every code path at once —
 * it may never reach GitHub, and it may never issue a database statement that
 * rewrites storage wholesale. No runtime test can enumerate those; the durable
 * form is that the vocabulary needed to write them does not appear in the
 * source. A module that cannot name a client cannot mis-call one.
 *
 * A source scan is worthless unless it is proved to bite, so every scan here
 * carries its own controls: each scanned file is asserted to read back
 * non-empty (an absent or empty file satisfies every absence assertion
 * trivially), the specifier extractor is run over a fixture that deliberately
 * imports the forbidden module, and each banned pattern is matched against a
 * probe containing the exact construct it forbids.
 *
 * One absence per test throughout: the runner abandons a test body at its first
 * failed expectation, so two absence assertions sharing a body leave the second
 * unfalsifiable.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandResult, CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import { pinRefsFor, pinSnapshotObjects } from './local-pins'
import { dropPinnedRefs } from './retention'

/** A local id inside the reserved local-review band. */
const LOCAL_ID = 1_000_000_001
/** A second one, so "the other review's pins survived" is assertable. */
const OTHER_LOCAL_ID = 1_000_000_002

/** Forty hex characters — the shape a resolved sha1 object name arrives in. */
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

/** The two ref names one synced compare of `LOCAL_ID` is pinned behind. */
const PINNED_BASE = `refs/revu/reviews/${LOCAL_ID}/${SHA_A}-${SHA_B}/base`
const PINNED_HEAD = `refs/revu/reviews/${LOCAL_ID}/${SHA_A}-${SHA_B}/head`

/** A directory that is never touched: every fake-runner leg only records argv. */
const CWD = '/repo'

/** One recorded invocation, as the runner seam presents it. */
interface RecordedCall {
  args: string[]
  cwd?: string
}

/**
 * A `CommandRunner` that records every argv and answers from a caller-supplied
 * reply. The sink is the evidence both for the legs that assert something *was*
 * spawned and for the legs that assert nothing was, so one recorder serves both
 * and an empty sink can never be confused with a sink wired to nothing.
 */
function recordingRunner(
  reply: (args: readonly string[]) => CommandResult = () => ({
    ok: true,
    code: 0,
    stdout: '',
    stderr: '',
  }),
): CommandRunner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    async run(args, opts) {
      calls.push({
        args: [...args],
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      })
      return reply(args)
    },
  }
}

/** Answers a discovery command with the given refnames and everything else cleanly. */
function discoveryReturning(...refs: string[]): (args: readonly string[]) => CommandResult {
  const stdout = refs.map((ref) => `${ref}\n`).join('')
  return (args) => ({
    ok: true,
    code: 0,
    stdout: args.includes('for-each-ref') ? stdout : '',
    stderr: '',
  })
}

describe('the commands a drop spawns', () => {
  test('discovery is one hardened for-each-ref over the review prefix', async () => {
    const runner = recordingRunner()
    await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    // Spelled out whole rather than by `toContain`, so a dropped `--format` —
    // which would hand the parser git's unspecified default shape — is red, and
    // so is a dropped `--end-of-options`, without which the hardened seam
    // refuses to spawn at all and the drop silently deletes nothing.
    expect(runner.calls[0]?.args).toEqual([
      'git',
      'for-each-ref',
      '--format=%(refname)',
      '--end-of-options',
      `refs/revu/reviews/${LOCAL_ID}/`,
    ])
    expect(runner.calls[0]?.cwd).toBe(CWD)
  })

  test('each discovered ref is deleted, after discovery and in listing order', async () => {
    const runner = recordingRunner(discoveryReturning(PINNED_BASE, PINNED_HEAD))
    await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['git', 'for-each-ref', '--format=%(refname)', '--end-of-options', `refs/revu/reviews/${LOCAL_ID}/`],
      ['git', 'update-ref', '-d', '--end-of-options', PINNED_BASE],
      ['git', 'update-ref', '-d', '--end-of-options', PINNED_HEAD],
    ])
  })

  test('every command carries the caller-supplied working directory', async () => {
    // Nothing here reads the process working directory, so a command that lost
    // its `cwd` would act on whatever repository the daemon happened to start in.
    const runner = recordingRunner(discoveryReturning(PINNED_BASE, PINNED_HEAD))
    await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(runner.calls.map((call) => call.cwd)).toEqual([CWD, CWD, CWD])
  })

  test('the count and the refnames report what was dropped', async () => {
    const runner = recordingRunner(discoveryReturning(PINNED_BASE, PINNED_HEAD))
    const result = await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(result).toEqual({ ok: true, count: 2, dropped: [PINNED_BASE, PINNED_HEAD] })
  })

  test('an unpinned namespace spawns nothing beyond discovery', async () => {
    // The two-ref leg above is this one's standing control: it proves the same
    // recorder can count past one, so "only discovery ran" is a fact about the
    // drop rather than about a sink that never fills.
    const runner = recordingRunner(discoveryReturning())
    const result = await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(runner.calls).toHaveLength(1)
    expect(result).toEqual({ ok: true, count: 0, dropped: [] })
  })
})

describe('a drop refuses before it spawns anything it should not', () => {
  test('an id outside the local review band is refused and nothing is spawned', async () => {
    // A pull request number is a positive integer too. Listing a forge-keyed id
    // under the local namespace would answer a clean zero and hide the mistake.
    const runner = recordingRunner()
    const result = await dropPinnedRefs({ runner, cwd: CWD }, 42)
    expect(runner.calls).toEqual([])
    expect(result).toEqual({
      ok: false,
      reason: 'invalid-local-id',
      detail: '42 is not an id in the local review band',
      count: 0,
      dropped: [],
    })
  })

  test('a discovered name outside the prefix aborts before any deletion', async () => {
    // The one place text this module did not write reaches an argument slot. A
    // `refs/`-shaped foreign name passes the hardened-argv check on shape alone,
    // so the prefix is what stops a listing that went wrong from deleting a
    // branch. Checked across the whole listing first, so a bad name late in it
    // cannot be preceded by deletions that already happened.
    const runner = recordingRunner(discoveryReturning(PINNED_BASE, 'refs/heads/main'))
    const result = await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(runner.calls).toHaveLength(1)
    expect(result).toEqual({
      ok: false,
      reason: 'unexpected-ref',
      detail: `refs/heads/main is not under refs/revu/reviews/${LOCAL_ID}/`,
      count: 0,
      dropped: [],
    })
  })

  test('a failing discovery is a result, never a throw', async () => {
    const runner = recordingRunner(() => ({
      ok: false,
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository\n',
    }))
    const result = await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(result).toEqual({
      ok: false,
      reason: 'git-failed',
      detail: 'fatal: not a git repository',
      count: 0,
      dropped: [],
    })
  })

  test('a failing deletion is a result, and reports the refs already dropped', async () => {
    const runner = recordingRunner((args) => {
      if (args.includes('for-each-ref')) {
        return { ok: true, code: 0, stdout: `${PINNED_BASE}\n${PINNED_HEAD}\n`, stderr: '' }
      }
      if (args.includes(PINNED_HEAD)) {
        return { ok: false, code: 1, stdout: '', stderr: 'fatal: cannot lock ref\n' }
      }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    })
    const result = await dropPinnedRefs({ runner, cwd: CWD }, LOCAL_ID)
    expect(result).toEqual({
      ok: false,
      reason: 'git-failed',
      detail: 'fatal: cannot lock ref',
      count: 1,
      dropped: [PINNED_BASE],
    })
  })
})

/**
 * The modules the source scan reads. Retention is scanned for everything; the
 * direct store joins it only for the storage-statement ban, because the two
 * modules together are the whole of what a drop could touch.
 */
const RETENTION_MODULE = 'retention.ts'
const STORE_MODULE = 'store.ts'

/**
 * Reads a scanned module, failing loudly when it is not there. `readFileSync`
 * would throw too, but the message matters: an absent module means the scan has
 * nothing to examine, and that is the failure mode these guards exist to
 * prevent.
 */
function readScanned(module: string): string {
  const url = new URL(`./${module}`, import.meta.url)
  if (!existsSync(url)) {
    throw new Error(
      `${module} does not exist, so this guard has nothing to scan — that is a failure, not a pass`,
    )
  }
  return readFileSync(url, 'utf8')
}

/**
 * Matches a module specifier in an import statement that has a source clause,
 * anchored at the start of a line so a specifier-shaped string inside prose or
 * inside a call cannot be mistaken for a dependency. The lazy span between the
 * keyword and its `from` clause is what carries a multi-line named-import list.
 */
const IMPORT_WITH_SOURCE = /^import\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gm

/** Matches a side-effect import, which has no `from` clause to find. */
const SIDE_EFFECT_IMPORT = /^import\s+['"]([^'"]+)['"]/gm

/**
 * Every module specifier a source depends on, type-only ones included.
 * `verbatimModuleSyntax` means a type import is written exactly like a value
 * import and erased only at emit, so excluding it would leave the one spelling
 * that can name a client type without tripping the guard.
 */
function importSpecifiers(source: string): string[] {
  const found: string[] = []
  for (const pattern of [IMPORT_WITH_SOURCE, SIDE_EFFECT_IMPORT]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) found.push(specifier)
    }
  }
  return found
}

/** The trailing path segment of a specifier, which is where a module is named. */
function specifierBasename(specifier: string): string {
  const at = specifier.lastIndexOf('/')
  return at === -1 ? specifier : specifier.slice(at + 1)
}

/**
 * Everything retention is allowed to depend on.
 *
 * A subset rule rather than an exact set: the drop path gains its store import
 * only once eviction has stored state to reconcile against, and an exact-set
 * assertion would be red in the interval for no reason. What the rule actually
 * forbids is the arrival of a *new kind* of dependency — a network tier, an
 * SDK, a second command seam — and a subset rule catches that the moment it
 * lands.
 *
 * `./local-git` is here because it owns the hardened argv form: it is the only
 * module that assembles a git command, places rev operands behind
 * `--end-of-options`, and refuses to spawn an argv that fails that check.
 * Reaching the runner directly to avoid the dependency would mean re-deriving
 * that hardening in a second place. `@revu/shared` is here for the local-id
 * band predicate, so retention decides what an id is by the same rule the pin
 * writer does rather than by a second, drifting copy.
 */
const ALLOWED_SPECIFIERS = ['./store', './command-runner', './local-git', '@revu/shared'] as const

/** A source-shaped fixture whose only purpose is to prove the extractor reports. */
const IMPORT_FIXTURE = [
  "import type { GithubClient } from './github-client'",
  "import { openDirectStore } from './store'",
  'import {',
  '  runGit,',
  "} from './local-git'",
  "import './side-effect-only'",
].join('\n')

interface BannedConstruct {
  /** How a failure names the thing that was found. */
  readonly label: string
  readonly pattern: RegExp
  /** Source-shaped text carrying the construct, so the pattern is proved to fire. */
  readonly probe: string
}

/**
 * Constructs whose presence in retention's source would contradict one of its
 * stated constraints.
 *
 * The spawn primitive is banned because retention runs commands through the
 * injected runner seam and nothing else; a direct spawn would bypass both the
 * argv hardening and every test's ability to observe what was run. The two
 * network spellings are banned because the local path has no second source to
 * reach for — that absence is the whole reason pins exist. The tracking-id
 * shape is banned because a comment in this codebase describes the code and its
 * constraints and never a ticket, a milestone or a numbered unit of work; the
 * rule is otherwise a convention nobody can enforce by reading.
 */
const BANNED: readonly BannedConstruct[] = [
  {
    label: 'a direct process spawn',
    pattern: /Bun\.spawn/,
    probe: "const proc = Bun.spawn(['git', 'update-ref'])",
  },
  {
    label: 'a network call',
    pattern: /fetch\(/,
    probe: 'const res = await fetch(url)',
  },
  {
    label: 'an absolute web address',
    pattern: /https:\/\//,
    probe: "const base = 'https://api.github.com'",
  },
  {
    label: 'a tracking id',
    pattern: /\bM\d+(\.\d+)+\b/,
    probe: ' * Landed as part of M8.8, see the board.',
  },
]

/**
 * A storage-wide rewrite, matched in its statement form: a quote opening a SQL
 * string, then the keyword. Matching the bare word instead would make a comment
 * explaining why the statement is banned trip its own scan, and a guard that
 * cannot be written about is a guard nobody documents.
 *
 * It is banned because it rewrites the database file in place. A local review's
 * pins are refs in a git object database rather than rows, so a storage rewrite
 * can never be part of dropping them — and reaching for one here would couple
 * ref eviction to a whole-file operation that blocks every reader.
 */
const QUOTED_STORAGE_REWRITE = /['"`]\s*VACUUM\b/i

describe('the scanned sources are present to be scanned', () => {
  for (const module of [RETENTION_MODULE, STORE_MODULE]) {
    test(`${module} exists`, () => {
      expect(existsSync(new URL(`./${module}`, import.meta.url))).toBe(true)
    })

    test(`${module} has source text to scan`, () => {
      // A present-but-empty file satisfies every absence assertion below, so
      // this is the self-check that keeps the whole scan from going vacuous.
      expect(readScanned(module).length).toBeGreaterThan(0)
    })
  }
})

describe('the specifier extractor reports what it is asked to find', () => {
  test('it reports a forbidden specifier present in a fixture', () => {
    // Without this the allowlist assertion below would pass over an extractor
    // that reports nothing at all, which is the shape a source scan fails in.
    expect(importSpecifiers(IMPORT_FIXTURE)).toContain('./github-client')
  })

  test('it reports every specifier in the fixture, multi-line and bare alike', () => {
    expect(importSpecifiers(IMPORT_FIXTURE).sort()).toEqual([
      './github-client',
      './local-git',
      './side-effect-only',
      './store',
    ])
  })
})

describe('retention depends on nothing but the store and the command seam', () => {
  test('every specifier is drawn from the allowlist', () => {
    const specifiers = importSpecifiers(readScanned(RETENTION_MODULE))
    const foreign = specifiers.filter(
      (specifier) => !ALLOWED_SPECIFIERS.includes(specifier as (typeof ALLOWED_SPECIFIERS)[number]),
    )
    expect(foreign).toEqual([])
  })

  test('nothing resolves to the GitHub client module', () => {
    expect(importSpecifiers(readScanned(RETENTION_MODULE))).not.toContain('./github-client')
  })

  test('no specifier names GitHub at all', () => {
    const named = importSpecifiers(readScanned(RETENTION_MODULE)).filter((specifier) =>
      specifierBasename(specifier).toLowerCase().includes('github'),
    )
    expect(named).toEqual([])
  })
})

describe('retention names no way to leave the local machine', () => {
  for (const banned of BANNED) {
    test(`the source contains no ${banned.label}`, () => {
      expect(readScanned(RETENTION_MODULE)).not.toMatch(banned.pattern)
    })

    test(`${banned.label} is matched in a source-shaped probe`, () => {
      // A pattern that matches nothing anywhere never objects to what it
      // forbids, so each one is proved live against the construct itself.
      expect(banned.probe).toMatch(banned.pattern)
    })
  }

  test('the ban list has four members', () => {
    // An independent literal rather than a count derived from the list, so
    // dropping a member is red here even though every other assertion passes.
    expect(BANNED).toHaveLength(4)
  })
})

describe('no storage-wide rewrite reaches either module', () => {
  for (const module of [RETENTION_MODULE, STORE_MODULE]) {
    test(`${module} contains no quoted storage rewrite`, () => {
      expect(readScanned(module)).not.toMatch(QUOTED_STORAGE_REWRITE)
    })
  }

  test('the statement form is matched where it would really be written', () => {
    expect("db.exec('VACUUM')").toMatch(QUOTED_STORAGE_REWRITE)
  })

  test('prose naming the banned statement does not trip the scan', () => {
    // The reason the pattern is the statement form and not the bare keyword:
    // the documentation of a ban must be able to name what it bans.
    expect(' * A whole-file VACUUM is never part of dropping a ref.').not.toMatch(
      QUOTED_STORAGE_REWRITE,
    )
  })
})

/** The review whose pins the retention story is told against. */
const RETENTION_ID = 1_000_000_003

/**
 * The identity and hook flags every fixture commit is made under.
 *
 * A runner has no global git identity and `git commit` fails outright without
 * one, while a developer machine has a signing key and a hooks path that would
 * otherwise decide whether this gate is green. Pinned here so the fixture
 * behaves the same in both places.
 */
const IDENTITY = [
  '-c',
  'user.email=retention-fixture@revu.invalid',
  '-c',
  'user.name=Retention Fixture',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
] as const

/**
 * Wraps a runner so every invocation is recorded and then really run. The
 * fake-runner legs prove which commands a drop *would* spawn; this proves the
 * same about a drop that actually reached git, which is what makes "the second
 * drop spawned only a discovery" a claim about real behaviour.
 */
function countingRunner(inner: CommandRunner): CommandRunner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    async run(args, opts) {
      calls.push({
        args: [...args],
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      })
      return inner.run(args, opts)
    },
  }
}

describe('against a real repository', () => {
  let dir: string
  let shaOne: string
  let shaTwo: string
  let doomed: string
  let priorGlobalConfig: string | undefined
  let priorSystemConfig: string | undefined
  const runner = createBunCommandRunner()

  /** Runs one git command inside the fixture. Never against the working clone. */
  async function git(args: readonly string[]): Promise<CommandResult> {
    return runner.run(['git', ...args], { cwd: dir })
  }

  /** Runs a seeding command and refuses to continue if it failed. */
  async function seed(args: readonly string[]): Promise<string> {
    const result = await git(args)
    if (!result.ok) {
      throw new Error(
        `retention fixture seeding failed: \`git ${args.join(' ')}\` exited ${result.code}: ${result.stderr.trim()}`,
      )
    }
    return result.stdout.trim()
  }

  /** Commits nothing and answers the object name of the commit it made. */
  async function commit(message: string): Promise<string> {
    await seed([...IDENTITY, 'commit', '-q', '--allow-empty', '-m', message])
    return seed(['rev-parse', 'HEAD'])
  }

  /** Every ref currently under one review's prefix, newline-joined and trimmed. */
  async function listing(localId: number): Promise<string> {
    const result = await git([
      'for-each-ref',
      '--format=%(refname)',
      `refs/revu/reviews/${localId}/`,
    ])
    return result.stdout.trim()
  }

  /** Expires every reflog and collects hard, so only refs keep an object alive. */
  async function collect(): Promise<void> {
    await seed(['reflog', 'expire', '--expire=now', '--all'])
    await seed(['gc', '--prune=now', '-q'])
  }

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'revu-retention-')))
    // The production runner inherits this process's environment and takes no
    // environment argument, so pinning the config paths here is the only way
    // the isolation reaches the commands the code under test runs. Both point
    // inside the fixture at files that are never created: git reads a missing
    // config file as an empty one, which is the "no ambient configuration"
    // state an alias, a hooks path or a default branch name could otherwise
    // leak into.
    priorGlobalConfig = process.env.GIT_CONFIG_GLOBAL
    priorSystemConfig = process.env.GIT_CONFIG_SYSTEM
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'absent-global-gitconfig')
    process.env.GIT_CONFIG_SYSTEM = join(dir, 'absent-system-gitconfig')

    await seed(['init', '-q', '-b', 'main', '.'])
    shaOne = await commit('one')
    shaTwo = await commit('two')

    // Written by the pin module rather than by hand: the drop discovers refs by
    // prefix, so a test that wrote the names itself would only prove this file
    // agrees with itself. Writing with the real pin path makes a divergence
    // between the two spellings turn these legs red.
    for (const localId of [LOCAL_ID, OTHER_LOCAL_ID]) {
      const pinned = await pinSnapshotObjects(runner, dir, localId, {
        mergeBaseSha: shaOne,
        headSha: shaTwo,
      })
      expect(pinned.ok).toBe(true)
    }
  }, 60_000)

  afterAll(() => {
    if (priorGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = priorGlobalConfig
    if (priorSystemConfig === undefined) delete process.env.GIT_CONFIG_SYSTEM
    else process.env.GIT_CONFIG_SYSTEM = priorSystemConfig
    rmSync(dir, { recursive: true, force: true })
  })

  test('the drop reports both of the review’s refs', async () => {
    const refs = pinRefsFor(LOCAL_ID, `${shaOne}...${shaTwo}`)
    const result = await dropPinnedRefs({ runner, cwd: dir }, LOCAL_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.count).toBe(2)
    expect([...result.dropped].sort()).toEqual([refs.base, refs.head].sort())
  }, 30_000)

  test('nothing is left under that review’s prefix', async () => {
    // The absence this whole module exists to produce. Its control is the leg
    // below: the same listing command, run over a namespace that still has
    // refs, prints them — so an empty result here is a fact about the drop and
    // not about a listing that never prints anything.
    expect(await listing(LOCAL_ID)).toBe('')
  }, 30_000)

  test('the other local review keeps its pins', async () => {
    const refs = pinRefsFor(OTHER_LOCAL_ID, `${shaOne}...${shaTwo}`)
    expect((await listing(OTHER_LOCAL_ID)).split('\n').sort()).toEqual(
      [refs.base, refs.head].sort(),
    )
  }, 30_000)

  test('a second drop is a zero-count no-op that spawns only a discovery', async () => {
    const recorder = countingRunner(runner)
    const result = await dropPinnedRefs({ runner: recorder, cwd: dir }, LOCAL_ID)
    expect(result).toEqual({ ok: true, count: 0, dropped: [] })
    expect(recorder.calls.map((call) => call.args)).toEqual([
      ['git', 'for-each-ref', '--format=%(refname)', '--end-of-options', `refs/revu/reviews/${LOCAL_ID}/`],
    ])
  }, 30_000)

  test('a pinned object survives a collection that would otherwise reclaim it', async () => {
    // The control for the leg below, and the claim the pin exists to make. An
    // unreachable commit is collected by `--prune=now`; this one is held by
    // nothing but its pin, so its survival is the pin doing its job.
    doomed = await commit('doomed')
    const pinned = await pinSnapshotObjects(runner, dir, RETENTION_ID, {
      mergeBaseSha: shaOne,
      headSha: doomed,
    })
    expect(pinned.ok).toBe(true)

    await seed(['reset', '-q', '--hard', shaTwo])
    await collect()

    expect((await git(['cat-file', '-e', doomed])).code).toBe(0)
  }, 60_000)

  test('dropping the pin lets the same collection reclaim the object', async () => {
    // Retention as an explicit delete rather than an accident of collection:
    // the object above outlived a prune, and the only thing that changed
    // between then and now is that its refs are gone.
    const result = await dropPinnedRefs({ runner, cwd: dir }, RETENTION_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.count).toBe(2)

    await collect()

    expect((await git(['cat-file', '-e', doomed])).code).not.toBe(0)
  }, 60_000)
})
