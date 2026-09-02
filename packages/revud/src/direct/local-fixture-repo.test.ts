/**
 * The seeded fixture repository's own self-test: it proves that every case the
 * harness claims to seed really is present in git's output.
 *
 * This is not optional coverage. A harness that silently fails to seed a case
 * turns every assertion made against that case into a claim about a change set
 * that was never created — a classification test that names a symlink, over a diff
 * containing no symlink, passes forever while the logic it names is completely
 * unguarded. That is the worst outcome available, because the suite reports green.
 * So the seven cases are asserted here, once, against the raw output of a real
 * `git diff`, and every downstream assertion inherits that proof instead of
 * assuming it.
 *
 * Each case is anchored to its own path rather than to "the output contains an A
 * somewhere": a status letter or a file mode that happens to appear on an
 * unrelated record would satisfy an unanchored assertion while the case it was
 * written for was missing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBunCommandRunner } from './command-runner'
import type { CommandResult } from './command-runner'
import { createFixtureRepo, FIXTURE_GITLINK_SHA } from './local-fixture-repo'
import type { FixtureRepo } from './local-fixture-repo'

/** How git spells "absent on this side" in a `--raw` record. */
const ZERO_SHA = '0'.repeat(40)

const runner = createBunCommandRunner()

function gitIn(dir: string, args: string[]): Promise<CommandResult> {
  return runner.run(['git', ...args], { cwd: dir })
}

/** Runs a git command that must succeed, and returns its stdout. */
async function stdoutOf(dir: string, args: string[]): Promise<string> {
  const result = await gitIn(dir, args)
  if (!result.ok) {
    throw new Error(`\`git ${args.join(' ')}\` exited ${result.code}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

/** One `git diff --raw -z` record: the meta fields plus one path, or two for a rename. */
interface RawRecord {
  readonly srcMode: string
  readonly dstMode: string
  readonly srcSha: string
  readonly dstSha: string
  readonly status: string
  readonly paths: readonly string[]
}

/**
 * Splits `--raw -z` output into records. A record's meta field opens with `:`; a
 * rename or copy status is followed by two path fields and every other status by
 * one, which is what makes the stream self-delimiting.
 *
 * This is a deliberately minimal reader that belongs to this self-test alone. Its
 * job is to make the seeding assertions legible, not to be the parser any
 * production code uses — asserting the harness with the parser under test would
 * make a shared misreading of git's format invisible to both.
 */
function parseRawZRecords(stdout: string): RawRecord[] {
  const fields = stdout.split('\0')
  const records: RawRecord[] = []
  let i = 0
  while (i < fields.length) {
    const meta = fields[i]
    if (meta === undefined || !meta.startsWith(':')) {
      i += 1
      continue
    }
    const [srcMode, dstMode, srcSha, dstSha, status] = meta.slice(1).split(' ')
    const pathCount = status !== undefined && /^[RC]/.test(status) ? 2 : 1
    records.push({
      srcMode: srcMode ?? '',
      dstMode: dstMode ?? '',
      srcSha: srcSha ?? '',
      dstSha: dstSha ?? '',
      status: status ?? '',
      paths: fields.slice(i + 1, i + 1 + pathCount),
    })
    i += 1 + pathCount
  }
  return records
}

describe('the seeded fixture repository', () => {
  let fixture: FixtureRepo
  let rawZ: string
  let records: RawRecord[]
  /** Patch output for the type-changed path alone, so its sections can be counted. */
  let patchStdout: string

  beforeAll(async () => {
    fixture = await createFixtureRepo()
    // The production runner, because the point of the harness is that real git
    // commands run against it — including the exact `--raw --no-abbrev -M -z`
    // form the snapshot builder issues.
    rawZ = await stdoutOf(fixture.dir, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--raw',
      '--no-abbrev',
      '-M',
      '-z',
      '--end-of-options',
      fixture.mergeBaseSha,
      fixture.headSha,
    ])
    records = parseRawZRecords(rawZ)
    patchStdout = await stdoutOf(fixture.dir, [
      '-c',
      'core.quotePath=false',
      'diff',
      '-M',
      '--unified=3',
      '--end-of-options',
      fixture.mergeBaseSha,
      fixture.headSha,
      '--',
      fixture.paths.typechanged,
    ])
  })

  afterAll(() => {
    fixture.dispose()
  })

  /** The record whose head-side path is `path`. Fails loudly when there is none. */
  function recordFor(path: string): RawRecord {
    const found = records.filter((r) => r.paths.at(-1) === path)
    expect(found.map((r) => r.status)).toHaveLength(1)
    return found[0] as RawRecord
  }

  test('the diff over the seeded range is not empty', () => {
    // The anti-vacuity control for every assertion below: an empty stdout would
    // parse to an empty record list, and `recordFor` is the only thing that then
    // reports it. Stated once, directly, so the reason a case is missing is never
    // confused with the range itself being empty.
    expect(rawZ.length).toBeGreaterThan(0)
    expect(records.length).toBeGreaterThanOrEqual(7)
  })

  test('the head branch carries exactly three commits beyond the base tip', async () => {
    const count = await stdoutOf(fixture.dir, [
      'rev-list',
      '--count',
      `${fixture.baseSha}..${fixture.headSha}`,
    ])
    expect(count.trim()).toBe('3')
  })

  test('the exported head commits are oldest first and end at the head tip', async () => {
    const listed = (
      await stdoutOf(fixture.dir, [
        'rev-list',
        '--reverse',
        `${fixture.mergeBaseSha}..${fixture.headSha}`,
      ])
    )
      .trim()
      .split('\n')
    expect([...fixture.headCommitShas]).toEqual(listed)
    expect(fixture.headCommitShas.at(-1)).toBe(fixture.headSha)
  })

  test('the merge base is strictly behind the base tip', async () => {
    expect(fixture.mergeBaseSha).not.toBe(fixture.baseSha)
    // And it really is an ancestor rather than an unrelated commit, so "behind" is
    // a fact about the history and not just about two strings differing.
    const ancestor = await gitIn(fixture.dir, [
      'merge-base',
      '--is-ancestor',
      fixture.mergeBaseSha,
      fixture.baseSha,
    ])
    expect(ancestor.code).toBe(0)
  })

  test('a plain modification is recorded as M with a blob on both sides', () => {
    const record = recordFor(fixture.paths.modified)
    expect(record.status).toBe('M')
    expect(record.srcSha).not.toBe(ZERO_SHA)
    expect(record.dstSha).not.toBe(ZERO_SHA)
  })

  test('an addition is recorded as A with no base-side blob', () => {
    const record = recordFor(fixture.paths.added)
    expect(record.status).toBe('A')
    expect(record.srcSha).toBe(ZERO_SHA)
    expect(record.dstSha).not.toBe(ZERO_SHA)
  })

  test('a deletion is recorded as D with no head-side blob', () => {
    const record = recordFor(fixture.paths.removed)
    expect(record.status).toBe('D')
    expect(record.srcSha).not.toBe(ZERO_SHA)
    expect(record.dstSha).toBe(ZERO_SHA)
  })

  test('a rename is detected by similarity and carries both paths', () => {
    const record = recordFor(fixture.paths.renamedTo)
    // The similarity score is part of the status letter, and it is what proves
    // `-M` paired the two paths rather than reporting an unrelated add and delete.
    expect(record.status).toMatch(/^R\d{3}$/)
    expect(record.paths).toEqual([fixture.paths.renamedFrom, fixture.paths.renamedTo])
  })

  test('the renamed pre-image does not also appear as its own deletion', () => {
    // If `-M` had failed to pair them, the pre-image would surface as a separate
    // D record — so this is the assertion that makes the rename case falsifiable
    // rather than merely satisfied by two independent records.
    expect(records.filter((r) => r.paths.length === 1 && r.paths[0] === fixture.paths.renamedFrom)).toEqual([])
  })

  test('the symlink is recorded with file mode 120000', () => {
    const record = recordFor(fixture.paths.symlink)
    expect(record.dstMode).toBe('120000')
  })

  test('the gitlink is recorded with file mode 160000 and a commit oid', () => {
    const record = recordFor(fixture.paths.gitlink)
    expect(record.dstMode).toBe('160000')
    // Not the all-zero SHA: a builder that decides what to skip by looking for an
    // absent SHA rather than at the file mode must fail against this record.
    expect(record.dstSha).toBe(FIXTURE_GITLINK_SHA)
    expect(record.dstSha).not.toBe(ZERO_SHA)
  })

  test('the type change is recorded as T, from a symlink to a regular file', () => {
    const record = recordFor(fixture.paths.typechanged)
    expect([record.status, record.srcMode, record.dstMode]).toEqual(['T', '120000', '100644'])
  })

  test('and both of its object names are real ones, neither spelled as absent', () => {
    // A path that merely appeared or vanished would carry the all-zero name on
    // one side; a type change exists on both, which is what makes it a single
    // record git nevertheless prints as two patch sections.
    const record = recordFor(fixture.paths.typechanged)
    expect([record.srcSha === ZERO_SHA, record.dstSha === ZERO_SHA]).toEqual([false, false])
  })

  test('git prints two patch sections for that one record', () => {
    // The measurement the change-set join depends on, taken here so a git that
    // stopped splitting a type change turns the harness red rather than leaving
    // the join asserting a shape nothing produces any more.
    const openings = patchStdout
      .split('\n')
      .filter((line) => line.startsWith('diff --git '))
    expect(openings).toHaveLength(2)
  })

  test('and it spells them as a deletion of the old mode then a creation of the new', () => {
    const introductions = patchStdout
      .split('\n')
      .filter((line) => line.startsWith('deleted file mode ') || line.startsWith('new file mode '))
    expect(introductions).toEqual(['deleted file mode 120000', 'new file mode 100644'])
  })

  test("the gitlink's oid is not an object this repository holds", async () => {
    const probe = await gitIn(fixture.dir, ['cat-file', '-e', FIXTURE_GITLINK_SHA])
    expect(probe.ok).toBe(false)
  })

  test("the binary file's blob contains a NUL byte", async () => {
    const record = recordFor(fixture.paths.binary)
    const blob = await stdoutOf(fixture.dir, ['cat-file', 'blob', record.dstSha])
    expect(blob).toContain('\0')
  })

  test("a text file's blob contains no NUL byte", async () => {
    // The control for the assertion above: it discriminates binary content from
    // text rather than reporting true for anything git hands back.
    const record = recordFor(fixture.paths.modified)
    const blob = await stdoutOf(fixture.dir, ['cat-file', 'blob', record.dstSha])
    expect(blob).not.toContain('\0')
  })

  test('git numstat reports the binary file with unmeasurable counts', async () => {
    const numstat = await stdoutOf(fixture.dir, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--numstat',
      '-M',
      '-z',
      '--end-of-options',
      fixture.mergeBaseSha,
      fixture.headSha,
    ])
    // git's own binary verdict, not the harness's: the `-\t-` counts are what the
    // builder maps to zero, and they only appear when git detected the NUL.
    expect(numstat).toContain(`-\t-\t${fixture.paths.binary}\0`)
  })

  test('the fixture directory is the repository toplevel git reports', async () => {
    // The positive control for the "no origin remote" assertion below: the same
    // runner and the same cwd do reach a working git in a real repository, so a
    // non-zero exit there means "no such remote" and not "nothing ran". Also pins
    // the resolved path, since a temp directory is reached through a symlink on
    // some platforms and git always reports the resolved form.
    const toplevel = await stdoutOf(fixture.dir, ['rev-parse', '--show-toplevel'])
    expect(toplevel.trim()).toBe(fixture.dir)
  })

  test('the repository has no origin remote', async () => {
    // The offline claim is then a property of the fixture rather than of whatever
    // remotes the machine running the suite happens to have configured.
    const origin = await gitIn(fixture.dir, ['remote', 'get-url', 'origin'])
    expect(origin.ok).toBe(false)
  })

  test('the exported env pins GIT_CONFIG_GLOBAL', () => {
    expect(Object.keys(fixture.env)).toContain('GIT_CONFIG_GLOBAL')
  })

  test('the exported env pins GIT_CONFIG_SYSTEM', () => {
    expect(Object.keys(fixture.env)).toContain('GIT_CONFIG_SYSTEM')
  })

  test('both pinned config paths are absent on disk', () => {
    expect([
      existsSync(fixture.env.GIT_CONFIG_GLOBAL as string),
      existsSync(fixture.env.GIT_CONFIG_SYSTEM as string),
    ]).toEqual([false, false])
  })

  test('this process carries the same pin, so a spawn taking no env is isolated too', () => {
    // The production command runner spawns without an env argument and therefore
    // inherits this process's environment. Pinning the variables here is the only
    // way the isolation reaches the git commands the code under test runs.
    expect([process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_SYSTEM]).toEqual([
      fixture.env.GIT_CONFIG_GLOBAL,
      fixture.env.GIT_CONFIG_SYSTEM,
    ])
  })

  test('git reads the file GIT_CONFIG_GLOBAL names, and reads nothing under the fixture env', async () => {
    // The paired control for the pin. The first half proves this git honours the
    // variable at all — without it, "no ambient config was read" could just as
    // well mean the variable is ignored and the developer's real global config was
    // in force the whole time. The second half proves the fixture's value is what
    // suppresses it.
    //
    // Spawned directly rather than through the command runner, which takes no
    // environment argument by design.
    const scratch = mkdtempSync(join(tmpdir(), 'revu-fixture-envprobe-'))
    try {
      const probeConfig = join(scratch, 'probe.gitconfig')
      writeFileSync(probeConfig, '[revu]\n\tfixtureProbe = seen\n')
      const args = ['-C', fixture.dir, 'config', '--get', 'revu.fixtureProbe']

      const withProbe = Bun.spawn(['git', ...args], {
        env: { ...fixture.env, GIT_CONFIG_GLOBAL: probeConfig },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const seen = await new Response(withProbe.stdout).text()
      expect([await withProbe.exited, seen.trim()]).toEqual([0, 'seen'])

      const withFixture = Bun.spawn(['git', ...args], {
        env: fixture.env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const suppressed = await new Response(withFixture.stdout).text()
      expect([await withFixture.exited, suppressed]).toEqual([1, ''])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe('disposing a fixture repository', () => {
  test('removes the directory and unwinds only its own environment pin', async () => {
    const prior = process.env.GIT_CONFIG_GLOBAL
    const fixture = await createFixtureRepo()
    expect(existsSync(fixture.dir)).toBe(true)
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(fixture.env.GIT_CONFIG_GLOBAL)

    fixture.dispose()

    expect(existsSync(fixture.dir)).toBe(false)
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(prior)
  })

  test('two overlapping fixtures unwind to the original whichever order they go in', async () => {
    // The order nothing enforces. A pin that restores whatever it displaced
    // restores the *second* fixture's value when the first is disposed first, and
    // that value names a directory the second fixture will then delete — leaving
    // the variable pointing at a path that does not exist for the rest of the
    // process, suppressing ambient configuration for every unrelated suite after
    // it. The terminal state has to be the original, not merely "not the first
    // fixture's".
    const prior = process.env.GIT_CONFIG_GLOBAL
    const priorSystem = process.env.GIT_CONFIG_SYSTEM
    const first = await createFixtureRepo()
    const second = await createFixtureRepo()
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(second.env.GIT_CONFIG_GLOBAL)

    first.dispose()

    // The survivor keeps its isolation: the variable still names a path it
    // chose, and never the one the disposed fixture has just deleted.
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(second.env.GIT_CONFIG_GLOBAL)
    expect(existsSync(first.dir)).toBe(false)

    second.dispose()

    expect(process.env.GIT_CONFIG_GLOBAL).toBe(prior)
    // Both variables, because they are pinned independently and a fix that only
    // reached one of them would leave the other pointing at a deleted path.
    expect(process.env.GIT_CONFIG_SYSTEM).toBe(priorSystem)
    expect(existsSync(second.dir)).toBe(false)
  })

  test('the two fixtures really did pin different values, so the order matters', async () => {
    // Without this the row above would hold for the trivial reason that both
    // fixtures pinned the same string and no order could tell them apart.
    const first = await createFixtureRepo()
    const second = await createFixtureRepo()
    try {
      expect(first.env.GIT_CONFIG_GLOBAL).not.toBe(second.env.GIT_CONFIG_GLOBAL)
    } finally {
      first.dispose()
      second.dispose()
    }
  })

  test('disposing twice leaves the variable where the second disposal put it', async () => {
    const prior = process.env.GIT_CONFIG_GLOBAL
    const first = await createFixtureRepo()
    const second = await createFixtureRepo()
    first.dispose()
    first.dispose()
    // A second release must not count as releasing the survivor's pin.
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(second.env.GIT_CONFIG_GLOBAL)
    second.dispose()
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(prior)
  })
})
