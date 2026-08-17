/**
 * Resolving a locally reviewed branch pair to the commit range the review covers:
 * two live ref reads, one merge base, and the compare key the two-half cache is
 * keyed by.
 *
 * Three properties in here are load-bearing far beyond the function they test:
 *
 * 1. **Outcomes are classified by the exit code git reported, never by matching
 *    stderr text.** Every row of the failure table is driven by a fake whose
 *    replies *cannot* carry stderr — the reply type has no such field — so an
 *    implementation that reads stderr to decide what went wrong cannot pass a
 *    single row. That is how the rule is enforced rather than merely written down.
 * 2. **The base tip is read live, at resolve time, and never recorded.** The
 *    fixture legs advance the base branch with no new head commit and assert what
 *    moves: the base tip always, and the compare key exactly when the advance
 *    reaches into the head branch's own history. A change that stabilized the base
 *    against a stored value would have to break those to remove them.
 * 3. **The compare key has one spelling.** It is pinned three ways, and the
 *    subsumption between those three pins is itself asserted, so the trio cannot
 *    read as three independent defenses when one of them can never be the unique
 *    cause of a failure.
 *
 * Every argv the resolver emits is checked with the shared hardened-argv
 * predicate rather than restated here, and the sweep covers every captured call
 * with an independently pinned count — a resolver that quietly stopped spawning
 * something shrinks that count.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandResult, CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import type { FixtureRepo } from './local-fixture-repo'
import {
  FIXTURE_AUTHOR_EMAIL,
  FIXTURE_AUTHOR_NAME,
  createFixtureRepo,
} from './local-fixture-repo'
import { isHardenedArgv } from './local-git-argv'
import { GIT_ARGV_BLOCKED, normalizeRef } from './local-git'
import type { LocalRange, LocalRangeFailure, LocalRangeResult } from './local-sync'
import { resolveLocalRange } from './local-sync'
import * as localSyncModule from './local-sync'

// ————————————————————————————————————————————————————————————————————————————
// The fake git, whose replies cannot carry stderr.
// ————————————————————————————————————————————————————————————————————————————

/**
 * One canned git outcome. There is deliberately no `stderr` field: every row of
 * the failure table below runs against replies with empty stderr, which is what
 * makes "classified by exit code, never by stderr text" a property a wrong
 * implementation cannot satisfy rather than a claim in a comment. `ok` is derived
 * from `code` exactly as the real runner derives it, so a row states one number.
 */
interface Reply {
  readonly code?: number
  readonly stdout?: string
}

/** The replies a resolver drive may need, keyed by the command that asks for them. */
interface GitReplies {
  /** Keyed by the qualified rev operand of `rev-parse --verify`. */
  readonly verify?: Readonly<Record<string, Reply>>
  readonly mergeBase?: Reply
  /** The answer to the shallow-repository probe. */
  readonly shallow?: Reply
}

/** The rev operands of an argv: everything between the marker and any pathspec. */
function revOperands(args: readonly string[]): string[] {
  const marker = args.indexOf('--end-of-options')
  if (marker === -1) return []
  const separator = args.indexOf('--', marker)
  return args.slice(marker + 1, separator === -1 ? undefined : separator)
}

/**
 * Picks the reply for one argv, and throws when the row modelled none. An
 * unmodelled command must be loud: a fake that answers a command nobody wrote a
 * reply for is inventing git's behaviour, and every assertion downstream of that
 * invention is an assertion about the fake.
 */
function selectReply(args: readonly string[], replies: GitReplies): Reply {
  if (args.includes('merge-base')) {
    if (replies.mergeBase === undefined) {
      throw new Error(`this row models no merge-base reply: git ${args.join(' ')}`)
    }
    return replies.mergeBase
  }
  if (args.includes('--is-shallow-repository')) {
    if (replies.shallow === undefined) {
      throw new Error(`this row models no shallow-repository reply: git ${args.join(' ')}`)
    }
    return replies.shallow
  }
  if (args.includes('--verify')) {
    const [ref] = revOperands(args)
    const reply = ref === undefined ? undefined : replies.verify?.[ref]
    if (reply === undefined) {
      throw new Error(`this row models no rev-parse reply for ${String(ref)}: git ${args.join(' ')}`)
    }
    return reply
  }
  throw new Error(`this row models no reply at all for: git ${args.join(' ')}`)
}

/**
 * A CommandRunner backed by canned replies, recording the argv it saw and the
 * results it returned. Both sinks feed the sweep: the argv sink proves the
 * hardened form, the result sink proves the resolver never had stderr text to
 * classify by.
 */
function fakeGit(replies: GitReplies, sink?: string[][], results?: CommandResult[]): CommandRunner {
  return {
    async run(args): Promise<CommandResult> {
      sink?.push(args)
      const reply = selectReply(args, replies)
      const code = reply.code ?? 0
      const result: CommandResult = {
        ok: code === 0,
        code,
        stdout: reply.stdout ?? '',
        stderr: '',
      }
      results?.push(result)
      return result
    },
  }
}

const BASE_REF = 'refs/heads/main'
const HEAD_REF = 'refs/heads/topic'
const BASE_SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)
const MERGE_BASE_SHA = 'c'.repeat(40)

/** The replies of a repository where both refs resolve and a merge base exists. */
function resolvingReplies(): GitReplies {
  return {
    verify: {
      [BASE_REF]: { stdout: `${BASE_SHA}\n` },
      [HEAD_REF]: { stdout: `${HEAD_SHA}\n` },
    },
    mergeBase: { stdout: `${MERGE_BASE_SHA}\n` },
  }
}

/**
 * The replies of a repository where the two differently-named refs sit on one
 * commit. No merge-base reply is modelled: a resolver that reaches for one has
 * already failed to recognize the degenerate pair, and must say so loudly.
 */
function sameCommitReplies(): GitReplies {
  return {
    verify: {
      [BASE_REF]: { stdout: `${BASE_SHA}\n` },
      [HEAD_REF]: { stdout: `${BASE_SHA}\n` },
    },
  }
}

function resolve(runner: CommandRunner): Promise<LocalRangeResult> {
  return resolveLocalRange(runner, '/repo', { baseRef: BASE_REF, headRef: HEAD_REF })
}

function expectRange(result: LocalRangeResult): LocalRange {
  if (!result.ok) throw new Error(`expected a resolved range, got ${result.reason}`)
  return result.range
}

function expectFailure(result: LocalRangeResult): LocalRangeFailure {
  if (result.ok) throw new Error('expected a typed failure, got a resolved range')
  return result
}

// ————————————————————————————————————————————————————————————————————————————
// The typed failures, driven by the exit code and nothing else.
// ————————————————————————————————————————————————————————————————————————————

interface FailureRow {
  readonly label: string
  readonly replies: GitReplies
  readonly expected: LocalRangeFailure
}

/** The merge-base reply shared by both no-common-ancestor rows: exit 1, no output. */
const NO_MERGE_BASE: Reply = { code: 1, stdout: '' }

const FAILURE_ROWS: readonly FailureRow[] = [
  {
    label: 'a base ref that resolves to nothing',
    replies: { verify: { [BASE_REF]: { code: 128 } } },
    expected: { ok: false, reason: 'ref_not_found', refs: [BASE_REF], code: 128 },
  },
  {
    label: 'a head ref that resolves to nothing',
    replies: {
      verify: { [BASE_REF]: { stdout: `${BASE_SHA}\n` }, [HEAD_REF]: { code: 128 } },
    },
    expected: { ok: false, reason: 'ref_not_found', refs: [HEAD_REF], code: 128 },
  },
  {
    label: 'two refs with no common ancestor in a complete repository',
    replies: {
      ...resolvingReplies(),
      mergeBase: NO_MERGE_BASE,
      shallow: { stdout: 'false\n' },
    },
    expected: {
      ok: false,
      reason: 'unrelated_histories',
      baseRef: BASE_REF,
      headRef: HEAD_REF,
    },
  },
  {
    label: 'the identical merge-base outcome in a shallow clone',
    replies: {
      ...resolvingReplies(),
      mergeBase: NO_MERGE_BASE,
      shallow: { stdout: 'true\n' },
    },
    expected: { ok: false, reason: 'shallow_clone', baseRef: BASE_REF, headRef: HEAD_REF },
  },
  {
    label: 'a merge base over a commit that is no longer there',
    replies: { ...resolvingReplies(), mergeBase: { code: 128 } },
    expected: {
      ok: false,
      reason: 'ref_not_found',
      refs: [BASE_REF, HEAD_REF],
      code: 128,
    },
  },
  {
    label: 'a clean ref read whose output is not an object name',
    replies: { verify: { [BASE_REF]: { stdout: 'refs/heads/main\n' } } },
    expected: { ok: false, reason: 'ref_not_found', refs: [BASE_REF], code: 0 },
  },
  {
    label: 'a clean merge-base read whose output is not an object name',
    replies: { ...resolvingReplies(), mergeBase: { stdout: `${MERGE_BASE_SHA.slice(0, 7)}\n` } },
    expected: {
      ok: false,
      reason: 'ref_not_found',
      refs: [BASE_REF, HEAD_REF],
      code: 0,
    },
  },
]

describe('a failure is classified by the exit code git reported', () => {
  for (const row of FAILURE_ROWS) {
    test(`${row.label} yields ${row.expected.reason}`, async () => {
      expect(await resolve(fakeGit(row.replies))).toEqual(row.expected)
    })
  }

  test('the two no-common-ancestor rows differ only in the shallow probe', () => {
    // The pair is the whole reason the probe exists: git reports the same exit
    // code and the same empty output for a shallow clone as for genuinely
    // unrelated histories, so the outcomes are distinguishable only by asking.
    const rows = FAILURE_ROWS.filter((row) => row.replies.mergeBase === NO_MERGE_BASE)
    expect(rows.map((row) => row.expected.reason)).toEqual(['unrelated_histories', 'shallow_clone'])
    expect(rows.map((row) => row.replies.shallow?.stdout)).toEqual(['false\n', 'true\n'])
  })

  test('the failure vocabulary has exactly four members and every one is reachable', async () => {
    // A reason no drive can produce is not a reason. Both halves matter: a fifth
    // member added without a row to reach it is red here, and so is a member
    // whose only path to being reported was quietly removed.
    const observed = new Set<string>()
    for (const row of FAILURE_ROWS) {
      observed.add(expectFailure(await resolve(fakeGit(row.replies))).reason)
    }
    observed.add(expectFailure(await resolve(fakeGit(sameCommitReplies()))).reason)
    expect([...observed].sort()).toEqual([
      'ref_not_found',
      'same_ref',
      'shallow_clone',
      'unrelated_histories',
    ])
  })

  test('a ref that the seam refuses to spawn is a typed failure, not a throw', async () => {
    // An unqualified name cannot reach git through the hardened argv form at all.
    // The refusal must surface as the same typed failure a missing ref does,
    // carrying the refusal's own code so the two are still distinguishable.
    const sink: string[][] = []
    const result = await resolveLocalRange(fakeGit({}, sink), '/repo', {
      baseRef: 'main',
      headRef: HEAD_REF,
    })
    expect(result).toEqual({
      ok: false,
      reason: 'ref_not_found',
      refs: ['main'],
      code: GIT_ARGV_BLOCKED,
    })
    expect(sink).toEqual([])
  })
})

describe('the same commit under two names is the degenerate pair', () => {
  test('two different ref names resolving to one commit is same_ref', async () => {
    // The comparison is on the resolved commits, not on the names. A
    // name-comparing implementation passes the obvious case — the same name on
    // both sides — and fails only here.
    expect(await resolve(fakeGit(sameCommitReplies()))).toEqual({
      ok: false,
      reason: 'same_ref',
      baseRef: BASE_REF,
      headRef: HEAD_REF,
      sha: BASE_SHA,
    })
  })

  test('the two ref names in that pair are genuinely different strings', () => {
    // Without this, the row above could be read as the obvious same-name case
    // and the SHA comparison would be unproven.
    expect(BASE_REF).not.toBe(HEAD_REF)
  })

  test('no merge base is asked for once the pair is degenerate', async () => {
    // The fake models no merge-base reply, so a resolver that ran one throws.
    const sink: string[][] = []
    await resolve(fakeGit(sameCommitReplies(), sink))
    expect(sink.filter((args) => args.includes('merge-base'))).toEqual([])
  })
})

describe('a head with nothing ahead of the base resolves, it does not fail', () => {
  test('a merge base equal to the head is a success carrying the range', async () => {
    const runner = fakeGit({
      verify: {
        [BASE_REF]: { stdout: `${BASE_SHA}\n` },
        [HEAD_REF]: { stdout: `${HEAD_SHA}\n` },
      },
      mergeBase: { stdout: `${HEAD_SHA}\n` },
    })
    const result = await resolve(runner)
    expect(result.ok).toBe(true)
    expect(expectRange(result)).toEqual({
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mergeBaseSha: HEAD_SHA,
      compareKey: `${HEAD_SHA}...${HEAD_SHA}`,
    })
  })
})

// ————————————————————————————————————————————————————————————————————————————
// The compare key: one spelling, pinned three ways, with the subsumption stated.
// ————————————————————————————————————————————————————————————————————————————

const COMPARE_KEY_PATTERN = /^[0-9a-f]{40}\.{3}[0-9a-f]{40}$/

describe('the compare key has exactly one spelling', () => {
  let range: LocalRange

  beforeAll(async () => {
    range = expectRange(await resolve(fakeGit(resolvingReplies())))
  })

  test('it is the merge base and the head joined by three dots', () => {
    expect(range.compareKey).toBe(`${range.mergeBaseSha}...${range.headSha}`)
  })

  test('it carries exactly one three-dot separator', () => {
    expect(range.compareKey.split('...')).toHaveLength(2)
  })

  test('it is two full-length object names joined by three dots', () => {
    expect(range.compareKey).toMatch(COMPARE_KEY_PATTERN)
  })

  test('the resolved range is the whole of what the caller receives', () => {
    expect(range).toEqual({
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mergeBaseSha: MERGE_BASE_SHA,
      compareKey: `${MERGE_BASE_SHA}...${HEAD_SHA}`,
    })
  })

  test('the base tip is not part of the key, so it cannot fork the cache', () => {
    expect(range.compareKey).not.toContain(range.baseSha)
  })
})

/**
 * The three pins above, restated as predicates over a `(mergeBaseSha, headSha,
 * compareKey)` triple so the table below can ask which of them a defective
 * builder's output would actually be caught by. Each mirrors the assertion of the
 * same name, in the same spelling.
 */
const PINS = {
  composition: (t: LocalRange): boolean => t.compareKey === `${t.mergeBaseSha}...${t.headSha}`,
  separatorCount: (t: LocalRange): boolean => t.compareKey.split('...').length === 2,
  objectNames: (t: LocalRange): boolean => COMPARE_KEY_PATTERN.test(t.compareKey),
} as const

interface KeyTriple {
  readonly label: string
  readonly triple: LocalRange
}

function triple(mergeBaseSha: string, headSha: string, compareKey: string): LocalRange {
  return { baseSha: BASE_SHA, mergeBaseSha, headSha, compareKey }
}

const CORRECT_TRIPLE = triple(MERGE_BASE_SHA, HEAD_SHA, `${MERGE_BASE_SHA}...${HEAD_SHA}`)

/** Outputs a defective builder could plausibly produce, one per way of being wrong. */
const DEFECTIVE_TRIPLES: readonly KeyTriple[] = [
  {
    label: 'the two-dot variant',
    triple: triple(MERGE_BASE_SHA, HEAD_SHA, `${MERGE_BASE_SHA}..${HEAD_SHA}`),
  },
  {
    label: 'the hyphen variant',
    triple: triple(MERGE_BASE_SHA, HEAD_SHA, `${MERGE_BASE_SHA}-${HEAD_SHA}`),
  },
  {
    label: 'the reversed pair',
    triple: triple(MERGE_BASE_SHA, HEAD_SHA, `${HEAD_SHA}...${MERGE_BASE_SHA}`),
  },
  {
    label: 'the head alone',
    triple: triple(MERGE_BASE_SHA, HEAD_SHA, HEAD_SHA),
  },
  {
    label: 'object names spelled in uppercase',
    triple: triple(
      MERGE_BASE_SHA.toUpperCase(),
      HEAD_SHA.toUpperCase(),
      `${MERGE_BASE_SHA.toUpperCase()}...${HEAD_SHA.toUpperCase()}`,
    ),
  },
  {
    label: 'a compare key mistaken for a merge base',
    triple: triple(
      `${MERGE_BASE_SHA}...${HEAD_SHA}`,
      HEAD_SHA,
      `${MERGE_BASE_SHA}...${HEAD_SHA}...${HEAD_SHA}`,
    ),
  },
]

function caughtOnlyBy(pin: keyof typeof PINS): string[] {
  return DEFECTIVE_TRIPLES.filter((row) =>
    (Object.keys(PINS) as (keyof typeof PINS)[]).every((name) =>
      name === pin ? !PINS[name](row.triple) : PINS[name](row.triple),
    ),
  ).map((row) => row.label)
}

describe('the three compare-key pins are not three independent defenses', () => {
  test('the correct triple satisfies all three pins', () => {
    expect(Object.values(PINS).map((pin) => pin(CORRECT_TRIPLE))).toEqual([true, true, true])
  })

  test('every defective triple is rejected by at least one pin', () => {
    const unnoticed = DEFECTIVE_TRIPLES.filter((row) =>
      Object.values(PINS).every((pin) => pin(row.triple)),
    ).map((row) => row.label)
    expect(unnoticed).toEqual([])
  })

  test('the composition pin is the only one that notices a reversed pair', () => {
    expect(caughtOnlyBy('composition')).toEqual(['the reversed pair'])
  })

  test('the object-name pin is the only one that notices the wrong character class', () => {
    expect(caughtOnlyBy('objectNames')).toEqual(['object names spelled in uppercase'])
  })

  test('the separator-count pin is never the only pin that notices anything', () => {
    // The finding this table exists to state: a key matching the object-name
    // pattern has exactly one three-dot separator by construction, so the
    // separator count can never be the unique cause of a red. It is kept because
    // it is cheap and reads as documentation of the spelling — but a reader must
    // not count it as a third independent defense, and this assertion is what
    // says so out loud.
    expect(caughtOnlyBy('separatorCount')).toEqual([])
  })

  test('the pin table names exactly the three assertions above it', () => {
    expect(Object.keys(PINS).sort()).toEqual(['composition', 'objectNames', 'separatorCount'])
  })
})

// ————————————————————————————————————————————————————————————————————————————
// The sweep: every argv hardened, every classified reply free of stderr text.
// ————————————————————————————————————————————————————————————————————————————

/** Drives every path the resolver has, into one argv sink and one result sink. */
async function driveEveryPath(sink: string[][], results: CommandResult[]): Promise<void> {
  await resolve(fakeGit(resolvingReplies(), sink, results))
  await resolve(fakeGit(sameCommitReplies(), sink, results))
  await resolve(
    fakeGit({ ...resolvingReplies(), mergeBase: { stdout: `${HEAD_SHA}\n` } }, sink, results),
  )
  for (const row of FAILURE_ROWS) {
    await resolve(fakeGit(row.replies, sink, results))
  }
  await resolveLocalRange(fakeGit({}, sink, results), '/repo', {
    baseRef: 'main',
    headRef: HEAD_REF,
  })
}

describe('every command the resolver runs is hardened, and none is classified by stderr', () => {
  const sink: string[][] = []
  const results: CommandResult[] = []

  beforeAll(async () => {
    await driveEveryPath(sink, results)
  })

  test('the drive spawned every command the resolver has', () => {
    // An independent literal rather than a count derived from the drives: three
    // resolving drives (3 + 2 + 3), seven failure rows (1 + 2 + 4 + 4 + 3 + 1 +
    // 3), and a blocked drive that spawns nothing. A path that quietly stopped
    // running a command shrinks this.
    expect(sink).toHaveLength(26)
  })

  test('every captured argv satisfies the hardened form — no sampling', () => {
    for (const args of sink) {
      expect(isHardenedArgv(args)).toEqual({ ok: true })
    }
  })

  test('nothing the resolver classified carried any stderr text', () => {
    expect(results.filter((result) => result.stderr !== '')).toEqual([])
  })

  test('the drive observed replies at all, so the assertion above scanned something', () => {
    expect(results.length).toBeGreaterThan(0)
  })

  test('the module exports exactly the surface this suite drives', () => {
    // A new export must join the sweep by hand; this pin is what forces that.
    expect(Object.keys(localSyncModule).sort()).toEqual(['resolveLocalRange'])
  })
})

// ————————————————————————————————————————————————————————————————————————————
// Against real git: agreement with the program, and the live base tip.
// ————————————————————————————————————————————————————————————————————————————

/** The identity and hook settings every fixture-mutating commit is made under. */
const COMMIT_CONFIG: readonly string[] = [
  '-c',
  `user.email=${FIXTURE_AUTHOR_EMAIL}`,
  '-c',
  `user.name=${FIXTURE_AUTHOR_NAME}`,
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
]

/**
 * Runs one git command directly, outside the seam, and returns its trimmed
 * output. Deliberately not routed through the seam under test: an oracle that
 * shares the code it is checking is not an oracle.
 */
async function git(dir: string, args: readonly string[]): Promise<string> {
  const result = await createBunCommandRunner().run(['git', ...args], { cwd: dir })
  if (!result.ok) {
    throw new Error(`\`git ${args.join(' ')}\` exited ${result.code}: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

function qualified(shortName: string): string {
  const normalized = normalizeRef(shortName, 'branch')
  if (!normalized.ok) throw new Error(`${shortName} must normalize, got ${normalized.reason}`)
  return normalized.ref
}

describe('against a real repository, the resolver agrees with git', () => {
  let fixture: FixtureRepo

  beforeAll(async () => {
    fixture = await createFixtureRepo()
  })

  afterAll(() => {
    fixture.dispose()
  })

  test('the merge base is the one git prints for the same pair', async () => {
    const range = expectRange(
      await resolveLocalRange(createBunCommandRunner(), fixture.dir, {
        baseRef: qualified(fixture.baseBranch),
        headRef: qualified(fixture.headBranch),
      }),
    )
    const printed = await git(fixture.dir, ['merge-base', range.baseSha, range.headSha])
    expect(range.mergeBaseSha).toBe(printed)
    expect(range.mergeBaseSha).toBe(fixture.mergeBaseSha)
  })

  test('the base tip is a fresh read of the base ref, and the head tip of the head ref', async () => {
    const range = expectRange(
      await resolveLocalRange(createBunCommandRunner(), fixture.dir, {
        baseRef: qualified(fixture.baseBranch),
        headRef: qualified(fixture.headBranch),
      }),
    )
    expect(range.baseSha).toBe(await git(fixture.dir, ['rev-parse', qualified(fixture.baseBranch)]))
    expect(range.headSha).toBe(await git(fixture.dir, ['rev-parse', qualified(fixture.headBranch)]))
  })

  test('the merge base is strictly behind the base tip, so the two are not interchangeable', async () => {
    const range = expectRange(
      await resolveLocalRange(createBunCommandRunner(), fixture.dir, {
        baseRef: qualified(fixture.baseBranch),
        headRef: qualified(fixture.headBranch),
      }),
    )
    expect(range.mergeBaseSha).not.toBe(range.baseSha)
    expect(range.compareKey).toBe(`${range.mergeBaseSha}...${range.headSha}`)
  })

  test('a ref that does not exist in the repository is named in the failure', async () => {
    const failure = expectFailure(
      await resolveLocalRange(createBunCommandRunner(), fixture.dir, {
        baseRef: qualified(fixture.baseBranch),
        headRef: 'refs/heads/no-such-branch',
      }),
    )
    expect(failure).toEqual({
      ok: false,
      reason: 'ref_not_found',
      refs: ['refs/heads/no-such-branch'],
      code: 128,
    })
  })
})

describe('the base tip is read live, never recorded', () => {
  let fixture: FixtureRepo
  let before: LocalRange

  const resolveFixture = async (): Promise<LocalRange> =>
    expectRange(
      await resolveLocalRange(createBunCommandRunner(), fixture.dir, {
        baseRef: qualified(fixture.baseBranch),
        headRef: qualified(fixture.headBranch),
      }),
    )

  beforeAll(async () => {
    // Its own repository: these legs advance the base branch, and a mutation
    // shared with the read-only legs above would make their outcome depend on
    // the order the runner happened to choose.
    fixture = await createFixtureRepo()
    before = await resolveFixture()
  })

  afterAll(() => {
    fixture.dispose()
  })

  test('a commit on the base branch moves the base tip with no new head commit', async () => {
    writeFileSync(join(fixture.dir, 'base-advance.txt'), 'a commit only the base branch carries\n')
    await git(fixture.dir, ['add', '-A'])
    await git(fixture.dir, [...COMMIT_CONFIG, 'commit', '-q', '-m', 'advance the base branch'])

    const after = await resolveFixture()
    expect(after.headSha).toBe(before.headSha)
    expect(after.baseSha).not.toBe(before.baseSha)
    expect(after.baseSha).toBe(await git(fixture.dir, ['rev-parse', qualified(fixture.baseBranch)]))
    // A commit the head branch does not contain adds no common ancestor, so the
    // reviewed range is untouched — the live read shows up in the base tip alone.
    expect(after.mergeBaseSha).toBe(before.mergeBaseSha)
    expect(after.compareKey).toBe(before.compareKey)
  })

  test('a base advance reaching into the head history moves the compare key', async () => {
    // The base branch taking on a commit the head branch already contains is
    // what moves the common ancestor, and with it the key the immutable half of
    // the cache is stored under — with no new head commit anywhere.
    const [firstHeadCommit] = fixture.headCommitShas
    await git(fixture.dir, [
      ...COMMIT_CONFIG,
      'merge',
      '--no-edit',
      '-m',
      'take the head branch history onto the base branch',
      firstHeadCommit,
    ])

    const after = await resolveFixture()
    expect(after.headSha).toBe(before.headSha)
    expect(after.mergeBaseSha).toBe(firstHeadCommit)
    expect(after.mergeBaseSha).not.toBe(before.mergeBaseSha)
    expect(after.compareKey).not.toBe(before.compareKey)
    expect(after.compareKey).toBe(`${firstHeadCommit}...${before.headSha}`)
  })
})

describe('a shallow clone is reported as itself, not as unrelated histories', () => {
  let fixture: FixtureRepo
  let shallowDir: string

  beforeAll(async () => {
    fixture = await createFixtureRepo()
    shallowDir = join(mkdtempSync(join(tmpdir(), 'revu-local-shallow-')), 'clone')
    // `--no-local` is required: a clone of a filesystem path hardlinks the whole
    // object store and ignores `--depth` outright, producing a complete
    // repository and a leg that proves nothing.
    await git(fixture.dir, [
      'clone',
      '-q',
      '--depth',
      '1',
      '--no-local',
      `file://${fixture.dir}`,
      shallowDir,
    ])
    await git(shallowDir, [
      'fetch',
      '-q',
      '--depth',
      '1',
      'origin',
      `${qualified(fixture.headBranch)}:${qualified(fixture.headBranch)}`,
    ])
  })

  afterAll(() => {
    rmSync(join(shallowDir, '..'), { recursive: true, force: true })
    fixture.dispose()
  })

  test('git really does report the clone as shallow', async () => {
    expect(await git(shallowDir, ['rev-parse', '--is-shallow-repository'])).toBe('true')
  })

  test('git reports the missing ancestor exactly as it reports unrelated histories', async () => {
    // The measured fact the probe exists for: exit 1 and empty output, the same
    // pair of observations a genuinely unrelated history produces. Without the
    // probe there is nothing in this outcome to tell the two apart.
    const base = await git(shallowDir, ['rev-parse', qualified(fixture.baseBranch)])
    const head = await git(shallowDir, ['rev-parse', qualified(fixture.headBranch)])
    const result = await createBunCommandRunner().run(['git', 'merge-base', base, head], {
      cwd: shallowDir,
    })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
  })

  test('the resolver reports the clone rather than the histories', async () => {
    const failure = expectFailure(
      await resolveLocalRange(createBunCommandRunner(), shallowDir, {
        baseRef: qualified(fixture.baseBranch),
        headRef: qualified(fixture.headBranch),
      }),
    )
    expect(failure).toEqual({
      ok: false,
      reason: 'shallow_clone',
      baseRef: qualified(fixture.baseBranch),
      headRef: qualified(fixture.headBranch),
    })
  })
})
