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
 *
 * The second half of the file covers the change set that range produces: git's
 * `--raw -z` records parsed into a file list and a blob index. Three of its
 * assertions are assertions of an *absence* — no object name spelled as absent
 * reaches the index, and neither a gitlink's nor a symlink's path does — so each
 * is paired with a permanent control that puts the forbidden thing there, and
 * each control is shown to fail on its own rather than only as part of a bundle.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandResult, CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import type { FixtureRepo } from './local-fixture-repo'
import {
  FIXTURE_AUTHOR_EMAIL,
  FIXTURE_AUTHOR_NAME,
  FIXTURE_GITLINK_SHA,
  createFixtureRepo,
} from './local-fixture-repo'
import { isHardenedArgv } from './local-git-argv'
import { GIT_ARGV_BLOCKED, normalizeRef } from './local-git'
import type {
  BlobIndexSkipReason,
  DiffFileEntry,
  LocalDiffFiles,
  LocalRange,
  LocalRangeFailure,
  LocalRangeResult,
  RawDiffRecord,
} from './local-sync'
import { buildLocalDiffFiles, parseRawZ, readLocalDiffFiles, resolveLocalRange } from './local-sync'
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
    // A new export must join a sweep by hand; this pin is what forces that.
    expect(Object.keys(localSyncModule).sort()).toEqual([
      'buildLocalDiffFiles',
      'parseRawZ',
      'readLocalDiffFiles',
      'resolveLocalRange',
    ])
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

// ————————————————————————————————————————————————————————————————————————————
// The change set: `git diff --raw -z` records, a file list, and a blob index.
// ————————————————————————————————————————————————————————————————————————————

/** How git spells "there is no object on this side". */
const ABSENT_OID = '0'.repeat(40)

/** How git spells "there is nothing on this side" in a file-mode position. */
const ABSENT_MODE = '000000'

/**
 * A distinct full-length object name per seed. Every one is deliberately free of
 * any run of zeros, so the only object names in this table that could trip a scan
 * for an absent-spelled oid are the ones that are *meant* to be caught.
 */
function oid(seed: string): string {
  return seed.repeat(20)
}

/** One `--raw -z` record: a metadata field, then its path fields, each NUL-terminated. */
function rawRecord(meta: string, ...paths: readonly string[]): string {
  return [meta, ...paths].map((field) => `${field}\0`).join('')
}

const ADDED_OID = oid('1a')
const REMOVED_OID = oid('2b')
const PLAIN_BASE_OID = oid('3c')
const PLAIN_HEAD_OID = oid('4d')
const RENAME_BASE_OID = oid('5e')
const RENAME_HEAD_OID = oid('6f')
const COPY_SOURCE_OID = oid('7a')
const COPY_HEAD_OID = oid('8b')
const TYPECHANGE_BASE_OID = oid('9c')
const TYPECHANGE_HEAD_OID = oid('ab')
const SYMLINK_OID = oid('bc')

const SYMLINK_PATH = 'src/link'
const GITLINK_PATH = 'vendor/sub'
const TYPECHANGE_PATH = 'src/becomes-link'
const COPY_PATH = 'src/copied.txt'

/** The blob index entry a row must produce, or the reason it must produce none. */
type ExpectedIndexing =
  | { readonly base: string | null; readonly head: string | null }
  | { readonly skipped: BlobIndexSkipReason }

interface ParseRow {
  readonly label: string
  /** The record exactly as `diff --raw --no-abbrev -M -z` emits it. */
  readonly record: string
  /** The whole of the `files[]` entry this record must produce. */
  readonly file: DiffFileEntry
  readonly indexed: ExpectedIndexing
}

/**
 * One row per shape `git diff --raw` can report over a commit-to-commit range.
 * The rows drive the parser and the builder directly, with no runner anywhere: a
 * fake runner could only prove which argv was asked for, and the semantics under
 * test here are entirely a function of the bytes git replied with.
 */
const PARSE_ROWS: readonly ParseRow[] = [
  {
    label: 'an added file',
    record: rawRecord(`:${ABSENT_MODE} 100644 ${ABSENT_OID} ${ADDED_OID} A`, 'src/added.txt'),
    file: { sha: ADDED_OID, filename: 'src/added.txt', status: 'added' },
    indexed: { base: null, head: ADDED_OID },
  },
  {
    label: 'a deleted file',
    record: rawRecord(`:100644 ${ABSENT_MODE} ${REMOVED_OID} ${ABSENT_OID} D`, 'src/removed.txt'),
    // The pre-image object name is the only one a delete has, and it is what the
    // API-shaped producer carries in the same field.
    file: { sha: REMOVED_OID, filename: 'src/removed.txt', status: 'removed' },
    indexed: { base: REMOVED_OID, head: null },
  },
  {
    label: 'a modified file',
    record: rawRecord(`:100644 100644 ${PLAIN_BASE_OID} ${PLAIN_HEAD_OID} M`, 'src/plain.txt'),
    file: { sha: PLAIN_HEAD_OID, filename: 'src/plain.txt', status: 'modified' },
    indexed: { base: PLAIN_BASE_OID, head: PLAIN_HEAD_OID },
  },
  {
    label: 'a rename detected by similarity',
    record: rawRecord(
      `:100644 100644 ${RENAME_BASE_OID} ${RENAME_HEAD_OID} R096`,
      'src/renamed-from.txt',
      'src/renamed-to.txt',
    ),
    file: {
      sha: RENAME_HEAD_OID,
      filename: 'src/renamed-to.txt',
      previous_filename: 'src/renamed-from.txt',
      status: 'renamed',
    },
    // Keyed by the post-image path, with the pre-image path's blob on the base
    // side — the same keying the API-shaped producer uses, and the entry a
    // comment anchored to the old path is looked up through.
    indexed: { base: RENAME_BASE_OID, head: RENAME_HEAD_OID },
  },
  {
    label: 'a copy',
    record: rawRecord(
      `:100644 100644 ${COPY_SOURCE_OID} ${COPY_HEAD_OID} C078`,
      'src/copy-source.txt',
      COPY_PATH,
    ),
    // The contract's status vocabulary has no member for a copy, and the closest
    // true statement about the head side is that the file is new there. Saying so
    // means saying it completely: an added file has no base side and no pre-image
    // path, so a copy reported as added carries neither either.
    file: { sha: COPY_HEAD_OID, filename: COPY_PATH, status: 'added' },
    indexed: { base: null, head: COPY_HEAD_OID },
  },
  {
    label: 'a file that became a symlink',
    record: rawRecord(
      `:100644 120000 ${TYPECHANGE_BASE_OID} ${TYPECHANGE_HEAD_OID} T`,
      TYPECHANGE_PATH,
    ),
    // A type change has no status of its own in the contract, and the file did
    // exist on both sides, so it is reported as modified.
    file: { sha: TYPECHANGE_HEAD_OID, filename: TYPECHANGE_PATH, status: 'modified' },
    indexed: { skipped: 'symlink' },
  },
  {
    label: 'a symlink',
    record: rawRecord(`:${ABSENT_MODE} 120000 ${ABSENT_OID} ${SYMLINK_OID} A`, SYMLINK_PATH),
    file: { sha: SYMLINK_OID, filename: SYMLINK_PATH, status: 'added' },
    indexed: { skipped: 'symlink' },
  },
  {
    label: 'a submodule',
    record: rawRecord(`:${ABSENT_MODE} 160000 ${ABSENT_OID} ${FIXTURE_GITLINK_SHA} A`, GITLINK_PATH),
    file: { sha: FIXTURE_GITLINK_SHA, filename: GITLINK_PATH, status: 'added' },
    indexed: { skipped: 'gitlink' },
  },
]

/** The whole table as one stream of records, in the order git would emit them. */
const TABLE_STDOUT = PARSE_ROWS.map((row) => row.record).join('')

function parseRecords(stdout: string): readonly RawDiffRecord[] {
  const parsed = parseRawZ(stdout)
  if (!parsed.ok) throw new Error(`this stream must parse, got ${parsed.detail}`)
  return parsed.records
}

function build(stdout: string): LocalDiffFiles {
  return buildLocalDiffFiles(parseRecords(stdout))
}

describe('every shape git can report becomes the file entry it means', () => {
  for (const row of PARSE_ROWS) {
    test(`${row.label} produces exactly its file entry`, () => {
      expect(build(row.record).files).toEqual([row.file])
    })

    const indexed = row.indexed
    if ('skipped' in indexed) {
      test(`${row.label} is left out of the blob index`, () => {
        expect(Object.hasOwn(build(row.record).blobIndex, row.file.filename)).toBe(false)
      })

      test(`${row.label} carries ${indexed.skipped} as its skip reason`, () => {
        expect(build(row.record).skippedBlobPaths).toEqual({
          [row.file.filename]: indexed.skipped,
        })
      })
    } else {
      test(`${row.label} produces exactly its blob index entry`, () => {
        expect(build(row.record).blobIndex).toEqual({ [row.file.filename]: indexed })
      })

      test(`${row.label} is not recorded as skipped`, () => {
        expect(build(row.record).skippedBlobPaths).toEqual({})
      })
    }
  }
})

describe('the whole table at once', () => {
  let table: LocalDiffFiles

  beforeAll(() => {
    table = build(TABLE_STDOUT)
  })

  test('every record becomes one file entry, in the order git emitted them', () => {
    expect(table.files).toEqual(PARSE_ROWS.map((row) => row.file))
  })

  test('the blob index holds exactly the paths that were not skipped', () => {
    expect(Object.keys(table.blobIndex).sort()).toEqual(
      PARSE_ROWS.filter((row) => !('skipped' in row.indexed))
        .map((row) => row.file.filename)
        .sort(),
    )
  })

  test('both unreadable object kinds are recorded with their reason', () => {
    expect(table.skippedBlobPaths).toEqual({
      [TYPECHANGE_PATH]: 'symlink',
      [SYMLINK_PATH]: 'symlink',
      [GITLINK_PATH]: 'gitlink',
    })
  })

  test('no object name spelled as absent reaches the index, from any status', () => {
    // Asserted over the whole table rather than per row: one oid leaking from
    // any single status is enough to make this red, where a per-row form would
    // let a status nobody thought to check leak one quietly.
    expect(JSON.stringify(table.blobIndex)).not.toContain('0000000')
  })

  test('the table really does carry object names git spells as absent', () => {
    expect(TABLE_STDOUT).toContain(ABSENT_OID)
  })

  test('the gitlink oid in the table is not itself all-zero', () => {
    // A builder that decided what to skip by looking for an all-zero oid rather
    // than at the file mode would pass every assertion above if the gitlink's
    // oid were all zeros. It is not, deliberately.
    expect(FIXTURE_GITLINK_SHA).not.toBe(ABSENT_OID)
  })

  test('yet that gitlink oid would still trip the scan above if it were indexed', () => {
    // Which is what ties the mode skip and the scan together: the submodule case
    // is guarded twice, by its own absence assertion and by the table-wide one.
    expect(FIXTURE_GITLINK_SHA).toContain('0000000')
  })
})

// ————————————————————————————————————————————————————————————————————————————
// The controls for the three absences, and the proof each fails on its own.
// ————————————————————————————————————————————————————————————————————————————

type BlobIndexEntry = { base: string | null; head: string | null }
type BlobIndex = Record<string, BlobIndexEntry>

/** The rules the real builder applies unconditionally, made switchable one by one. */
interface IndexRules {
  /**
   * Whether a side git spelled as absent — an all-zero oid, or the missing side
   * of an addition or a deletion — becomes null.
   */
  readonly nullAbsentSides: boolean
  /** File modes whose path is left out of the index entirely. */
  readonly skipModes: readonly string[]
}

const EVERY_RULE: IndexRules = { nullAbsentSides: true, skipModes: ['160000', '120000'] }
const NO_RULE: IndexRules = { nullAbsentSides: false, skipModes: [] }

/**
 * A blob index built from the same records the real builder reads, with each of
 * its rules switchable. It exists so the three absence assertions above are each
 * paired with something that puts the forbidden thing into an index: an absence
 * that has never been observed failing proves nothing, and none of these three
 * has a natural failing case, because the real builder is correct.
 *
 * Its faithfulness is asserted rather than assumed — with every rule applied it
 * must reproduce the real index exactly, which is what makes its behaviour with a
 * rule switched off evidence about that rule rather than about some unrelated
 * function that happens to live in a test file.
 */
function indexWithRules(records: readonly RawDiffRecord[], rules: IndexRules): BlobIndex {
  const index: BlobIndex = {}
  for (const record of records) {
    const presentModes = [record.srcMode, record.dstMode].filter((mode) => mode !== ABSENT_MODE)
    if (presentModes.some((mode) => rules.skipModes.includes(mode))) continue
    const baseAbsent = record.srcSha === ABSENT_OID || record.status === 'A' || record.status === 'C'
    const headAbsent = record.dstSha === ABSENT_OID || record.status === 'D'
    index[record.path] = {
      base: rules.nullAbsentSides && baseAbsent ? null : record.srcSha,
      head: rules.nullAbsentSides && headAbsent ? null : record.dstSha,
    }
  }
  return index
}

/**
 * The three claims the real index must falsify, each stated as a predicate so the
 * restorations below can ask which of them a given set of rules leaves standing.
 */
const FORBIDDEN_CLAIMS: Readonly<Record<string, (index: BlobIndex) => boolean>> = {
  'an object name spelled as absent is a value in the index': (index) =>
    Object.values(index).some((entry) => entry.base === ABSENT_OID || entry.head === ABSENT_OID),
  'the gitlink path is a key of the index': (index) => Object.hasOwn(index, GITLINK_PATH),
  'the symlink path is a key of the index': (index) => Object.hasOwn(index, SYMLINK_PATH),
}

function claimsFalsifiedBy(index: BlobIndex): string[] {
  return Object.entries(FORBIDDEN_CLAIMS)
    .filter(([, holds]) => !holds(index))
    .map(([claim]) => claim)
}

interface Restoration {
  readonly label: string
  readonly rules: IndexRules
  /** The one claim this rule, and only this rule, takes away. */
  readonly falsifies: string
}

const RESTORATIONS: readonly Restoration[] = [
  {
    label: 'the absent-side mapping',
    rules: { ...NO_RULE, nullAbsentSides: true },
    falsifies: 'an object name spelled as absent is a value in the index',
  },
  {
    label: 'the gitlink mode skip',
    rules: { ...NO_RULE, skipModes: ['160000'] },
    falsifies: 'the gitlink path is a key of the index',
  },
  {
    label: 'the symlink mode skip',
    rules: { ...NO_RULE, skipModes: ['120000'] },
    falsifies: 'the symlink path is a key of the index',
  },
]

describe('the three absences are each proved able to fail, and each on its own', () => {
  let records: readonly RawDiffRecord[]
  let real: LocalDiffFiles

  beforeAll(() => {
    records = parseRecords(TABLE_STDOUT)
    real = build(TABLE_STDOUT)
  })

  test('with every rule applied the control reproduces the real index exactly', () => {
    expect(indexWithRules(records, EVERY_RULE)).toEqual(real.blobIndex)
  })

  test('with no rule applied the index does contain an absent-spelled object name', () => {
    expect(JSON.stringify(indexWithRules(records, NO_RULE))).toContain('0000000')
  })

  test('with no rule applied the gitlink path is a key of the index', () => {
    expect(Object.hasOwn(indexWithRules(records, NO_RULE), GITLINK_PATH)).toBe(true)
  })

  test('with no rule applied the symlink path is a key of the index', () => {
    expect(Object.hasOwn(indexWithRules(records, NO_RULE), SYMLINK_PATH)).toBe(true)
  })

  test('with no rule applied every forbidden claim holds', () => {
    expect(claimsFalsifiedBy(indexWithRules(records, NO_RULE))).toEqual([])
  })

  test('against the real index every forbidden claim is false', () => {
    expect(claimsFalsifiedBy(real.blobIndex).sort()).toEqual(Object.keys(FORBIDDEN_CLAIMS).sort())
  })

  for (const restoration of RESTORATIONS) {
    test(`restoring ${restoration.label} takes away that rule's claim and no other`, () => {
      // The reason the restorations run one at a time: three controls that only
      // fire as a bundle prove that *something* in the bundle is load-bearing,
      // never which. One rule at a time names which.
      expect(claimsFalsifiedBy(indexWithRules(records, restoration.rules))).toEqual([
        restoration.falsifies,
      ])
    })
  }

  test('there are exactly three forbidden claims and a restoration for each', () => {
    // Independent literals: a claim added without a restoration to falsify it,
    // or a restoration quietly dropped, is red here even though every assertion
    // above still passes.
    expect(Object.keys(FORBIDDEN_CLAIMS)).toHaveLength(3)
    expect(RESTORATIONS).toHaveLength(3)
    expect(RESTORATIONS.map((restoration) => restoration.falsifies).sort()).toEqual(
      Object.keys(FORBIDDEN_CLAIMS).sort(),
    )
  })
})

/**
 * A blob index that reads "this side is absent" from one spelling only: either the
 * all-zero object name git prints, or the status letter that implies it. The real
 * builder reads both, and the table below is what says which of the two is doing
 * work — a pair of rules read as a pair of defenses is how a redundant one quietly
 * stops being true.
 */
function indexBySpelling(
  records: readonly RawDiffRecord[],
  spelling: 'the all-zero object name' | 'the status letter',
): BlobIndex {
  const index: BlobIndex = {}
  for (const record of records) {
    const presentModes = [record.srcMode, record.dstMode].filter((mode) => mode !== ABSENT_MODE)
    if (presentModes.some((mode) => EVERY_RULE.skipModes.includes(mode))) continue
    const byOid = spelling === 'the all-zero object name'
    const baseAbsent = byOid
      ? record.srcSha === ABSENT_OID
      : record.status === 'A' || record.status === 'C'
    const headAbsent = byOid ? record.dstSha === ABSENT_OID : record.status === 'D'
    index[record.path] = {
      base: baseAbsent ? null : record.srcSha,
      head: headAbsent ? null : record.dstSha,
    }
  }
  return index
}

describe('the two spellings of an absent side are not two defenses over the index', () => {
  let records: readonly RawDiffRecord[]
  let real: LocalDiffFiles

  beforeAll(() => {
    records = parseRecords(TABLE_STDOUT)
    real = build(TABLE_STDOUT)
  })

  test('reading the status letter alone already produces the real index', () => {
    // Measured, and recorded because the pair reads like two guards: a src oid of
    // all zeros only ever accompanies an addition, and a dst oid of all zeros only
    // ever accompanies a deletion, so over the blob index the all-zero reading is
    // never the unique cause of anything. It is kept as a second net under a
    // record shape nobody anticipated — but it must not be counted as a defense
    // the index depends on.
    expect(indexBySpelling(records, 'the status letter')).toEqual(real.blobIndex)
  })

  test('reading the all-zero object name alone does not', () => {
    expect(indexBySpelling(records, 'the all-zero object name')).not.toEqual(real.blobIndex)
  })

  test('and the copy is the whole of the difference between them', () => {
    // Which is the other half of the same finding: the status reading is the
    // unique cause of a copy having no base side, because a copy's source object
    // is a real one and the oid reading has nothing to notice.
    const byOid = indexBySpelling(records, 'the all-zero object name')
    const differing = Object.keys(real.blobIndex).filter(
      (path) => JSON.stringify(byOid[path]) !== JSON.stringify(real.blobIndex[path]),
    )
    expect(differing).toEqual([COPY_PATH])
  })

  test('where the all-zero reading is the unique cause is the object name of a delete', () => {
    // `sha` is the head-side object when there is one and the pre-image object
    // otherwise. Without the all-zero reading the "otherwise" never fires, and a
    // deleted file is named by a string of zeros instead of by the object that
    // holds the content the review is about.
    expect(real.files.find((file) => file.status === 'removed')?.sha).toBe(REMOVED_OID)
  })
})

describe('what is skipped is decided by the file mode, never by the oid', () => {
  // The strongest form of the same control, because it runs the real builder: the
  // identical oid under an ordinary file mode is indexed, so the skip cannot be
  // keyed on the shape of the object name.
  const addedUnderMode = (mode: string, path: string, headOid: string): LocalDiffFiles =>
    build(rawRecord(`:${ABSENT_MODE} ${mode} ${ABSENT_OID} ${headOid} A`, path))

  test('the gitlink oid under mode 160000 is left out of the index', () => {
    const built = addedUnderMode('160000', GITLINK_PATH, FIXTURE_GITLINK_SHA)
    expect(Object.hasOwn(built.blobIndex, GITLINK_PATH)).toBe(false)
  })

  test('the same oid under mode 100644 is indexed', () => {
    expect(addedUnderMode('100644', GITLINK_PATH, FIXTURE_GITLINK_SHA).blobIndex).toEqual({
      [GITLINK_PATH]: { base: null, head: FIXTURE_GITLINK_SHA },
    })
  })

  test('and the real builder then does produce an index the scan objects to', () => {
    expect(
      JSON.stringify(addedUnderMode('100644', GITLINK_PATH, FIXTURE_GITLINK_SHA).blobIndex),
    ).toContain('0000000')
  })

  test('the symlink oid under mode 120000 is left out of the index', () => {
    const built = addedUnderMode('120000', SYMLINK_PATH, SYMLINK_OID)
    expect(Object.hasOwn(built.blobIndex, SYMLINK_PATH)).toBe(false)
  })

  test('the same symlink oid under mode 100644 is indexed', () => {
    expect(addedUnderMode('100644', SYMLINK_PATH, SYMLINK_OID).blobIndex).toEqual({
      [SYMLINK_PATH]: { base: null, head: SYMLINK_OID },
    })
  })

  test('a mode 160000 entry on the base side alone is skipped too', () => {
    // A deleted submodule names its commit oid on the src side, where the same
    // reasoning applies: it is not an object this repository can read.
    const built = build(
      rawRecord(`:160000 ${ABSENT_MODE} ${FIXTURE_GITLINK_SHA} ${ABSENT_OID} D`, GITLINK_PATH),
    )
    expect(built.skippedBlobPaths).toEqual({ [GITLINK_PATH]: 'gitlink' })
  })
})

// ————————————————————————————————————————————————————————————————————————————
// The argv: the only place the abbreviation landmine can be guarded.
// ————————————————————————————————————————————————————————————————————————————

/** A runner that replies with one canned diff stream and records the argv it saw. */
function diffGit(stdout: string, sink?: string[][], code = 0): CommandRunner {
  return {
    async run(args): Promise<CommandResult> {
      sink?.push(args)
      return { ok: code === 0, code, stdout, stderr: '' }
    },
  }
}

const DIFF_RANGE = { mergeBaseSha: MERGE_BASE_SHA, headSha: HEAD_SHA }

describe('the change-set read asks git for full-length object names', () => {
  const sink: string[][] = []

  beforeAll(async () => {
    await readLocalDiffFiles(diffGit(TABLE_STDOUT, sink), '/repo', DIFF_RANGE)
  })

  test('it spawns exactly one command', () => {
    expect(sink).toHaveLength(1)
  })

  test('the argv carries --no-abbrev', () => {
    // Object names are abbreviated to seven characters without it, and a short
    // name matches nothing in a store keyed by the full one: every blob lookup
    // misses, line resolution comes back empty, and pending comments are
    // classified as lost en masse. Nothing downstream of the parse can tell a
    // truncated object name from a full one, so the argv is the only place this
    // can be guarded at all.
    expect(sink[0]).toContain('--no-abbrev')
  })

  test('the argv carries -z, so paths are never quoted or split on whitespace', () => {
    expect(sink[0]).toContain('-z')
  })

  test('the argv carries -M, so a rename is one record rather than two', () => {
    expect(sink[0]).toContain('-M')
  })

  test('the argv turns path quoting off explicitly rather than relying on -z', () => {
    const flag = sink[0].indexOf('-c')
    expect([sink[0][flag], sink[0][flag + 1]]).toEqual(['-c', 'core.quotePath=false'])
  })

  test('the whole argv is the one this read is specified to run', () => {
    expect(sink[0]).toEqual([
      'git',
      '-c',
      'core.quotePath=false',
      'diff',
      '--raw',
      '--no-abbrev',
      '-M',
      '-z',
      '--end-of-options',
      MERGE_BASE_SHA,
      HEAD_SHA,
    ])
  })

  test('the argv is in the hardened form', () => {
    expect(isHardenedArgv(sink[0])).toEqual({ ok: true })
  })
})

describe('every command the change-set read runs is hardened', () => {
  const sink: string[][] = []

  beforeAll(async () => {
    await readLocalDiffFiles(diffGit(TABLE_STDOUT, sink), '/repo', DIFF_RANGE)
    await readLocalDiffFiles(diffGit('', sink, 128), '/repo', DIFF_RANGE)
    await readLocalDiffFiles(diffGit('not a record\0', sink), '/repo', DIFF_RANGE)
  })

  test('the drive spawned every command the read has', () => {
    // An independent literal: one command per drive, and a read that quietly
    // grew a second git invocation — or stopped making one — moves this.
    expect(sink).toHaveLength(3)
  })

  test('every captured argv satisfies the hardened form — no sampling', () => {
    for (const args of sink) {
      expect(isHardenedArgv(args)).toEqual({ ok: true })
    }
  })
})

// ————————————————————————————————————————————————————————————————————————————
// No file cap: the page limit on the API path is an artifact of pagination.
// ————————————————————————————————————————————————————————————————————————————

/** Larger than the API path's page cap, so a cap copied "for symmetry" is red. */
const GENERATED_RECORD_COUNT = 3001

function generatedRecords(count: number): string {
  let stream = ''
  for (let i = 0; i < count; i++) {
    const base = i.toString(16).padStart(40, 'f')
    const head = i.toString(16).padStart(40, 'e')
    stream += rawRecord(`:100644 100644 ${base} ${head} M`, `src/generated-${i}.txt`)
  }
  return stream
}

const LOCAL_SYNC_SOURCE = readFileSync(new URL('./local-sync.ts', import.meta.url), 'utf8')

describe('a change set larger than the API path could paginate is kept whole', () => {
  let generated: LocalDiffFiles

  beforeAll(() => {
    generated = build(generatedRecords(GENERATED_RECORD_COUNT))
  })

  test('the generated change set is larger than the cap it must ignore', () => {
    // An independent literal rather than the imported constant: importing it here
    // would tie this file to the very module whose vocabulary the assertion below
    // forbids.
    expect(GENERATED_RECORD_COUNT).toBeGreaterThan(3000)
  })

  test('every record becomes a file', () => {
    expect(generated.files).toHaveLength(GENERATED_RECORD_COUNT)
  })

  test('every one of those paths reached the blob index', () => {
    expect(Object.keys(generated.blobIndex)).toHaveLength(GENERATED_RECORD_COUNT)
  })

  test('the last file of the change set is the last record git emitted', () => {
    expect(generated.files.at(-1)?.filename).toBe(`src/generated-${GENERATED_RECORD_COUNT - 1}.txt`)
  })

  test('the builder never names the page cap', () => {
    expect(LOCAL_SYNC_SOURCE).not.toMatch(/MAX_FILES/)
  })

  test('that pattern does fire against the module the cap belongs to', () => {
    // Without this, the assertion above would also pass for a pattern that
    // matches nothing anywhere.
    expect(readFileSync(new URL('./sync.ts', import.meta.url), 'utf8')).toMatch(/MAX_FILES/)
  })
})

// ————————————————————————————————————————————————————————————————————————————
// What the parser reads, and what it refuses.
// ————————————————————————————————————————————————————————————————————————————

describe('the parser reads git format, and refuses anything else', () => {
  test('an empty change set is an empty record list, not a failure', () => {
    expect(parseRawZ('')).toEqual({ ok: true, records: [] })
  })

  test('an abbreviated object name is refused rather than carried into the index', () => {
    // A second, independent net under the argv assertion: were --no-abbrev ever
    // dropped, this turns the seven-character oids into a loud typed failure
    // instead of a blob index full of names nothing can match.
    const abbreviated = rawRecord(':100644 100644 1a2b3c4 4d5e6f7 M', 'src/plain.txt')
    expect(parseRawZ(abbreviated).ok).toBe(false)
  })

  test('the same record with full-length object names parses', () => {
    expect(parseRawZ(PARSE_ROWS[2].record).ok).toBe(true)
  })

  test('a rename missing its second path field is refused', () => {
    const truncated = rawRecord(
      `:100644 100644 ${RENAME_BASE_OID} ${RENAME_HEAD_OID} R096`,
      'src/renamed-from.txt',
    )
    expect(parseRawZ(truncated).ok).toBe(false)
  })

  test('a status letter git cannot produce over a commit range is refused', () => {
    const unmerged = rawRecord(
      `:100644 100644 ${PLAIN_BASE_OID} ${PLAIN_HEAD_OID} U`,
      'src/plain.txt',
    )
    expect(parseRawZ(unmerged).ok).toBe(false)
  })

  test('a refusal is a typed failure naming what could not be read', () => {
    const parsed = parseRawZ('not a record\0')
    if (parsed.ok) throw new Error('this stream must not parse')
    expect(parsed.reason).toBe('malformed_diff')
    expect(parsed.detail).toContain('not a record')
  })

  test('a similarity score is kept apart from the status it decorates', () => {
    const [record] = parseRecords(PARSE_ROWS[3].record)
    expect(record).toEqual({
      srcMode: '100644',
      dstMode: '100644',
      srcSha: RENAME_BASE_OID,
      dstSha: RENAME_HEAD_OID,
      status: 'R',
      score: 96,
      path: 'src/renamed-to.txt',
      previousPath: 'src/renamed-from.txt',
    })
  })
})

describe('a change set git would not produce is a typed failure, never a throw', () => {
  test('a non-zero exit carries its exit code', async () => {
    expect(await readLocalDiffFiles(diffGit('', undefined, 128), '/repo', DIFF_RANGE)).toEqual({
      ok: false,
      reason: 'diff_failed',
      code: 128,
    })
  })

  test('output the parser cannot read resolves rather than rejecting', async () => {
    await expect(
      readLocalDiffFiles(diffGit('not a record\0'), '/repo', DIFF_RANGE),
    ).resolves.toMatchObject({ ok: false, reason: 'malformed_diff' })
  })
})

// ————————————————————————————————————————————————————————————————————————————
// Against real git: the seeded repository's seven cases, classified.
// ————————————————————————————————————————————————————————————————————————————

describe('against a real repository, every seeded case lands where it belongs', () => {
  let fixture: FixtureRepo
  let diff: LocalDiffFiles

  beforeAll(async () => {
    fixture = await createFixtureRepo()
    const result = await readLocalDiffFiles(createBunCommandRunner(), fixture.dir, {
      mergeBaseSha: fixture.mergeBaseSha,
      headSha: fixture.headSha,
    })
    if (!result.ok) throw new Error(`the fixture range must read, got ${result.reason}`)
    diff = result.diff
  })

  afterAll(() => {
    fixture.dispose()
  })

  test('every seeded path is classified as git reported it', () => {
    const statusByPath = Object.fromEntries(diff.files.map((file) => [file.filename, file.status]))
    expect(statusByPath).toEqual({
      [fixture.paths.modified]: 'modified',
      [fixture.paths.added]: 'added',
      [fixture.paths.removed]: 'removed',
      [fixture.paths.renamedTo]: 'renamed',
      [fixture.paths.binary]: 'added',
      [fixture.paths.symlink]: 'added',
      [fixture.paths.gitlink]: 'added',
    })
  })

  test('the base branch commit made after the fork is not in the range', () => {
    // Proof the read is against the merge base rather than the base tip: the two
    // are different commits in this repository, and only one of them leaves this
    // path out of the change set.
    expect(diff.files.map((file) => file.filename)).not.toContain(fixture.paths.baseOnly)
  })

  test('the rename carries the pre-image path git paired it with', () => {
    const renamed = diff.files.find((file) => file.filename === fixture.paths.renamedTo)
    expect(renamed?.previous_filename).toBe(fixture.paths.renamedFrom)
  })

  test("the rename's base side is the blob the pre-image path held", async () => {
    const preImage = await git(fixture.dir, [
      'rev-parse',
      `${fixture.mergeBaseSha}:${fixture.paths.renamedFrom}`,
    ])
    expect(diff.blobIndex[fixture.paths.renamedTo].base).toBe(preImage)
  })

  test("the modified file's head side is the blob the head commit holds", async () => {
    const headBlob = await git(fixture.dir, [
      'rev-parse',
      `${fixture.headSha}:${fixture.paths.modified}`,
    ])
    expect(diff.blobIndex[fixture.paths.modified].head).toBe(headBlob)
  })

  test('the deleted file keeps no head side', () => {
    expect(diff.blobIndex[fixture.paths.removed].head).toBeNull()
  })

  test('the added file keeps no base side', () => {
    expect(diff.blobIndex[fixture.paths.added].base).toBeNull()
  })

  test('the gitlink path is absent from the blob index', () => {
    expect(Object.hasOwn(diff.blobIndex, fixture.paths.gitlink)).toBe(false)
  })

  test('the symlink path is absent from the blob index', () => {
    expect(Object.hasOwn(diff.blobIndex, fixture.paths.symlink)).toBe(false)
  })

  test('both are still in the file list, with their skip reason recorded', () => {
    expect(diff.skippedBlobPaths).toEqual({
      [fixture.paths.gitlink]: 'gitlink',
      [fixture.paths.symlink]: 'symlink',
    })
  })

  test('no object name spelled as absent reached the index', () => {
    expect(JSON.stringify(diff.blobIndex)).not.toContain('0000000')
  })

  test('every object name in the index is full length', () => {
    const names = Object.values(diff.blobIndex).flatMap((entry) =>
      [entry.base, entry.head].filter((name): name is string => name !== null),
    )
    expect(names.filter((name) => !/^[0-9a-f]{40}$/.test(name))).toEqual([])
  })

  test('the index really did hold object names to check', () => {
    // Without this the assertion above would also pass over an empty index.
    const names = Object.values(diff.blobIndex).flatMap((entry) =>
      [entry.base, entry.head].filter((name): name is string => name !== null),
    )
    expect(names.length).toBeGreaterThan(0)
  })

  test('git really does report the gitlink as mode 160000 in this range', async () => {
    // The skip is proved against git's own output, not only against the table: a
    // fixture that failed to seed the case would make the two absence assertions
    // above pass over a change set that never carried it.
    const raw = await git(fixture.dir, [
      'diff',
      '--raw',
      '--no-abbrev',
      '-M',
      fixture.mergeBaseSha,
      fixture.headSha,
    ])
    expect(raw).toContain(`160000 ${ABSENT_OID} ${FIXTURE_GITLINK_SHA} A`)
  })
})
