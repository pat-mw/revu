/**
 * The hardened git seam: ref normalization, the option-injection defense, and
 * repository-root discovery.
 *
 * The command runner takes an argv array with no shell, so shell injection is
 * impossible — and option injection is not. A ref beginning with `-` is read by
 * git as a flag: `--upload-pack=<cmd>` is argument-position code execution and
 * `--output=<path>` is an arbitrary file overwrite. `git check-ref-format`
 * accepts `refs/heads/--upload-pack=x` (exit 0), so it is not a defense against
 * any of that; the real defense is rejecting hostile shapes before anything is
 * spawned, and spawning only argv arrays where every rev sits behind
 * `--end-of-options` and every pathspec behind `--`.
 *
 * That end-to-end claim — a hostile ref never reaches a real git process — is
 * not provable by observation: spawning git with an attacker-shaped argument to
 * "see nothing happen" constructs the exploit, and no side effect being observed
 * is not evidence of absence for an overwrite or an exec. So this suite asserts
 * the seam instead, in three independently-failing layers:
 *
 *   1. a rejection table proving the runner is never called for a hostile input,
 *      with a paired positive control proving the same recording sink does fill
 *      for a legal name — so a fake wired to the wrong function cannot pass both;
 *   2. `isHardenedArgv` over every argv every exported function emits — no
 *      sampling — with the predicate's own rejection reasons each proved to fire
 *      independently;
 *   3. tripwires against real git pinning the documented facts the design leans
 *      on, so a future git that changes them turns this suite red instead of
 *      silently invalidating a comment.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BranchRef } from '@revu/shared'
import type { CommandResult, CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import type { FixtureRepo } from './local-fixture-repo'
import { createFixtureRepo } from './local-fixture-repo'
import { isHardenedArgv } from './local-git-argv'
import * as localGitArgvModule from './local-git-argv'
import type { RefKind, RefRejectionReason } from './local-git'
import {
  GIT_ARGV_BLOCKED,
  checkRefFormat,
  discoverRepoRoot,
  listBranches,
  normalizeRef,
  parseForEachRefZ,
  repoIdentity,
  runGit,
} from './local-git'
import * as localGitModule from './local-git'

/** A CommandRunner that returns one canned result and records the args it saw. */
function fakeRunner(result: Partial<CommandResult>, sink?: string[][]): CommandRunner {
  return {
    async run(args): Promise<CommandResult> {
      sink?.push(args)
      return { ok: true, code: 0, stdout: '', stderr: '', ...result }
    },
  }
}

/**
 * A CommandRunner that returns canned results in call order and records the args
 * it saw — the same recording shape as `fakeRunner`, for flows that make more
 * than one call with different outcomes (an origin read that fails, then a
 * toplevel read that succeeds).
 */
function fakeScriptRunner(results: Partial<CommandResult>[], sink?: string[][]): CommandRunner {
  let call = 0
  return {
    async run(args): Promise<CommandResult> {
      sink?.push(args)
      const result = results[call] ?? {}
      call += 1
      return { ok: true, code: 0, stdout: '', stderr: '', ...result }
    },
  }
}

/** Two distinct full-length hex object names for argv rows that need real shapes. */
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

type SeamOutcome =
  | { ok: true; ref: string }
  | { ok: false; reason: RefRejectionReason | 'malformed' }

/**
 * The composed flow a creation request goes through: normalize first, and only a
 * normalized ref may reach git for format validation. Both halves of the
 * injection proof drive this one function — the hostile rows assert the sink
 * stays empty, the legal row asserts the sink fills — so a normalization that
 * silently accepts a hostile shape and a validation step that never runs are
 * each caught by one side or the other.
 */
async function validateRef(
  runner: CommandRunner,
  cwd: string,
  input: string,
  kind: RefKind,
): Promise<SeamOutcome> {
  const normalized = normalizeRef(input, kind)
  if (!normalized.ok) return normalized
  const checked = await checkRefFormat(runner, cwd, normalized.ref)
  if (!checked.ok) return { ok: false, reason: 'malformed' }
  return { ok: true, ref: normalized.ref }
}

let fixture: FixtureRepo

/**
 * A repository that has been initialized and nothing else: no commit, and
 * therefore not one ref in either namespace. It is created after the fixture so
 * it inherits the fixture's pinned configuration paths, and it is a second
 * repository rather than a state of the first because the seeded one must keep
 * its branches for every other assertion here.
 */
let emptyRepoDir: string

beforeAll(async () => {
  fixture = await createFixtureRepo()
  emptyRepoDir = mkdtempSync(join(tmpdir(), 'revu-empty-repo-'))
  const init = await createBunCommandRunner().run(['git', 'init', '-q', '-b', 'main', emptyRepoDir])
  if (!init.ok) throw new Error(`the empty repository could not be initialized: ${init.stderr}`)
})

afterAll(() => {
  rmSync(emptyRepoDir, { recursive: true, force: true })
  fixture.dispose()
})

// ————————————————————————————————————————————————————————————————————————————
// Layer 1: the rejection table, and its paired positive control.
// ————————————————————————————————————————————————————————————————————————————

interface HostileRow {
  readonly input: string
  readonly reason: RefRejectionReason
  /** How the test names the row, since several inputs render invisibly. */
  readonly label: string
}

const HOSTILE_ROWS: readonly HostileRow[] = [
  { input: '--upload-pack=/bin/echo', reason: 'leading-dash', label: 'an upload-pack exec flag' },
  { input: '--output=/tmp/pwned', reason: 'leading-dash', label: 'an output overwrite flag' },
  { input: '-x', reason: 'leading-dash', label: 'a bare short flag' },
  { input: 'a..b', reason: 'dot-dot', label: 'a range expression' },
  { input: 'refs/heads/x..y', reason: 'dot-dot', label: 'a qualified range expression' },
  { input: '', reason: 'empty', label: 'an empty string' },
  { input: '  ', reason: 'whitespace', label: 'a whitespace-only string' },
  { input: 'a\nb', reason: 'control-character', label: 'an embedded newline' },
  { input: 'a\tb', reason: 'control-character', label: 'an embedded tab' },
  { input: 'a\x07b', reason: 'control-character', label: 'an embedded control byte' },
  { input: 'a b', reason: 'whitespace', label: 'an embedded space' },
]

describe('a hostile ref is rejected before anything can be spawned', () => {
  for (const row of HOSTILE_ROWS) {
    test(`${row.label} is rejected as ${row.reason} and the runner is never called`, async () => {
      const sink: string[][] = []
      const outcome = await validateRef(fakeRunner({}, sink), '/repo', row.input, 'branch')
      expect(outcome).toEqual({ ok: false, reason: row.reason })
      expect(sink).toEqual([])
    })
  }

  test('the eleven hostile rows exercise exactly five distinct rejection rules', () => {
    // The table deliberately carries more rows than rules: three flag spellings
    // share `leading-dash`, both range spellings share `dot-dot`, and the three
    // control bytes share one rule, so the subsumption is pinned here rather
    // than left to read as eleven independent defenses.
    const byReason: Record<string, number> = {}
    for (const row of HOSTILE_ROWS) {
      const outcome = normalizeRef(row.input, 'branch')
      if (outcome.ok) throw new Error(`hostile row unexpectedly accepted: ${row.label}`)
      byReason[outcome.reason] = (byReason[outcome.reason] ?? 0) + 1
    }
    expect(byReason).toEqual({
      'leading-dash': 3,
      'dot-dot': 2,
      empty: 1,
      whitespace: 2,
      'control-character': 3,
    })
  })

  test('a legal branch name reaches git through the same seam', async () => {
    // The positive control for every empty-sink assertion above: the identical
    // composed flow, the identical recording runner shape, a legal name — and
    // the sink must fill. A validateRef that never calls git fails here; a
    // normalizeRef that admits a hostile shape fails the rows above.
    const sink: string[][] = []
    const outcome = await validateRef(fakeRunner({}, sink), '/repo', 'feature/x', 'branch')
    expect(outcome).toEqual({ ok: true, ref: 'refs/heads/feature/x' })
    expect(sink.length).toBeGreaterThan(0)
    expect(sink[0]?.[0]).toBe('git')
    expect(sink[0]).toEqual(['git', 'check-ref-format', 'refs/heads/feature/x'])
  })

  test('a rejected output-overwrite payload names a path that never comes to exist', async () => {
    const payloadPath = join(fixture.dir, 'pwned-by-output')
    // Control first: prove the existence probe can report true at this exact
    // path, so the absence assertion below is not a typo'd path asserted absent.
    writeFileSync(payloadPath, 'existence-probe control')
    expect(existsSync(payloadPath)).toBe(true)
    rmSync(payloadPath)
    const sink: string[][] = []
    const outcome = await validateRef(
      fakeRunner({}, sink),
      fixture.dir,
      `--output=${payloadPath}`,
      'branch',
    )
    expect(outcome).toEqual({ ok: false, reason: 'leading-dash' })
    expect(sink).toEqual([])
    expect(existsSync(payloadPath)).toBe(false)
  })

  test('the exec payload with an embedded space is rejected on its first hostile trait', async () => {
    const sink: string[][] = []
    const outcome = await validateRef(
      fakeRunner({}, sink),
      '/repo',
      '--upload-pack=/bin/echo pwned',
      'branch',
    )
    expect(outcome).toEqual({ ok: false, reason: 'leading-dash' })
    expect(sink).toEqual([])
  })
})

describe('normalizeRef qualifies well-formed names', () => {
  test('a short branch name gains the heads namespace', () => {
    expect(normalizeRef('main', 'branch')).toEqual({ ok: true, ref: 'refs/heads/main' })
  })

  test('a slashed branch name gains the heads namespace once', () => {
    expect(normalizeRef('feature/x', 'branch')).toEqual({ ok: true, ref: 'refs/heads/feature/x' })
  })

  test('a remote-tracking name gains the remotes namespace', () => {
    expect(normalizeRef('origin/main', 'remote')).toEqual({
      ok: true,
      ref: 'refs/remotes/origin/main',
    })
  })

  test('an already-qualified name in its own namespace passes through byte-identical', () => {
    expect(normalizeRef('refs/heads/main', 'branch')).toEqual({ ok: true, ref: 'refs/heads/main' })
    expect(normalizeRef('refs/remotes/origin/main', 'remote')).toEqual({
      ok: true,
      ref: 'refs/remotes/origin/main',
    })
  })

  test('a name qualified under a different namespace is rejected, not double-prefixed', () => {
    // Blindly prefixing `refs/remotes/origin/main` as a branch would produce
    // `refs/heads/refs/remotes/origin/main` — a legal ref name that silently
    // points at nothing the caller meant.
    expect(normalizeRef('refs/remotes/origin/main', 'branch')).toEqual({
      ok: false,
      reason: 'foreign-namespace',
    })
    expect(normalizeRef('refs/heads/main', 'remote')).toEqual({
      ok: false,
      reason: 'foreign-namespace',
    })
    expect(normalizeRef('refs/tags/v1', 'branch')).toEqual({
      ok: false,
      reason: 'foreign-namespace',
    })
  })
})

describe('checkRefFormat refuses to spawn for an unqualified argument', () => {
  test('a dash-leading name is blocked before the runner, not handed to git as an option', async () => {
    const sink: string[][] = []
    const result = await checkRefFormat(fakeRunner({}, sink), '/repo', '-dash')
    expect(result.ok).toBe(false)
    expect(result.code).toBe(GIT_ARGV_BLOCKED)
    expect(sink).toEqual([])
  })

  test('a short name is blocked before the runner', async () => {
    const sink: string[][] = []
    const result = await checkRefFormat(fakeRunner({}, sink), '/repo', 'main')
    expect(result.code).toBe(GIT_ARGV_BLOCKED)
    expect(sink).toEqual([])
  })

  test('a qualified but malformed ref is judged by real git via its exit code', async () => {
    const result = await checkRefFormat(createBunCommandRunner(), fixture.dir, 'refs/heads/x..y')
    expect(result.ok).toBe(false)
    expect(result.code).toBe(1)
  })

  test('a qualified legal ref is accepted by real git', async () => {
    const result = await checkRefFormat(
      createBunCommandRunner(),
      fixture.dir,
      'refs/heads/feature/x',
    )
    expect(result.ok).toBe(true)
    expect(result.code).toBe(0)
  })
})

// ————————————————————————————————————————————————————————————————————————————
// Layer 2: the argv predicate, and the hardened form on every captured argv.
// ————————————————————————————————————————————————————————————————————————————

describe('runGit constructs the hardened argv', () => {
  test('revs sit behind --end-of-options and pathspecs behind --', async () => {
    const sink: string[][] = []
    await runGit(fakeRunner({}, sink), '/repo', {
      args: ['diff', '--raw', '--no-abbrev', '-M', '-z'],
      revs: [SHA_A, SHA_B],
      pathspecs: ['src/a.txt'],
    })
    expect(sink[0]).toEqual([
      'git',
      'diff',
      '--raw',
      '--no-abbrev',
      '-M',
      '-z',
      '--end-of-options',
      SHA_A,
      SHA_B,
      '--',
      'src/a.txt',
    ])
  })

  test('a command with no operands is prepended with git and nothing else', async () => {
    const sink: string[][] = []
    await runGit(fakeRunner({}, sink), '/repo', { args: ['rev-parse', '--show-toplevel'] })
    expect(sink[0]).toEqual(['git', 'rev-parse', '--show-toplevel'])
  })

  test('the cwd is threaded to the runner, never defaulted', async () => {
    let seenCwd: string | undefined
    const runner: CommandRunner = {
      async run(_args, opts): Promise<CommandResult> {
        seenCwd = opts?.cwd
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
    }
    await runGit(runner, '/somewhere/specific', { args: ['rev-parse', '--show-toplevel'] })
    expect(seenCwd).toBe('/somewhere/specific')
  })

  test('the runner result passes through untouched on success', async () => {
    const result = await runGit(fakeRunner({ ok: true, code: 0, stdout: 'payload\n' }), '/repo', {
      args: ['rev-parse', '--show-toplevel'],
    })
    expect(result).toEqual({ ok: true, code: 0, stdout: 'payload\n', stderr: '' })
  })

  test('a dash-leading rev is blocked before the runner', async () => {
    const sink: string[][] = []
    const result = await runGit(fakeRunner({}, sink), '/repo', {
      args: ['rev-parse', '--verify'],
      revs: ['--upload-pack=/bin/echo'],
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe(GIT_ARGV_BLOCKED)
    expect(sink).toEqual([])
  })

  test('a path-shaped operand in the rev slot is blocked before the runner', async () => {
    const sink: string[][] = []
    const result = await runGit(fakeRunner({}, sink), '/repo', {
      args: ['diff'],
      revs: ['src/evil.txt'],
    })
    expect(result.code).toBe(GIT_ARGV_BLOCKED)
    expect(sink).toEqual([])
  })

  test('a qualified ref resolves against real git through the full pipeline', async () => {
    const normalized = normalizeRef(fixture.headBranch, 'branch')
    if (!normalized.ok) throw new Error('the fixture head branch must normalize')
    const result = await runGit(createBunCommandRunner(), fixture.dir, {
      args: ['rev-parse', '--verify'],
      revs: [normalized.ref],
    })
    expect(result.ok).toBe(true)
    expect(result.stdout.trim()).toBe(fixture.headSha)
  })
})

describe('isHardenedArgv accepts the hardened forms', () => {
  const ACCEPTED: readonly { label: string; argv: string[] }[] = [
    {
      label: 'a verify with its rev behind the marker',
      argv: ['git', 'rev-parse', '--verify', '--end-of-options', 'refs/heads/main'],
    },
    {
      label: 'a diff with config pairs, flags, revs and a pathspec each in place',
      argv: [
        'git',
        '-c',
        'core.quotePath=false',
        'diff',
        '--raw',
        '--no-abbrev',
        '-M',
        '-z',
        '--end-of-options',
        SHA_A,
        SHA_B,
        '--',
        'src/a.txt',
      ],
    },
    {
      label: 'a log over a range expression behind the marker',
      argv: ['git', 'log', '--format=%H', '--end-of-options', `${SHA_A}..${SHA_B}`],
    },
    {
      label: 'a command with word operands and no revs at all',
      argv: ['git', 'remote', 'get-url', 'origin'],
    },
    {
      label: 'a command with no operands at all',
      argv: ['git', 'rev-parse', '--show-toplevel'],
    },
    {
      label: 'the format check in its only spawnable safe shape',
      argv: ['git', 'check-ref-format', 'refs/heads/--upload-pack=x'],
    },
  ]

  for (const row of ACCEPTED) {
    test(row.label, () => {
      expect(isHardenedArgv(row.argv)).toEqual({ ok: true })
    })
  }
})

describe('each of the four rejection reasons fires independently', () => {
  // Every row below is hardened in all respects but one, so the asserted reason
  // is the only rule that can explain the rejection — a predicate where one
  // reachable reason shadows the others cannot pass this table.
  test('an argv that does not invoke git', () => {
    expect(isHardenedArgv(['rev-parse', '--verify', '--end-of-options', 'refs/heads/main'])).toEqual(
      {
        ok: false,
        reason: 'argv must invoke "git", not "rev-parse"',
      },
    )
  })

  test('an empty argv', () => {
    expect(isHardenedArgv([])).toEqual({ ok: false, reason: 'argv must invoke "git", not ""' })
  })

  test('a qualified ref not preceded by the end-of-options marker', () => {
    expect(isHardenedArgv(['git', 'rev-parse', '--verify', 'refs/heads/main'])).toEqual({
      ok: false,
      reason: 'rev argument "refs/heads/main" is not preceded by --end-of-options',
    })
  })

  test('an object name not preceded by the end-of-options marker', () => {
    expect(isHardenedArgv(['git', 'merge-base', SHA_A, SHA_B])).toEqual({
      ok: false,
      reason: `rev argument "${SHA_A}" is not preceded by --end-of-options`,
    })
  })

  test('a pathspec in the rev region, not preceded by the pathspec separator', () => {
    expect(isHardenedArgv(['git', 'diff', '--end-of-options', SHA_A, 'src/a.txt'])).toEqual({
      ok: false,
      reason: 'pathspec "src/a.txt" must be preceded by "--"',
    })
  })

  test('an option-shaped token after the marker is an operand and must not be there', () => {
    expect(isHardenedArgv(['git', 'diff', '--end-of-options', '-M', SHA_A])).toEqual({
      ok: false,
      reason: 'pathspec "-M" must be preceded by "--"',
    })
  })

  test('a format check whose argument could be read as an option', () => {
    expect(isHardenedArgv(['git', 'check-ref-format', '-dash'])).toEqual({
      ok: false,
      reason:
        'check-ref-format accepts no --end-of-options, so every argument must be refs/-qualified; got "-dash"',
    })
  })

  test('a format check with an unqualified word argument', () => {
    expect(isHardenedArgv(['git', 'check-ref-format', 'main'])).toEqual({
      ok: false,
      reason:
        'check-ref-format accepts no --end-of-options, so every argument must be refs/-qualified; got "main"',
    })
  })

  test('the reason vocabulary has exactly four members and all four were observed', () => {
    const observed = new Set(
      [
        isHardenedArgv(['rev-parse']),
        isHardenedArgv(['git', 'rev-parse', '--verify', 'refs/heads/main']),
        isHardenedArgv(['git', 'diff', '--end-of-options', SHA_A, 'src/a.txt']),
        isHardenedArgv(['git', 'check-ref-format', '-dash']),
      ].map((verdict) => (verdict.ok ? 'accepted' : verdict.reason.split(' ')[0])),
    )
    // Four distinct leading words, one per rule: the executable rule, the rev
    // rule, the pathspec rule, and the format-check rule.
    expect([...observed].sort()).toEqual(['argv', 'check-ref-format', 'pathspec', 'rev'])
  })
})

describe('every argv the exported seam emits satisfies the predicate', () => {
  test('the captured argv of every runner-taking export is hardened — no sampling', async () => {
    const sink: string[][] = []
    await checkRefFormat(fakeRunner({}, sink), '/repo', 'refs/heads/main')
    await runGit(fakeRunner({}, sink), '/repo', {
      args: ['diff', '--raw', '--no-abbrev', '-M', '-z'],
      revs: [SHA_A, SHA_B],
      pathspecs: ['src/a.txt'],
    })
    await discoverRepoRoot(fakeRunner({ ok: true, code: 0, stdout: '/x/y\n' }, sink), '/repo')
    await repoIdentity(
      fakeScriptRunner(
        [{ ok: true, code: 0, stdout: 'https://github.com/acme/revu.git\n' }],
        sink,
      ),
      '/repo',
    )
    await repoIdentity(
      fakeScriptRunner(
        [
          { ok: false, code: 2, stderr: '' },
          { ok: true, code: 0, stdout: '/x/y\n' },
        ],
        sink,
      ),
      '/repo',
    )
    await listBranches(fakeRunner({ ok: true, code: 0, stdout: '' }, sink), '/repo')
    // The independent literal that keeps this sweep honest: six drives produce
    // exactly eight spawned commands (the identity fallback spawns twice, and
    // the branch listing spawns the namespace read and the default-branch probe).
    // A drive that silently stopped calling the runner shrinks this count.
    expect(sink).toHaveLength(8)
    for (const args of sink) {
      expect(isHardenedArgv(args)).toEqual({ ok: true })
    }
  })

  test('the seam module exports exactly the surface this suite drives', () => {
    // A new export must be added to the sweep above by hand; this pin is what
    // forces that, since a function this list does not name cannot appear here
    // without the assertion going red.
    expect(Object.keys(localGitModule).sort()).toEqual([
      'GIT_ARGV_BLOCKED',
      'checkRefFormat',
      'discoverRepoRoot',
      'listBranches',
      'normalizeRef',
      'parseForEachRefZ',
      'repoIdentity',
      'runGit',
    ])
  })

  test('the predicate module exports exactly the predicate', () => {
    expect(Object.keys(localGitArgvModule).sort()).toEqual(['isHardenedArgv'])
  })
})

// ————————————————————————————————————————————————————————————————————————————
// Layer 3: tripwires against real git for the documented facts the seam leans on.
// ————————————————————————————————————————————————————————————————————————————

describe('the documented git facts still hold', () => {
  test('check-ref-format accepts a ref spelling an exec flag, so it is no injection defense', async () => {
    const result = await createBunCommandRunner().run([
      'git',
      'check-ref-format',
      'refs/heads/--upload-pack=x',
    ])
    expect(result.code).toBe(0)
  })

  test('check-ref-format reads a dash-leading argument as an option, not as an invalid ref', async () => {
    // Exit 129 is a usage error: git consumed the argument as a flag. It fails
    // closed, but for the wrong reason, and must never be read as "rejected as
    // an invalid ref name".
    const result = await createBunCommandRunner().run([
      'git',
      'check-ref-format',
      '--allow-onelevel',
      '-dash',
    ])
    expect(result.code).toBe(129)
  })

  test('check-ref-format does not implement the end-of-options marker', async () => {
    // This is why the predicate carries a dedicated rule for this subcommand:
    // its only spawnable safe shape is a refs/-qualified operand with no marker.
    // A future git that learns the marker turns this red, and the dedicated
    // rule can then be retired deliberately.
    const result = await createBunCommandRunner().run([
      'git',
      'check-ref-format',
      '--end-of-options',
      'refs/heads/main',
    ])
    expect(result.code).toBe(129)
  })
})

// ————————————————————————————————————————————————————————————————————————————
// Repo root discovery and repository identity.
// ————————————————————————————————————————————————————————————————————————————

describe('discoverRepoRoot', () => {
  test('trims the toplevel git prints', async () => {
    const result = await discoverRepoRoot(fakeRunner({ ok: true, code: 0, stdout: '/x/y\n' }), '/x')
    expect(result).toEqual({ ok: true, root: '/x/y' })
  })

  test('a non-zero exit is a typed failure carrying the code, never a fallback directory', async () => {
    const result = await discoverRepoRoot(
      fakeRunner({ ok: false, code: 128, stderr: '' }),
      '/not-a-repo',
    )
    expect(result).toEqual({ ok: false, code: 128 })
  })

  test('a clean exit with empty output is a failure, not an empty root', async () => {
    const result = await discoverRepoRoot(fakeRunner({ ok: true, code: 0, stdout: '' }), '/x')
    expect(result).toEqual({ ok: false, code: 0 })
  })

  test('resolves the fixture toplevel from the toplevel itself', async () => {
    const result = await discoverRepoRoot(createBunCommandRunner(), fixture.dir)
    expect(result).toEqual({ ok: true, root: fixture.dir })
  })

  test('resolves the fixture toplevel from a subdirectory', async () => {
    const result = await discoverRepoRoot(createBunCommandRunner(), join(fixture.dir, 'src'))
    expect(result).toEqual({ ok: true, root: fixture.dir })
  })
})

describe('repoIdentity', () => {
  test('a parseable origin yields owner/name', async () => {
    const result = await repoIdentity(
      fakeScriptRunner([{ ok: true, code: 0, stdout: 'https://github.com/acme/revu.git\n' }]),
      '/repo',
    )
    expect(result).toEqual({ ok: true, identity: 'acme/revu', source: 'origin' })
    if (result.ok) expect(result.identity.length).toBeGreaterThan(0)
  })

  test('a missing origin falls back to the discovered toplevel, byte-equal', async () => {
    // Byte-equality against the known root is what pins "never a hash": a
    // digested or re-encoded identity could not compare equal to the path.
    const result = await repoIdentity(
      fakeScriptRunner([
        { ok: false, code: 2, stderr: '' },
        { ok: true, code: 0, stdout: '/known/root\n' },
      ]),
      '/known/root',
    )
    expect(result).toEqual({ ok: true, identity: '/known/root', source: 'root' })
    if (result.ok) expect(result.identity.length).toBeGreaterThan(0)
  })

  test('an unparseable origin also falls back to the discovered toplevel', async () => {
    const result = await repoIdentity(
      fakeScriptRunner([
        { ok: true, code: 0, stdout: 'https://gitlab.example/acme/revu.git\n' },
        { ok: true, code: 0, stdout: '/known/root\n' },
      ]),
      '/known/root',
    )
    expect(result).toEqual({ ok: true, identity: '/known/root', source: 'root' })
  })

  test('no origin and no repository is a typed failure, never an empty identity', async () => {
    const result = await repoIdentity(
      fakeScriptRunner([
        { ok: false, code: 2, stderr: '' },
        { ok: false, code: 128, stderr: '' },
      ]),
      '/nowhere',
    )
    expect(result).toEqual({ ok: false, code: 128 })
  })

  test('the fixture repo, which has no origin, keys on its resolved toplevel', async () => {
    const result = await repoIdentity(createBunCommandRunner(), fixture.dir)
    expect(result).toEqual({ ok: true, identity: fixture.dir, source: 'root' })
  })
})

// ————————————————————————————————————————————————————————————————————————————
// The branch listing the review-side pickers read.
// ————————————————————————————————————————————————————————————————————————————

/**
 * The only command shape the listing may take, restated here as an independent
 * literal rather than read back out of the module. The whole array is asserted
 * because a silently dropped `--format` would hand the parser git's own default
 * output — a different, unrequested shape that this seam never agreed to parse —
 * and an assertion that merely looked for the two namespaces would not notice.
 */
const FOR_EACH_REF_ARGV = [
  'git',
  'for-each-ref',
  '--format=%(refname)%00%(objectname)%00%(HEAD)',
  '--end-of-options',
  'refs/heads',
  'refs/remotes',
]

/**
 * The probe the default-branch marker comes from. `--quiet` is what turns an
 * absent symbolic ref into a plain non-zero exit with no diagnostic, which is
 * the ordinary state of a repository that has no remote at all.
 */
const SYMBOLIC_REF_ARGV = [
  'git',
  'symbolic-ref',
  '--quiet',
  '--end-of-options',
  'refs/remotes/origin/HEAD',
]

/** A listing carrying both namespaces, the symbolic ref, and a checked-out branch. */
const TWO_NAMESPACE_LISTING =
  `refs/heads/feature/x\0${SHA_A}\0 \n` +
  `refs/heads/main\0${SHA_B}\0*\n` +
  `refs/remotes/origin/HEAD\0${SHA_B}\0 \n` +
  `refs/remotes/origin/main\0${SHA_B}\0 \n`

/** What `TWO_NAMESPACE_LISTING` parses to before any default marker is applied. */
const TWO_NAMESPACE_BRANCHES: BranchRef[] = [
  { ref: 'refs/heads/feature/x', name: 'feature/x', kind: 'local', isDefault: false },
  { ref: 'refs/heads/main', name: 'main', kind: 'local', isDefault: false },
  { ref: 'refs/remotes/origin/main', name: 'origin/main', kind: 'remote', isDefault: false },
]

describe('the branch listing reads both namespaces in one hardened command', () => {
  async function captureListing(): Promise<string[][]> {
    const sink: string[][] = []
    await listBranches(fakeRunner({ ok: true, code: 0, stdout: '' }, sink), '/repo')
    return sink
  }

  test('the namespace read is exactly the format-pinned command', async () => {
    expect((await captureListing())[0]).toEqual(FOR_EACH_REF_ARGV)
  })

  test('the namespace read is in the hardened argv form', async () => {
    expect(isHardenedArgv((await captureListing())[0])).toEqual({ ok: true })
  })

  test('the default-branch probe is exactly the quiet symbolic-ref read', async () => {
    expect((await captureListing())[1]).toEqual(SYMBOLIC_REF_ARGV)
  })

  test('the default-branch probe is in the hardened argv form', async () => {
    expect(isHardenedArgv((await captureListing())[1])).toEqual({ ok: true })
  })

  test('the listing spawns those two commands and nothing else', async () => {
    expect(await captureListing()).toHaveLength(2)
  })

  test('the cwd is threaded to both commands', async () => {
    const seen: (string | undefined)[] = []
    const runner: CommandRunner = {
      async run(_args, opts): Promise<CommandResult> {
        seen.push(opts?.cwd)
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
    }
    await listBranches(runner, '/somewhere/specific')
    expect(seen).toEqual(['/somewhere/specific', '/somewhere/specific'])
  })
})

interface ForEachRefRow {
  readonly label: string
  readonly stdout: string
  readonly expected: BranchRef[]
}

/**
 * One row per shape the record stream can take. Every row asserts the whole
 * parsed array, so a row proves what is produced as well as what is dropped.
 *
 * The symbolic ref `refs/remotes/<remote>/HEAD` is excluded because it is not a
 * branch: it points at whichever remote-tracking branch the remote calls its
 * default, so offering it would put a second, differently-spelled copy of that
 * branch in the picker — one that silently follows the remote if the default
 * ever changes. The default it names is read separately, as a marker on the
 * branch itself.
 */
const PARSE_ROWS: readonly ForEachRefRow[] = [
  {
    label: 'a local branch, a remote-tracking branch and the remote HEAD symref yield two branches',
    stdout:
      `refs/heads/main\0${SHA_A}\0*\n` +
      `refs/remotes/origin/HEAD\0${SHA_B}\0 \n` +
      `refs/remotes/origin/main\0${SHA_B}\0 \n`,
    expected: [
      { ref: 'refs/heads/main', name: 'main', kind: 'local', isDefault: false },
      { ref: 'refs/remotes/origin/main', name: 'origin/main', kind: 'remote', isDefault: false },
    ],
  },
  {
    label: 'the remote HEAD symref on its own yields nothing',
    stdout: `refs/remotes/origin/HEAD\0${SHA_B}\0 \n`,
    expected: [],
  },
  {
    label: 'a remote branch whose name merely begins with HEAD is kept',
    stdout: `refs/remotes/origin/HEADless\0${SHA_A}\0 \n`,
    expected: [
      {
        ref: 'refs/remotes/origin/HEADless',
        name: 'origin/HEADless',
        kind: 'remote',
        isDefault: false,
      },
    ],
  },
  {
    label: 'a remote branch named HEAD below a further segment is kept',
    stdout: `refs/remotes/origin/feature/HEAD\0${SHA_A}\0 \n`,
    expected: [
      {
        ref: 'refs/remotes/origin/feature/HEAD',
        name: 'origin/feature/HEAD',
        kind: 'remote',
        isDefault: false,
      },
    ],
  },
  {
    label: 'a local branch literally named HEAD is kept',
    stdout: `refs/heads/HEAD\0${SHA_A}\0 \n`,
    expected: [{ ref: 'refs/heads/HEAD', name: 'HEAD', kind: 'local', isDefault: false }],
  },
  {
    label: 'a local branch named HEAD at the same depth as the symref is kept',
    // The row that anchors the exclusion to the remotes namespace: this ref has
    // the same segment count and the same last segment as the symbolic ref, and
    // differs from it only by the namespace it lives in.
    stdout: `refs/heads/feature/HEAD\0${SHA_A}\0 \n`,
    expected: [
      { ref: 'refs/heads/feature/HEAD', name: 'feature/HEAD', kind: 'local', isDefault: false },
    ],
  },
  {
    label: 'a ref in neither branch namespace is not a branch',
    stdout: `refs/tags/v1\0${SHA_A}\0 \n`,
    expected: [],
  },
  {
    label: 'empty output yields an empty listing',
    stdout: '',
    expected: [],
  },
  {
    label: 'a final record with no trailing newline is not lost',
    stdout: `refs/heads/main\0${SHA_A}\0*`,
    expected: [{ ref: 'refs/heads/main', name: 'main', kind: 'local', isDefault: false }],
  },
  {
    label: "git's own default output carries no NUL fields and yields nothing",
    stdout: `${SHA_A} commit\trefs/heads/main\n${SHA_B} commit\trefs/remotes/origin/main\n`,
    expected: [],
  },
  {
    label: 'a record carrying only the ref name is not the requested format and yields nothing',
    // The shape a reduced format would produce. Its refname is in the right
    // namespace and would parse perfectly well, which is exactly why the record
    // shape has to be checked rather than assumed: a stream this parser did not
    // ask for is not guessed at, whatever it happens to contain.
    stdout: 'refs/heads/main\n',
    expected: [],
  },
  {
    label: 'a record carrying an extra field is not the requested format either',
    // The other side of the record-shape check. Without this row the count
    // could be a lower bound and nothing would say so, since the requested
    // format cannot itself produce a longer record.
    stdout: `refs/heads/main\0${SHA_A}\0*\0extra\n`,
    expected: [],
  },
]

describe('parseForEachRefZ reads the records on their NUL boundaries', () => {
  for (const row of PARSE_ROWS) {
    test(row.label, () => {
      expect(parseForEachRefZ(row.stdout)).toEqual(row.expected)
    })
  }

  test('the listing a two-namespace read produces carries the namespace on every entry', () => {
    expect(parseForEachRefZ(TWO_NAMESPACE_LISTING)).toEqual(TWO_NAMESPACE_BRANCHES)
  })
})

describe('the default-branch marker comes from the remote HEAD symref', () => {
  async function listWith(marker: Partial<CommandResult>): Promise<BranchRef[]> {
    return listBranches(
      fakeScriptRunner([{ ok: true, code: 0, stdout: TWO_NAMESPACE_LISTING }, marker]),
      '/repo',
    )
  }

  test('the branch the symref names is marked, and the remote copy of it is not', async () => {
    // The positive control for every "no marker" assertion below: the same
    // listing, the same code path, a symref that resolves — and the marker
    // appears. A builder that never sets the field cannot pass this row.
    expect(await listWith({ ok: true, code: 0, stdout: 'refs/remotes/origin/main\n' })).toEqual([
      { ref: 'refs/heads/feature/x', name: 'feature/x', kind: 'local', isDefault: false },
      { ref: 'refs/heads/main', name: 'main', kind: 'local', isDefault: true },
      { ref: 'refs/remotes/origin/main', name: 'origin/main', kind: 'remote', isDefault: false },
    ])
  })

  test('exactly one entry is marked', async () => {
    const branches = await listWith({ ok: true, code: 0, stdout: 'refs/remotes/origin/main\n' })
    expect(branches.filter((branch) => branch.isDefault)).toHaveLength(1)
  })

  test('a repository with no remote HEAD symref carries no marker at all', async () => {
    // Empty stderr is load-bearing: an implementation that decided what this
    // exit meant by reading its diagnostic text could not pass this row.
    const branches = await listWith({ ok: false, code: 1, stdout: '', stderr: '' })
    expect(branches.filter((branch) => branch.isDefault)).toEqual([])
  })

  test('the listing itself survives an absent symref unchanged', async () => {
    expect(await listWith({ ok: false, code: 1, stdout: '', stderr: '' })).toEqual(
      TWO_NAMESPACE_BRANCHES,
    )
  })

  test('a symref naming a branch the listing does not carry marks nothing', async () => {
    const branches = await listWith({ ok: true, code: 0, stdout: 'refs/remotes/origin/trunk\n' })
    expect(branches.filter((branch) => branch.isDefault)).toEqual([])
  })

  test('a probe that could not be spawned at all degrades to no marker', async () => {
    // The runner reports an unspawnable executable as a negative code rather
    // than a rejection, so this is the same non-zero path as an absent symref
    // and must degrade identically rather than fail the listing.
    const branches = await listWith({ ok: false, code: -1, stdout: '', stderr: '' })
    expect(branches.filter((branch) => branch.isDefault)).toEqual([])
  })

  test('a probe that succeeds with empty output marks nothing', async () => {
    const branches = await listWith({ ok: true, code: 0, stdout: '' })
    expect(branches.filter((branch) => branch.isDefault)).toEqual([])
  })
})

describe('a failed namespace read is a failure, never an empty listing', () => {
  test('a non-zero exit rejects rather than reporting a repository with no branches', async () => {
    await expect(
      listBranches(fakeRunner({ ok: false, code: 128, stdout: '', stderr: '' }), '/not-a-repo'),
    ).rejects.toThrow()
  })

  test('nothing further is spawned once the namespace read has failed', async () => {
    const sink: string[][] = []
    await listBranches(
      fakeRunner({ ok: false, code: 128, stdout: '', stderr: '' }, sink),
      '/not-a-repo',
    ).catch(() => undefined)
    expect(sink).toHaveLength(1)
  })
})

describe('listBranches against real repositories', () => {
  test('the seeded repository offers both of its local branches, fully qualified', async () => {
    expect(await listBranches(createBunCommandRunner(), fixture.dir)).toEqual([
      {
        ref: `refs/heads/${fixture.headBranch}`,
        name: fixture.headBranch,
        kind: 'local',
        isDefault: false,
      },
      {
        ref: `refs/heads/${fixture.baseBranch}`,
        name: fixture.baseBranch,
        kind: 'local',
        isDefault: false,
      },
    ])
  })

  test('a repository with no remote offers no remote-tracking ref', async () => {
    const branches = await listBranches(createBunCommandRunner(), fixture.dir)
    expect(branches.filter((branch) => branch.kind === 'remote')).toEqual([])
  })

  test('the unmarked listing is caused by an absent symref, not by an unset field', async () => {
    // The accompanying control for the unmarked fixture listing above. Without
    // it, "no branch is marked" is equally satisfied by a builder that never
    // marks anything at all; with it, the marker's only input is proved absent
    // in this repository by the very probe the builder runs.
    const probe = await createBunCommandRunner().run(SYMBOLIC_REF_ARGV, { cwd: fixture.dir })
    expect(probe.code).toBe(1)
  })

  test('a repository with no commits and no branches resolves to an empty listing', async () => {
    // The resolve form, so a throw fails this test rather than escaping as an
    // unhandled rejection the runner might report somewhere else entirely.
    await expect(listBranches(createBunCommandRunner(), emptyRepoDir)).resolves.toEqual([])
  })

  test('that empty listing is a clean read of a repository with no refs', async () => {
    // Distinguishes "empty because there is nothing to list" from "empty
    // because the read failed and the failure was swallowed".
    const probe = await createBunCommandRunner().run(FOR_EACH_REF_ARGV, { cwd: emptyRepoDir })
    expect(probe).toEqual({ ok: true, code: 0, stdout: '', stderr: '' })
  })
})

// ————————————————————————————————————————————————————————————————————————————
// Source assertions: no undiscovered working directory on the local modules.
// ————————————————————————————————————————————————————————————————————————————

/**
 * Every non-test module whose name marks it as part of the local review path is
 * scanned, except the fixture harness, which is test support: it builds its own
 * temp directory, never serves a request, and is named here explicitly so its
 * exemption is a decision rather than a filter accident. The pure argv predicate
 * is included even though it spawns nothing — scanning a module that cannot need
 * a working directory costs nothing and keeps the membership rule mechanical.
 */
const CWD_SCANNED_MODULES = ['local-git-argv.ts', 'local-git.ts', 'local-sync.ts'] as const

const CWD_PATTERN = /process\.cwd/

function qualifyingLocalModules(): string[] {
  return readdirSync(fileURLToPath(new URL('.', import.meta.url)))
    .filter((name) => name.startsWith('local-'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => name !== 'local-fixture-repo.ts')
    .sort()
}

describe('no local module reaches for an undiscovered working directory', () => {
  test('the scanned list covers every qualifying module actually present', () => {
    // The coverage guard: a new local module appearing in this directory turns
    // this red until it is added to the scanned list above, so the scan can
    // never silently exclude the module that most needs it.
    expect(qualifyingLocalModules()).toEqual([...CWD_SCANNED_MODULES])
  })

  test('the scanned scope contains the seam module itself', () => {
    expect(qualifyingLocalModules()).toContain('local-git.ts')
  })

  test('the pattern can fire on the construct it bans', () => {
    expect('const cwd = opts.cwd ?? process.cwd()').toMatch(CWD_PATTERN)
  })

  for (const module of CWD_SCANNED_MODULES) {
    test(`${module} contains no undiscovered working directory read`, () => {
      const source = readFileSync(new URL(`./${module}`, import.meta.url), 'utf8')
      expect(source).not.toMatch(CWD_PATTERN)
    })
  }
})
