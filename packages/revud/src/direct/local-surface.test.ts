/**
 * The assembled local review surface: what it wires together, and the four
 * wirings that are wrong in ways no type could notice.
 *
 * Every case here drives a REAL repository on disk through the real hardened git
 * seam and a real store, because three of the four claims below are about what
 * git was actually asked. A fake runner would let a wrongly scoped revision pass
 * as a string nobody compared against a repository.
 *
 * ## The four wirings
 *
 * **The write port is mapped, not spread.** Two of the port's members are named
 * differently on the durable store, so a spread of the store onto the port both
 * compiles and silently drops them — and carries a draft writer, an audit
 * journal and the pull-request keyspace onto a port whose whole value is being a
 * short list of names. The mapping is asserted twice: once behaviourally, by
 * watching a submitted summary land in the submitted-review table, and once
 * structurally, by pinning the port object's key set.
 *
 * **Head resolution is scoped to the compare, never to the branch.** The
 * moved-head answer subtracts the stored compare's commit list from the number
 * this resolves, so a count taken over the whole of the current head reports the
 * repository's age as new work on the branch. The fixture below is built so the
 * two numbers are far apart, and both are measured independently before the
 * assertion reads either.
 *
 * **The default branch has a producer.** The synthesized pull carries it on both
 * sides, and a repository with no origin marks nothing at all — the ordinary
 * state of a purely local review — so the answer there is the empty string and
 * not a guess at what the base branch might be.
 *
 * **Nothing on this path can reach a hosted forge.** Blob bytes come from the
 * store and from the local clone, and from nowhere else: the provisioning call
 * omits the client entirely, so an object the clone can no longer produce is
 * REPORTED as missing rather than bought back over a network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  PendingComment,
  ReviewDraft,
  ReviewSummary,
  Session,
  Snapshot,
  SubmitReviewInput,
} from '@revu/shared'
import { ApiError } from '@revu/shared'
import type { CommandResult, CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import { createFixtureRepo, type FixtureRepo } from './local-fixture-repo'
import { buildLocalWriteDeps, createLocalReviewSurface } from './local-surface'
import type { LocalReviewSurface, LocalReviewSurfaceDeps } from './local-surface'
import type { DirectStore } from './store'
import { openDirectStore } from './store'

const SESSION: Session = {
  human: {
    id: 'dana.reeve@example.test',
    name: 'Dana Reeve',
    role: 'contractor',
    email: 'dana.reeve@example.test',
  },
  // Empty in every non-broker deployment: there is no shared bot account behind
  // a local review, which is the same reason its comment bodies are unstamped.
  brokerLogin: '',
  workspace: 'local',
}

const FIXED_NOW = '2026-01-02T03:04:05.000Z'

/** The repository identity every review here is scoped to. */
const REPO = 'acme/revu'

// ————————————————————————————————————————————————————————————————————————————
// Fixtures.
// ————————————————————————————————————————————————————————————————————————————

/**
 * How many commits the deep fixture's trunk carries before the branch forks off,
 * and how many the branch adds. They are far apart on purpose: the compare-scope
 * assertion compares the reviewed range's commit count against the count the
 * whole of the head carries, and two numbers that differed by one would let a
 * branch-scoped count look like an off-by-one rather than a wrong question.
 */
const TRUNK_DEPTH = 12
const BRANCH_DEPTH = 2

interface DeepRepo {
  readonly dir: string
  readonly env: Record<string, string>
  /** The branch that forks after the trunk is fully built. */
  readonly headBranch: string
  readonly baseBranch: string
  dispose(): void
}

/**
 * Spawns one git command inside a directory, throwing on a non-zero exit so a
 * half-seeded repository is never handed to a case: every assertion made against
 * one would be a claim about a range that was never created.
 */
async function seedGit(
  dir: string,
  env: Record<string, string>,
  args: readonly string[],
): Promise<string> {
  const proc = Bun.spawn(['git', '-C', dir, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(`fixture seeding failed: \`git ${args.join(' ')}\` exited ${code}: ${stderr.trim()}`)
  }
  return stdout
}

/**
 * A repository whose trunk is long and whose reviewed branch is short.
 *
 * The shared change-set fixture cannot serve the compare-scope case: its branch
 * holds three commits against a repository of five, and a count taken over the
 * wrong range there is off by a margin small enough to read as an ordinary
 * miscount. Here the branch holds two against fourteen, so the two answers are
 * unmistakable, and neither number is written down — both are measured from the
 * repository itself at the point of use.
 */
async function createDeepRepo(): Promise<DeepRepo> {
  const dir = mkdtempSync(join(tmpdir(), 'revu-deep-history-'))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // Inside the fixture and never created, so ambient git configuration decides
  // nothing about what this repository contains.
  env.GIT_CONFIG_GLOBAL = join(dir, 'absent-global-gitconfig')
  env.GIT_CONFIG_SYSTEM = join(dir, 'absent-system-gitconfig')

  const identity = [
    '-c',
    'user.email=deep@revu.invalid',
    '-c',
    'user.name=Deep Fixture',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
  ]

  const init = Bun.spawn(['git', 'init', '-q', '-b', 'main', dir], { env, stdout: 'pipe', stderr: 'pipe' })
  if ((await init.exited) !== 0) {
    throw new Error('fixture seeding failed: git init did not succeed')
  }

  for (let i = 0; i < TRUNK_DEPTH; i++) {
    writeFileSync(join(dir, 'trunk.txt'), `trunk line ${i}\n`)
    await seedGit(dir, env, ['add', '-A'])
    await seedGit(dir, env, [...identity, 'commit', '-q', '-m', `trunk commit ${i}`])
  }

  await seedGit(dir, env, ['checkout', '-q', '-b', 'feature/deep'])
  for (let i = 0; i < BRANCH_DEPTH; i++) {
    writeFileSync(join(dir, 'branch.txt'), `branch line ${i}\n`)
    await seedGit(dir, env, ['add', '-A'])
    await seedGit(dir, env, [...identity, 'commit', '-q', '-m', `branch commit ${i}`])
  }
  // Left on the branch so nothing about the assertion depends on which ref the
  // worktree happens to have checked out.

  return {
    dir,
    env,
    headBranch: 'feature/deep',
    baseBranch: 'main',
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/**
 * A runner that records every argv it is handed and then delegates to real git.
 * Recording rather than answering is deliberate: the assertions that read this
 * are about the QUESTION git was asked, and an answering fake would let a wrongly
 * scoped revision pass as a string no repository ever evaluated.
 */
function recordingRunner(sink: string[][]): CommandRunner {
  const real = createBunCommandRunner()
  return {
    run(args: string[], opts?: { cwd?: string }): Promise<CommandResult> {
      sink.push([...args])
      return real.run(args, opts)
    },
  }
}

/**
 * A runner that refuses every `cat-file` read and delegates everything else.
 *
 * It stands in for the one state that separates "no hosted tier was entered"
 * from "a hosted tier was entered and had nothing to do": a clone that cannot
 * produce the reviewed objects. With a client wired, those bytes would be
 * fetched and the snapshot would come back complete; with none, they are named.
 */
function blobBlindRunner(): CommandRunner {
  const real = createBunCommandRunner()
  return {
    run(args: string[], opts?: { cwd?: string }): Promise<CommandResult> {
      if (args.includes('cat-file')) {
        return Promise.resolve({ ok: false, code: 128, stdout: '', stderr: 'no such object' })
      }
      return real.run(args, opts)
    },
  }
}

/**
 * A runner that refuses the worktree probe and delegates everything else.
 *
 * It produces the third reading of a three-valued observation — the one that
 * says the question could not be answered — which is the only state that
 * separates a squash written as "not clean" from one written as "is dirty".
 */
function worktreeBlindRunner(): CommandRunner {
  const real = createBunCommandRunner()
  return {
    run(args: string[], opts?: { cwd?: string }): Promise<CommandResult> {
      if (args.includes('status')) {
        return Promise.resolve({ ok: false, code: 128, stdout: '', stderr: '' })
      }
      return real.run(args, opts)
    },
  }
}

/** A store that records the local writes whose port names differ from its own. */
interface SpyStore {
  readonly store: DirectStore
  readonly submittedReviews: { localId: number; review: ReviewSummary }[]
  readonly entityIdCalls: number[]
}

/**
 * Wraps a real store, recording the two calls a spread would never make.
 *
 * The wrapper delegates by prototype rather than by copying members, so a store
 * method this file does not name still works and no assertion here depends on
 * the store's full surface being written out a second time.
 */
function spyStore(inner: DirectStore): SpyStore {
  const submittedReviews: { localId: number; review: ReviewSummary }[] = []
  const entityIdCalls: number[] = []
  const store: DirectStore = Object.create(inner) as DirectStore
  store.putLocalSubmittedReview = (localId: number, review: ReviewSummary): void => {
    submittedReviews.push({ localId, review })
    inner.putLocalSubmittedReview(localId, review)
  }
  store.nextLocalEntityId = (): number => {
    const id = inner.nextLocalEntityId()
    entityIdCalls.push(id)
    return id
  }
  return { store, submittedReviews, entityIdCalls }
}

interface Harness {
  readonly surface: LocalReviewSurface
  readonly deps: LocalReviewSurfaceDeps
  readonly store: DirectStore
}

function makeSurface(overrides: Partial<LocalReviewSurfaceDeps> & { toplevel: string }): Harness {
  const store = overrides.store ?? openDirectStore({ dataDir: ':memory:' })
  const deps: LocalReviewSurfaceDeps = {
    store,
    runner: overrides.runner ?? createBunCommandRunner(),
    toplevel: overrides.toplevel,
    repo: overrides.repo ?? REPO,
    session: overrides.session ?? SESSION,
    now: overrides.now ?? ((): string => FIXED_NOW),
  }
  return { surface: createLocalReviewSurface(deps), deps, store }
}

/** A pending comment anchored on a path the seeded head branch really carries. */
function pendingComment(path: string, line: number): PendingComment {
  return {
    key: `pending-${path}-${line}`,
    path,
    side: 'RIGHT',
    start_side: null,
    line,
    start_line: null,
    body: 'This deserves a note.',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    anchor: { lineText: '', contextBefore: [], contextAfter: [] },
  }
}

// ————————————————————————————————————————————————————————————————————————————
// The shared change-set fixture, driving everything except the compare scope.
// ————————————————————————————————————————————————————————————————————————————

let fixture: FixtureRepo

beforeAll(async () => {
  fixture = await createFixtureRepo()
})

afterAll(() => {
  fixture.dispose()
})

/** Creates a review over the shared fixture's seeded branch pair and syncs it. */
async function createdAndSynced(harness: Harness): Promise<{ localId: number; snapshot: Snapshot }> {
  const review = await harness.surface.createLocalReview({
    baseRef: fixture.baseBranch,
    headRef: fixture.headBranch,
  })
  const snapshot = await harness.surface.syncPull(review.id)
  return { localId: review.id, snapshot }
}

describe('creating a local review', () => {
  test('records the pair and mints an id in the reserved band', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    expect(review.baseRef).toBe(`refs/heads/${fixture.baseBranch}`)
    expect(review.headRef).toBe(`refs/heads/${fixture.headBranch}`)
    expect(review.repo).toBe(REPO)
    harness.store.close()
  })

  test('defaults the title to the head ref, in its display form', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: `refs/heads/${fixture.headBranch}`,
    })
    expect(review.title).toBe(fixture.headBranch)
    harness.store.close()
  })

  test('is idempotent per branch pair rather than an error', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const first = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    const second = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    expect(second.id).toBe(first.id)
    harness.store.close()
  })

  test('refuses a ref name that would be read as an option', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    await expect(
      harness.surface.createLocalReview({
        baseRef: '--upload-pack=touch /tmp/pwned',
        headRef: fixture.headBranch,
      }),
    ).rejects.toThrow(ApiError)
    harness.store.close()
  })

  test('refuses a pair whose two sides normalize to one ref', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    await expect(
      harness.surface.createLocalReview({
        baseRef: fixture.headBranch,
        headRef: `refs/heads/${fixture.headBranch}`,
      }),
    ).rejects.toThrow(ApiError)
    harness.store.close()
  })

  test('resolves no SHAs at create — the review starts unsynced', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    expect(review.headSha).toBeNull()
    expect(harness.surface.getSnapshot(review.id)).toBeNull()
    harness.store.close()
  })
})

describe('listing', () => {
  test('lists the reviews recorded for this repository', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    expect(harness.surface.listLocalReviews().map((row) => row.id)).toEqual([review.id])
    harness.store.close()
  })

  test('lists branches from git, not from the store', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const names = (await harness.surface.listBranches()).map((branch) => branch.name).sort()
    expect(names).toEqual([fixture.baseBranch, fixture.headBranch].sort())
    harness.store.close()
  })

  test('an unreadable repository throws rather than listing nothing', async () => {
    const harness = makeSurface({ toplevel: join(tmpdir(), 'revu-not-a-repository-at-all') })
    await expect(harness.surface.listBranches()).rejects.toThrow()
    harness.store.close()
  })

  test('that failure is typed, so the transport never reports it as an unreachable broker', async () => {
    // A bare error would reach the transport's terminal catch-all and be
    // answered as `broker_unreachable` at 500 — a claim about infrastructure a
    // purely local daemon does not have, and the most confusing message this
    // surface could produce.
    const harness = makeSurface({ toplevel: join(tmpdir(), 'revu-not-a-repository-at-all') })
    const failure = await harness.surface.listBranches().catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).code).toBe('unprocessable')
    harness.store.close()
  })
})

describe('the write port is mapped member by member, never spread', () => {
  test('a submit lands its summary in the store submitted-review table', async () => {
    // The behavioural half of the mapping pin. The port member is
    // `putLocalReviewSummary` and the store method is `putLocalSubmittedReview`;
    // a spread of the store onto the port compiles, drops the port member, and
    // leaves this spy uncalled.
    const spy = spyStore(openDirectStore({ dataDir: ':memory:' }))
    const harness = makeSurface({ toplevel: fixture.dir, store: spy.store })
    const { localId, snapshot } = await createdAndSynced(harness)

    const input: SubmitReviewInput = {
      prNumber: localId,
      expectedHeadSha: snapshot.immutable.headSha,
      event: 'APPROVE',
      body: 'Reads well.',
      comments: [],
    }
    const result = await harness.surface.submitReview(input)

    expect(result.status).toBe('ok')
    expect(spy.submittedReviews).toHaveLength(1)
    expect(spy.submittedReviews[0].localId).toBe(localId)
    expect(spy.submittedReviews[0].review.state).toBe('APPROVED')
    spy.store.close()
  })

  test('the entity allocator is the store mark, not a counter of the port own', async () => {
    // The second rename: the port calls it `nextEntityId` and the store calls it
    // `nextLocalEntityId`. A submit with one comment mints two ids — the review
    // summary and the comment — and both must come from the durable mark.
    const spy = spyStore(openDirectStore({ dataDir: ':memory:' }))
    const harness = makeSurface({ toplevel: fixture.dir, store: spy.store })
    const { localId, snapshot } = await createdAndSynced(harness)

    await harness.surface.submitReview({
      prNumber: localId,
      expectedHeadSha: snapshot.immutable.headSha,
      event: 'COMMENT',
      body: 'One note.',
      comments: [pendingComment(fixture.paths.modified, 2)],
    })

    expect(spy.entityIdCalls).toHaveLength(2)
    spy.store.close()
  })

  test('the port object carries exactly the members the sink declares', async () => {
    // The structural half. Written out as a literal rather than derived from the
    // interface, which is erased at runtime: a member the port grows has to be
    // added here too, and a spread fails immediately by carrying dozens more.
    const harness = makeSurface({ toplevel: fixture.dir })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    expect(Object.keys(buildLocalWriteDeps(harness.deps, review.id)).sort()).toEqual([
      'deleteLocalDraft',
      'getLocalDraft',
      'getLocalSnapshot',
      'nextEntityId',
      'now',
      'putLocalReviewSummary',
      'putLocalSnapshot',
      'putLocalThread',
      'resolveHead',
      'session',
    ])
    harness.store.close()
  })

  for (const forbidden of ['putLocalDraft', 'appendAudit', 'putSnapshot', 'close'] as const) {
    test(`the port carries no ${forbidden}`, async () => {
      // One absence per case: the runner abandons a body at its first failed
      // expectation, so four absences sharing one body leave three of them
      // unfalsifiable.
      const harness = makeSurface({ toplevel: fixture.dir })
      const review = await harness.surface.createLocalReview({
        baseRef: fixture.baseBranch,
        headRef: fixture.headBranch,
      })
      expect(Object.keys(buildLocalWriteDeps(harness.deps, review.id))).not.toContain(forbidden)
      harness.store.close()
    })
  }

  test('every forbidden name is one the durable store really carries', async () => {
    // Without this control the absences above would also pass against a store
    // that never had those members, which would make them assert nothing.
    const store = openDirectStore({ dataDir: ':memory:' })
    for (const member of ['putLocalDraft', 'appendAudit', 'putSnapshot', 'close'] as const) {
      expect(typeof store[member]).toBe('function')
    }
    store.close()
  })
})

describe('head resolution is scoped to the compare, never to the branch', () => {
  let deep: DeepRepo

  beforeAll(async () => {
    deep = await createDeepRepo()
  })

  afterAll(() => {
    deep.dispose()
  })

  test('the fixture two commit counts genuinely differ', async () => {
    // The control that stops every assertion below from being vacuous. Both
    // numbers are read from the repository rather than restated from the
    // seeding constants, so a fixture that stopped producing a deep history
    // fails here rather than quietly making the scope assertion trivial.
    const runner = createBunCommandRunner()
    const mergeBase = (
      await runner.run(['git', 'merge-base', 'main', 'feature/deep'], { cwd: deep.dir })
    ).stdout.trim()
    const inCompare = Number(
      (
        await runner.run(['git', 'rev-list', '--count', `${mergeBase}..feature/deep`], {
          cwd: deep.dir,
        })
      ).stdout.trim(),
    )
    const onBranch = Number(
      (await runner.run(['git', 'rev-list', '--count', 'feature/deep'], { cwd: deep.dir })).stdout.trim(),
    )
    expect(inCompare).toBe(BRANCH_DEPTH)
    expect(onBranch).toBe(TRUNK_DEPTH + BRANCH_DEPTH)
    expect(onBranch).toBeGreaterThan(inCompare)
  })

  test('a moved head reports no new work when nothing has moved', async () => {
    // The whole assertion in one number. The moved-head answer subtracts the
    // stored compare commit list from the resolved count, so a compare-scoped
    // count gives zero while a branch-scoped one gives the trunk depth — the
    // repository age reported as new work on the branch.
    const harness = makeSurface({ toplevel: deep.dir })
    const review = await harness.surface.createLocalReview({
      baseRef: deep.baseBranch,
      headRef: deep.headBranch,
    })
    const snapshot = await harness.surface.syncPull(review.id)
    expect(snapshot.immutable.commits).toHaveLength(BRANCH_DEPTH)

    const result = await harness.surface.submitReview({
      prNumber: review.id,
      // Deliberately not the current head, so the guard answers rather than
      // proceeding — the answer is what carries the resolved count.
      expectedHeadSha: 'f'.repeat(40),
      event: 'COMMENT',
      body: 'Anything.',
      comments: [],
    })

    expect(result.status).toBe('head_moved')
    if (result.status !== 'head_moved') throw new Error('unreachable')
    expect(result.currentHeadSha).toBe(snapshot.immutable.headSha)
    expect(result.newCommits).toBe(0)
    harness.store.close()
  })

  test('the count git is asked for names the merge-base to head range', async () => {
    const sink: string[][] = []
    const harness = makeSurface({ toplevel: deep.dir, runner: recordingRunner(sink) })
    const review = await harness.surface.createLocalReview({
      baseRef: deep.baseBranch,
      headRef: deep.headBranch,
    })
    const snapshot = await harness.surface.syncPull(review.id)

    sink.length = 0
    await harness.surface.submitReview({
      prNumber: review.id,
      expectedHeadSha: 'f'.repeat(40),
      event: 'COMMENT',
      body: 'Anything.',
      comments: [],
    })

    const counts = sink.filter((argv) => argv.includes('rev-list') && argv.includes('--count'))
    expect(counts).toHaveLength(1)
    expect(counts[0]).toEqual([
      'git',
      'rev-list',
      '--count',
      '--end-of-options',
      `${snapshot.immutable.mergeBaseSha}..${snapshot.immutable.headSha}`,
    ])
    harness.store.close()
  })

  test('no count is ever taken over a single revision rather than a range', async () => {
    // Stated over the SHAPE of every counted operand rather than as a list of
    // the wrong spellings: `--all`, a bare `HEAD`, a branch name and a resolved
    // object name are four ways of asking the same wrong question, and a filter
    // naming three of them would pass on the fourth.
    const sink: string[][] = []
    const harness = makeSurface({ toplevel: deep.dir, runner: recordingRunner(sink) })
    const review = await harness.surface.createLocalReview({
      baseRef: deep.baseBranch,
      headRef: deep.headBranch,
    })
    await harness.surface.syncPull(review.id)
    sink.length = 0
    await harness.surface.submitReview({
      prNumber: review.id,
      expectedHeadSha: 'f'.repeat(40),
      event: 'COMMENT',
      body: 'Anything.',
      comments: [],
    })

    const counted = sink.filter((argv) => argv.includes('--count'))
    expect(counted.length).toBeGreaterThan(0)
    const operands = counted.map((argv) => argv.slice(argv.indexOf('--end-of-options') + 1))
    expect(operands.every((revs) => revs.length === 1 && revs[0].includes('..'))).toBe(true)
    harness.store.close()
  })
})

describe('the default branch has a producer', () => {
  test('a repository with no origin carries the empty string, and nothing throws', async () => {
    // The ordinary state of a purely local review: the marker is derived from
    // origin symbolic HEAD, which a clone with no origin simply does not have.
    const harness = makeSurface({ toplevel: fixture.dir })
    const { snapshot } = await createdAndSynced(harness)
    expect(snapshot.mutable.pull.base.repo.default_branch).toBe('')
    expect(snapshot.mutable.pull.head.repo.default_branch).toBe('')
    harness.store.close()
  })

  test('the empty answer is caused by an absent symref, not by an unset field', async () => {
    // The control for the case above. Without it, "empty" is equally satisfied
    // by a producer that never reads anything at all.
    const branches = await createLocalReviewSurface({
      store: openDirectStore({ dataDir: ':memory:' }),
      runner: createBunCommandRunner(),
      toplevel: fixture.dir,
      repo: REPO,
      session: SESSION,
    }).listBranches()
    expect(branches.filter((branch) => branch.isDefault)).toEqual([])
  })

  test('a resolvable origin HEAD names that branch on both sides of the pull', async () => {
    const origin = await createDeepRepo()
    try {
      const tip = (await seedGit(origin.dir, origin.env, ['rev-parse', 'main'])).trim()
      // A symbolic ref and the remote-tracking branch it names, which is exactly
      // the state a clone carries — no network and no remote configuration are
      // needed to produce it.
      await seedGit(origin.dir, origin.env, ['update-ref', 'refs/remotes/origin/main', tip])
      await seedGit(origin.dir, origin.env, [
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
        'refs/remotes/origin/main',
      ])

      const harness = makeSurface({ toplevel: origin.dir })
      const review = await harness.surface.createLocalReview({
        baseRef: origin.baseBranch,
        headRef: origin.headBranch,
      })
      const snapshot = await harness.surface.syncPull(review.id)
      expect(snapshot.mutable.pull.base.repo.default_branch).toBe('main')
      expect(snapshot.mutable.pull.head.repo.default_branch).toBe('main')
      harness.store.close()
    } finally {
      origin.dispose()
    }
  })
})

describe('syncing', () => {
  test('stores both halves and patches the review sync columns', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const { localId, snapshot } = await createdAndSynced(harness)

    expect(snapshot.prNumber).toBe(localId)
    expect(snapshot.immutable.headSha).toBe(fixture.headSha)
    expect(snapshot.immutable.mergeBaseSha).toBe(fixture.mergeBaseSha)
    expect(harness.surface.getSnapshot(localId)).not.toBeNull()

    const [row] = harness.surface.listLocalReviews()
    expect(row.headSha).toBe(fixture.headSha)
    expect(row.mergeBaseSha).toBe(fixture.mergeBaseSha)
    expect(row.lastSyncedAt).not.toBeNull()
    harness.store.close()
  })

  test('the mutable half carries no submitted reviews and no issue comments', async () => {
    // Both lists are permanently empty on a local review: a submitted summary
    // lives in its own table and there is no conversation tab to hold comments.
    const harness = makeSurface({ toplevel: fixture.dir })
    const { localId, snapshot } = await createdAndSynced(harness)
    expect(snapshot.mutable.reviews).toEqual([])
    expect(snapshot.mutable.issueComments).toEqual([])

    await harness.surface.submitReview({
      prNumber: localId,
      expectedHeadSha: snapshot.immutable.headSha,
      event: 'APPROVE',
      body: 'Approved.',
      comments: [],
    })
    const resynced = await harness.surface.syncPull(localId)
    expect(resynced.mutable.reviews).toEqual([])
    harness.store.close()
  })

  test('a second sync carries the authorship map forward', async () => {
    // The map has no other durable home. Dropping it orphans every local
    // comment permanently: nothing else can decide whether one is the reader own,
    // because no name is stamped into a body and no forge login stands behind a
    // synthesized author.
    const harness = makeSurface({ toplevel: fixture.dir })
    const { localId, snapshot } = await createdAndSynced(harness)

    await harness.surface.submitReview({
      prNumber: localId,
      expectedHeadSha: snapshot.immutable.headSha,
      event: 'COMMENT',
      body: 'One note.',
      comments: [pendingComment(fixture.paths.modified, 2)],
    })

    const afterSubmit = harness.surface.getSnapshot(localId)
    expect(afterSubmit).not.toBeNull()
    const authored = Object.entries(afterSubmit?.mutable.commentAuthors ?? {})
    expect(authored).toHaveLength(1)
    expect(authored[0][1]).toBe(SESSION.human.id)

    const resynced = await harness.surface.syncPull(localId)
    expect(Object.entries(resynced.mutable.commentAuthors ?? {})).toEqual(authored)
    harness.store.close()
  })

  test('a second sync keeps the threads the review already holds', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const { localId, snapshot } = await createdAndSynced(harness)
    await harness.surface.submitReview({
      prNumber: localId,
      expectedHeadSha: snapshot.immutable.headSha,
      event: 'COMMENT',
      body: 'One note.',
      comments: [pendingComment(fixture.paths.modified, 2)],
    })
    const resynced = await harness.surface.syncPull(localId)
    expect(resynced.mutable.threads).toHaveLength(1)
    expect(harness.surface.listThreads(localId)).toHaveLength(1)
    harness.store.close()
  })

  test('a review that names an absent ref is a not-found, not an unprocessable', async () => {
    // A ref resolving to nothing is the thing being named not existing, and no
    // state the caller could put the repository into satisfies the same request
    // without first creating that branch. The other three range failures — one
    // ref given twice, unrelated histories, a shallow clone — describe a target
    // that does exist, and keeping the two codes apart is what lets a client
    // tell "that branch is gone" from "that pair cannot be compared".
    const harness = makeSurface({ toplevel: fixture.dir })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: 'no/such/branch',
    })
    const failure = await harness.surface.syncPull(review.id).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).code).toBe('not_found')
    harness.store.close()
  })

  test('a pair whose two sides sit on one commit is unprocessable, not a not-found', async () => {
    // The control for the row above: both codes have to be reachable from this
    // one verb, or "not_found for a missing ref" would be satisfied by a factory
    // that answered not_found for everything.
    const mirror = `refs/remotes/origin/${fixture.baseBranch}`
    const harness = makeSurface({ toplevel: fixture.dir })
    try {
      const review = await harness.surface.createLocalReview({
        baseRef: fixture.baseBranch,
        headRef: mirror,
      })
      // The remote-tracking ref is pointed at the base branch's own tip, so the
      // pair resolves to two names over one commit rather than to a ref that is
      // missing — the two failures these cases separate.
      await seedGit(fixture.dir, fixture.env, ['update-ref', mirror, fixture.baseSha])
      const failure = await harness.surface.syncPull(review.id).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(ApiError)
      expect((failure as ApiError).code).toBe('unprocessable')
    } finally {
      await seedGit(fixture.dir, fixture.env, ['update-ref', '-d', mirror])
      harness.store.close()
    }
  })

  test('a worktree that cannot be read squashes to a clean flag, never to dirty', async () => {
    // The tri-state reading collapses onto a boolean column HERE and nowhere
    // else, so the direction is this factory's to state. The claim the flag
    // makes is "there is work here the review does not cover"; a probe that
    // could not be answered is not evidence for that claim, and asserting it
    // would raise the banner on every repository whose worktree cannot be
    // inspected — a warning that is always on is a warning nobody reads.
    const harness = makeSurface({ toplevel: fixture.dir, runner: worktreeBlindRunner() })
    const { localId } = await createdAndSynced(harness)
    expect(harness.surface.listLocalReviews().find((row) => row.id === localId)?.dirty).toBe(false)
    harness.store.close()
  })

  test('a genuinely dirty worktree still sets the flag', async () => {
    // The control: without it, "unknown squashes to false" is equally satisfied
    // by a factory that never sets the flag at all.
    const harness = makeSurface({ toplevel: fixture.dir })
    writeFileSync(join(fixture.dir, fixture.paths.modified), 'an uncommitted edit\n')
    try {
      const { localId } = await createdAndSynced(harness)
      expect(harness.surface.listLocalReviews().find((row) => row.id === localId)?.dirty).toBe(true)
    } finally {
      await seedGit(fixture.dir, fixture.env, ['checkout', '--', fixture.paths.modified])
      harness.store.close()
    }
  })

  test('a never-synced review answers null rather than throwing', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    expect(harness.surface.getSnapshot(review.id)).toBeNull()
    harness.store.close()
  })
})

describe('nothing on this path can reach a hosted forge', () => {
  test('the module names no GitHub client type', () => {
    const source = readFileSync(new URL('./local-surface.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\bGithubClient\b/)
  })

  test('the module names no hosted blob read', () => {
    const source = readFileSync(new URL('./local-surface.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\bgetBlobObjects\b/)
  })

  test('the module names no API host', () => {
    const source = readFileSync(new URL('./local-surface.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/api\.github\.com/)
  })

  test('those patterns fire on source that really carries them', () => {
    // The control: a pattern that matched nothing anywhere would make all three
    // absences above pass without asserting anything.
    const probe = [
      "import type { GithubClient } from './github-client'",
      'const many = await github.getBlobObjects(owner, repo, shas)',
      "const base = 'https://api.github.com'",
    ].join('\n')
    expect(probe).toMatch(/\bGithubClient\b/)
    expect(probe).toMatch(/\bgetBlobObjects\b/)
    expect(probe).toMatch(/api\.github\.com/)
  })

  test('a clone that cannot produce an object reports it rather than fetching it', async () => {
    // With a hosted client wired, these bytes would arrive over the network and
    // the snapshot would come back complete. The provisioning call omits the
    // client, so the honest answer is a partial snapshot naming what is missing.
    const harness = makeSurface({ toplevel: fixture.dir, runner: blobBlindRunner() })
    const { snapshot } = await createdAndSynced(harness)
    expect(snapshot.partial).not.toBeNull()
    expect(snapshot.partial?.missingBlobShas.length).toBeGreaterThan(0)
    expect(snapshot.syncStats?.blobsFetched).toBe(0)
    harness.store.close()
  })

  test('a readable clone provisions every blob with no hosted request at all', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const { snapshot } = await createdAndSynced(harness)
    expect(snapshot.partial).toBeNull()
    expect(snapshot.syncStats?.blobsFetched).toBe(0)
    expect(snapshot.syncStats?.requests).toBe(0)
    harness.store.close()
  })
})

describe('drafts, viewed marks and reconcile', () => {
  function draftFor(localId: number, snapshot: Snapshot, humanId: string): ReviewDraft {
    return {
      humanId,
      prNumber: localId,
      headSha: snapshot.immutable.headSha,
      compareKey: snapshot.immutable.compareKey,
      body: 'Draft body.',
      event: 'COMMENT',
      comments: [],
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    }
  }

  test('a saved draft is keyed to the session human, never to the body claim', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const { localId, snapshot } = await createdAndSynced(harness)
    const stored = harness.surface.saveDraft(draftFor(localId, snapshot, 'somebody.else@example.test'))
    expect(stored.humanId).toBe(SESSION.human.id)
    expect(harness.surface.getDraft(localId)?.humanId).toBe(SESSION.human.id)
    harness.store.close()
  })

  test('no draft is stored under the id the body claimed', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const { localId, snapshot } = await createdAndSynced(harness)
    harness.surface.saveDraft(draftFor(localId, snapshot, 'somebody.else@example.test'))
    expect(harness.store.getLocalDraft('somebody.else@example.test', localId)).toBeNull()
    harness.store.close()
  })

  test('discarding a draft that does not exist is not an error', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    expect(() => harness.surface.discardDraft(review.id)).not.toThrow()
    harness.store.close()
  })

  test('viewed marks round-trip under the session human key', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const { localId } = await createdAndSynced(harness)
    const state = harness.surface.setFileViewed(localId, fixture.paths.modified, true, null)
    expect(state[fixture.paths.modified].viewed).toBe(true)
    expect(harness.surface.getFileViewed(localId)).toEqual(state)
    expect(harness.store.getLocalViewed(SESSION.human.id, localId)).toEqual(state)
    harness.store.close()
  })

  test('reconcile classifies the draft against the local snapshot', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const { localId, snapshot } = await createdAndSynced(harness)
    harness.surface.saveDraft({
      ...draftFor(localId, snapshot, SESSION.human.id),
      comments: [pendingComment(fixture.paths.modified, 2)],
    })
    const report = harness.surface.reconcileDraft(localId)
    expect(report.prNumber).toBe(localId)
    expect(report.currentHeadSha).toBe(snapshot.immutable.headSha)
    expect(report.results).toHaveLength(1)
    harness.store.close()
  })

  test('reconcile reads the local draft, not the pull-request one', async () => {
    // The two keyspaces are separate tables. A reconcile wired to the
    // pull-request draft reader finds nothing here and refuses, so a report at
    // all is the proof that the local reader is the one behind it.
    const harness = makeSurface({ toplevel: fixture.dir })
    const { localId, snapshot } = await createdAndSynced(harness)
    harness.surface.saveDraft(draftFor(localId, snapshot, SESSION.human.id))
    expect(harness.store.getDraft(SESSION.human.id, localId)).toBeNull()
    expect(harness.surface.reconcileDraft(localId).draftHeadSha).toBe(snapshot.immutable.headSha)
    harness.store.close()
  })
})

describe('the remaining write verbs reach the local sink', () => {
  test('a reply appends to the thread a submit created', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const { localId, snapshot } = await createdAndSynced(harness)
    await harness.surface.submitReview({
      prNumber: localId,
      expectedHeadSha: snapshot.immutable.headSha,
      event: 'COMMENT',
      body: 'One note.',
      comments: [pendingComment(fixture.paths.modified, 2)],
    })
    const [thread] = harness.surface.listThreads(localId)
    const reply = await harness.surface.replyToThread(localId, thread.id, 'Agreed.')
    expect(reply.body).toBe('Agreed.')
    expect(harness.surface.listThreads(localId)[0].comments).toHaveLength(2)
    harness.store.close()
  })

  test('resolving a thread flips its stored flag', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const { localId, snapshot } = await createdAndSynced(harness)
    await harness.surface.submitReview({
      prNumber: localId,
      expectedHeadSha: snapshot.immutable.headSha,
      event: 'COMMENT',
      body: 'One note.',
      comments: [pendingComment(fixture.paths.modified, 2)],
    })
    const [thread] = harness.surface.listThreads(localId)
    const resolved = await harness.surface.resolveThread(localId, thread.id, true)
    expect(resolved.isResolved).toBe(true)
    expect(harness.surface.listThreads(localId)[0].isResolved).toBe(true)
    harness.store.close()
  })

  test('a reaction moves exactly one count on the addressed comment', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const { localId, snapshot } = await createdAndSynced(harness)
    await harness.surface.submitReview({
      prNumber: localId,
      expectedHeadSha: snapshot.immutable.headSha,
      event: 'COMMENT',
      body: 'One note.',
      comments: [pendingComment(fixture.paths.modified, 2)],
    })
    const [thread] = harness.surface.listThreads(localId)
    const rollup = await harness.surface.addReaction(localId, thread.comments[0].id, 'heart')
    expect(rollup.heart).toBe(1)
    expect(rollup.total_count).toBe(1)
    harness.store.close()
  })
})
