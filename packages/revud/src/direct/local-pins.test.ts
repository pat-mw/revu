/**
 * The pin seam: the ref names a local review's objects are held alive by, and
 * the single batched write that creates them.
 *
 * Three of this suite's claims are facts about real git rather than about this
 * module, and all three are load-bearing enough that a future git changing one
 * must turn this file red rather than silently invalidate a comment:
 *
 *   1. a ref name containing `..` is rejected outright, so the design's literal
 *      `refs/revu/reviews/<id>/<compareKey>` form **cannot be created** — a
 *      compare key is `<mergeBase>...<head>` and carries three dots;
 *   2. `git update-ref --stdin` applies its batch atomically, so one invocation
 *      either writes both pins or writes neither;
 *   3. two separate `git update-ref` invocations do **not** have that property —
 *      the first survives the second's failure, which is the half-pin this
 *      module exists to make impossible.
 *
 * Fact 3 is asserted here even though this module never writes a pin that way,
 * because it is the entire justification for the `--stdin` batch. Without it the
 * batch reads as a stylistic choice and a later editor may reasonably unroll it
 * into two calls; with it, unrolling turns this file red.
 *
 * The rejection legs assert an **absence** — that nothing was spawned — so each
 * is paired with a positive control driving the same recording sink, because an
 * empty sink and a sink wired to nothing are otherwise indistinguishable.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import type { CommandResult, CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import { isHardenedArgv } from './local-git-argv'
import { checkRefFormat } from './local-git'
import { listPins, pinKeyForCompare, pinRefsFor, pinSnapshotObjects } from './local-pins'

/** A local id inside the reserved band, used wherever a valid id is needed. */
const LOCAL_ID = 1_000_000_001
/** A second one, so "the other review's pins survived" is assertable. */
const OTHER_LOCAL_ID = 1_000_000_002

/** Forty hex characters — the shape a resolved sha1 object name arrives in. */
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

/**
 * A `CommandRunner` that records every argv and stdin it is handed and answers
 * from a caller-supplied reply. The sink is the evidence for both the rejection
 * legs (it must stay empty) and their controls (it must fill), so one recorder
 * serves both and neither can pass by being wired to nothing.
 */
function recordingRunner(
  reply: (args: readonly string[]) => CommandResult = () => ({
    ok: true,
    code: 0,
    stdout: '',
    stderr: '',
  }),
): CommandRunner & {
  calls: { args: string[]; cwd?: string; stdin?: string }[]
} {
  const calls: { args: string[]; cwd?: string; stdin?: string }[] = []
  return {
    calls,
    async run(args, opts) {
      calls.push({
        args: [...args],
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}),
      })
      return reply(args)
    },
  }
}

describe('pin ref naming', () => {
  test('the compare separator is substituted so the name is ref-legal', () => {
    expect(pinKeyForCompare(`${SHA_A}...${SHA_B}`)).toBe(`${SHA_A}-${SHA_B}`)
  })

  test('the id and the pin key both sit in directory position', () => {
    const refs = pinRefsFor(LOCAL_ID, `${SHA_A}...${SHA_B}`)
    expect(refs.base).toBe(`refs/revu/reviews/${LOCAL_ID}/${SHA_A}-${SHA_B}/base`)
    expect(refs.head).toBe(`refs/revu/reviews/${LOCAL_ID}/${SHA_A}-${SHA_B}/head`)
    // Neither the id nor the pin key may ever be the last segment: a ref AT
    // `refs/revu/reviews/<id>` makes every child of that path unwritable, and a
    // ref at the pin key would do the same to `base`/`head`.
    expect(refs.base.endsWith(`/${LOCAL_ID}`)).toBe(false)
    expect(refs.head.endsWith(`/${LOCAL_ID}`)).toBe(false)
  })

  test('every ref this module writes lives under the per-review prefix', () => {
    // The shape retention discovery depends on: one `for-each-ref` over
    // `refs/revu/reviews/<id>/` finds every pin of that review and no other's.
    const mine = pinRefsFor(LOCAL_ID, `${SHA_A}...${SHA_B}`)
    const theirs = pinRefsFor(OTHER_LOCAL_ID, `${SHA_A}...${SHA_B}`)
    const prefix = `refs/revu/reviews/${LOCAL_ID}/`
    expect(mine.base.startsWith(prefix)).toBe(true)
    expect(mine.head.startsWith(prefix)).toBe(true)
    expect(theirs.base.startsWith(prefix)).toBe(false)
    expect(theirs.head.startsWith(prefix)).toBe(false)
  })
})

describe('ref legality against real git', () => {
  let dir: string
  const runner = createBunCommandRunner()

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'revu-pin-legality-')))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('both names this module produces are accepted', async () => {
    const refs = pinRefsFor(LOCAL_ID, `${SHA_A}...${SHA_B}`)
    for (const ref of [refs.base, refs.head]) {
      const result = await checkRefFormat(runner, dir, ref)
      expect(result.code).toBe(0)
    }
  })

  test("the design's literal compare-key form is rejected, which is why the substitution exists", async () => {
    // The companion to the assertion above: without this one, a substitution
    // that did nothing at all would still leave that test green, and the
    // whole point of `pinKeyForCompare` would be undetectably absent.
    const literal = `refs/revu/reviews/${LOCAL_ID}/${SHA_A}...${SHA_B}`
    const result = await checkRefFormat(runner, dir, literal)
    expect(result.code).toBe(1)
  })
})

describe('validation happens before anything is spawned', () => {
  test('a dash-leading object name is refused and the runner is never called', async () => {
    const runner = recordingRunner()
    const result = await pinSnapshotObjects(runner, '/repo', LOCAL_ID, {
      mergeBaseSha: '-x',
      headSha: SHA_B,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-object-name')
    expect(runner.calls).toHaveLength(0)
  })

  test('an id outside the local band is refused and the runner is never called', async () => {
    // A pull request number is an integer and a positive one; what makes it
    // wrong here is the band. Pinning objects under a review id that names a
    // real pull request would put local retention state on forge-keyed data.
    const runner = recordingRunner()
    const result = await pinSnapshotObjects(runner, '/repo', 7, {
      mergeBaseSha: SHA_A,
      headSha: SHA_B,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-local-id')
    expect(runner.calls).toHaveLength(0)
  })

  test('a non-integer id is refused and the runner is never called', async () => {
    const runner = recordingRunner()
    const result = await pinSnapshotObjects(runner, '/repo', 1_000_000_001.5, {
      mergeBaseSha: SHA_A,
      headSha: SHA_B,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-local-id')
    expect(runner.calls).toHaveLength(0)
  })

  test('the positive control: the same recorder does fill for a valid pin', async () => {
    // Without this, every assertion above is satisfied by a recorder that is
    // simply never connected to anything.
    const runner = recordingRunner()
    const result = await pinSnapshotObjects(runner, '/repo', LOCAL_ID, {
      mergeBaseSha: SHA_A,
      headSha: SHA_B,
    })
    expect(result.ok).toBe(true)
    expect(runner.calls.length).toBeGreaterThan(0)
  })
})

describe('the write is one batched invocation', () => {
  test('both refs are written by a single update-ref --stdin call', async () => {
    const runner = recordingRunner()
    await pinSnapshotObjects(runner, '/repo', LOCAL_ID, {
      mergeBaseSha: SHA_A,
      headSha: SHA_B,
    })
    expect(runner.calls).toHaveLength(1)
    const [call] = runner.calls
    expect(call.args).toEqual(['git', 'update-ref', '--stdin'])
    expect(call.cwd).toBe('/repo')
    // Both updates ride stdin, so no object name and no ref name ever occupies
    // an argv slot where git's option parser could read it.
    const refs = pinRefsFor(LOCAL_ID, `${SHA_A}...${SHA_B}`)
    expect(call.stdin).toBe(
      `update ${refs.base} ${SHA_A}\nupdate ${refs.head} ${SHA_B}\n`,
    )
  })

  test('no object name reaches an argv slot', () => {
    // The property the stdin form buys, stated so that moving either SHA back
    // into the argv is red rather than merely different.
    const runner = recordingRunner()
    return pinSnapshotObjects(runner, '/repo', LOCAL_ID, {
      mergeBaseSha: SHA_A,
      headSha: SHA_B,
    }).then(() => {
      for (const call of runner.calls) {
        expect(call.args.some((a) => a.includes(SHA_A) || a.includes(SHA_B))).toBe(false)
      }
    })
  })

  test('every emitted argv is in the hardened form', async () => {
    const runner = recordingRunner()
    await pinSnapshotObjects(runner, '/repo', LOCAL_ID, {
      mergeBaseSha: SHA_A,
      headSha: SHA_B,
    })
    await listPins(runner, '/repo', LOCAL_ID)
    expect(runner.calls.length).toBeGreaterThan(1)
    for (const call of runner.calls) {
      expect(isHardenedArgv(call.args)).toEqual({ ok: true })
    }
  })
})

describe('degradation is a result, never a throw', () => {
  test('a git failure yields a typed failure result', async () => {
    // 128 is what git exits on a locked ref or a bare repository. A pin failure
    // is not a sync failure, so the caller must be able to observe it as a
    // value; `resolves` rather than `rejects` is the assertion that says so.
    const runner = recordingRunner(() => ({
      ok: false,
      code: 128,
      stdout: '',
      stderr: 'fatal: cannot lock ref',
    }))
    await expect(
      pinSnapshotObjects(runner, '/repo', LOCAL_ID, {
        mergeBaseSha: SHA_A,
        headSha: SHA_B,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'git-failed' })
  })

  test('a listing failure yields a typed failure result', async () => {
    const runner = recordingRunner(() => ({
      ok: false,
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    }))
    await expect(listPins(runner, '/repo', LOCAL_ID)).resolves.toMatchObject({
      ok: false,
      reason: 'git-failed',
    })
  })
})

describe('against a real repository', () => {
  let dir: string
  let shaOne: string
  let shaTwo: string
  const runner = createBunCommandRunner()

  async function git(args: string[]): Promise<CommandResult> {
    return runner.run(['git', ...args], { cwd: dir })
  }

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'revu-pin-repo-')))
    // Ambient configuration decides nothing here: the production runner
    // inherits this process's environment, and a developer's global hooks path
    // or signing key would otherwise reach these spawns.
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'absent-global')
    process.env.GIT_CONFIG_SYSTEM = join(dir, 'absent-system')
    await git(['init', '-q', '-b', 'main', '.'])
    const identity = [
      '-c',
      'user.email=pin-fixture@revu.invalid',
      '-c',
      'user.name=Pin Fixture',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
    ]
    await git([...identity, 'commit', '-q', '--allow-empty', '-m', 'one'])
    shaOne = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    await git([...identity, 'commit', '-q', '--allow-empty', '-m', 'two'])
    shaTwo = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('a pin round-trips through real git', async () => {
    const pinned = await pinSnapshotObjects(runner, dir, LOCAL_ID, {
      mergeBaseSha: shaOne,
      headSha: shaTwo,
    })
    expect(pinned.ok).toBe(true)

    const listed = await listPins(runner, dir, LOCAL_ID)
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const refs = pinRefsFor(LOCAL_ID, `${shaOne}...${shaTwo}`)
    expect([...listed.pins].sort((a, b) => a.ref.localeCompare(b.ref))).toEqual([
      { ref: refs.base, objectName: shaOne },
      { ref: refs.head, objectName: shaTwo },
    ])
  })

  test('re-pinning the same compare is idempotent', async () => {
    await pinSnapshotObjects(runner, dir, LOCAL_ID, {
      mergeBaseSha: shaOne,
      headSha: shaTwo,
    })
    await pinSnapshotObjects(runner, dir, LOCAL_ID, {
      mergeBaseSha: shaOne,
      headSha: shaTwo,
    })
    const listed = await listPins(runner, dir, LOCAL_ID)
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.pins).toHaveLength(2)
  })

  test('the listing argv carries an explicit format', async () => {
    // git's default `for-each-ref` output is not a parsing contract, so a
    // dropped `--format` would hand the parser an unspecified shape. Asserted
    // on the whole array rather than by `toContain`, so a dropped flag is red.
    const recorder = recordingRunner(() => ({ ok: true, code: 0, stdout: '', stderr: '' }))
    await listPins(recorder, dir, LOCAL_ID)
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].args).toEqual([
      'git',
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
      '--end-of-options',
      `refs/revu/reviews/${LOCAL_ID}/`,
    ])
  })

  test('listing without an id spans every review', async () => {
    await pinSnapshotObjects(runner, dir, OTHER_LOCAL_ID, {
      mergeBaseSha: shaOne,
      headSha: shaTwo,
    })
    const all = await listPins(runner, dir)
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.pins.length).toBeGreaterThanOrEqual(4)
    expect(all.pins.some((p) => p.ref.includes(`/${OTHER_LOCAL_ID}/`))).toBe(true)
    expect(all.pins.some((p) => p.ref.includes(`/${LOCAL_ID}/`))).toBe(true)
  })

  test('an unpinned namespace lists clean rather than failing', async () => {
    const empty = await listPins(runner, dir, 1_000_000_999)
    expect(empty.ok).toBe(true)
    if (empty.ok) expect(empty.pins).toEqual([])
  })

  test('the pin holds its objects across an aggressive gc', async () => {
    // The whole point of the module, asserted rather than asserted-about: an
    // object reachable from nothing but its pin survives a prune that would
    // otherwise collect it.
    const identity = [
      '-c',
      'user.email=pin-fixture@revu.invalid',
      '-c',
      'user.name=Pin Fixture',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
    ]
    await git([...identity, 'commit', '-q', '--allow-empty', '-m', 'doomed'])
    const doomed = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    const pinned = await pinSnapshotObjects(runner, dir, 1_000_000_003, {
      mergeBaseSha: shaOne,
      headSha: doomed,
    })
    expect(pinned.ok).toBe(true)

    // Make the commit unreachable from any branch, then collect hard.
    await git(['reset', '-q', '--hard', shaTwo])
    await git(['reflog', 'expire', '--expire=now', '--all'])
    await git(['gc', '--prune=now', '-q'])

    const alive = await git(['cat-file', '-e', doomed])
    expect(alive.code).toBe(0)
  })
})

describe('the git facts the batch depends on', () => {
  let dir: string
  const runner = createBunCommandRunner()
  const BOGUS = 'deadbeef'.repeat(5)
  let sha: string

  async function git(args: string[]): Promise<CommandResult> {
    return runner.run(['git', ...args], { cwd: dir })
  }

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'revu-pin-atomic-')))
    await git(['init', '-q', '-b', 'main', '.'])
    await git([
      '-c',
      'user.email=pin-fixture@revu.invalid',
      '-c',
      'user.name=Pin Fixture',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'one',
    ])
    sha = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('a --stdin batch with one bad update writes neither ref', async () => {
    const result = await runner.run(['git', 'update-ref', '--stdin'], {
      cwd: dir,
      stdin: `update refs/revu/atomic/good ${sha}\nupdate refs/revu/atomic/bad ${BOGUS}\n`,
    })
    expect(result.ok).toBe(false)
    const listed = await git(['for-each-ref', '--format=%(refname)', 'refs/revu/atomic/'])
    expect(listed.stdout.trim()).toBe('')
  })

  test('two separate invocations leave a half-write, which is what the batch prevents', async () => {
    const first = await runner.run(['git', 'update-ref', 'refs/revu/sep/good', sha], {
      cwd: dir,
    })
    expect(first.ok).toBe(true)
    const second = await runner.run(['git', 'update-ref', 'refs/revu/sep/bad', BOGUS], {
      cwd: dir,
    })
    expect(second.ok).toBe(false)
    const listed = await git(['for-each-ref', '--format=%(refname)', 'refs/revu/sep/'])
    // Exactly the asymmetry the batch exists for: here one ref survived the
    // other's failure. Unrolling `pinSnapshotObjects` into two calls would
    // reintroduce precisely this.
    expect(listed.stdout.trim()).toBe('refs/revu/sep/good')
  })
})
