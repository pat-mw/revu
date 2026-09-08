/**
 * The assembled local review surface: what it wires together, and the wirings
 * that are wrong in ways no type could notice.
 *
 * Every case here drives a REAL repository on disk through the real hardened git
 * seam and a real store, because most of the claims below are about what git was
 * actually asked. A fake runner would let a wrongly scoped revision pass as a
 * string nobody compared against a repository.
 *
 * ## The wirings
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
 *
 * **A review answers only the repository that owns it.** One data directory —
 * and therefore one store — is shared by every repository, and review ids are
 * minted from one monotonic mark across all of them, so an id-keyed verb that
 * read the store by id alone would act on another repository's review with this
 * repository's branches, worktree and session. Every id-keyed verb, reads and
 * writes alike, must answer a foreign id with the same not-found an absent id
 * answers. One of them — the draft reconcile — needs a case of its own, because
 * the reconcile it delegates to answers that same not-found by itself whenever
 * the caller holds no draft: only a foreign review the caller DOES hold a draft
 * on can tell the guard apart from the delegate's own refusal.
 *
 * **A data directory that lost its content is answered, not reported as a
 * broken daemon.** Every verb that reads a snapshot meets the same absence when
 * the store no longer holds the immutable half its envelope names, and every one
 * of them owes the same answer: the typed not-found that names re-syncing as the
 * repair. Each case here asserts both halves of that — the refusal, and that
 * performing the repair makes the identical call succeed — because a message
 * naming a remedy is a promise, and a promise nothing checks is wording. A
 * positive control sits alongside them: the unwrapped store read still throws in
 * the same state, so none of the cases can be green over a fixture that never
 * reached it.
 *
 * **Head resolution failures on ordinary repository states are typed.** A
 * branch deleted after its review was created, and a recorded merge base the
 * clone can no longer count from, are states a user can reach without touching
 * this codebase. A bare error there escapes to the transport's terminal
 * catch-all and is answered as an unreachable broker — on a daemon that has no
 * broker at all — so both must refuse with a typed `ApiError` instead.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
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
import { listPins, pinRefsFor } from './local-pins'
import { localSnapshot } from './local-write-fakes'
import type { DirectStore } from './store'
import { StoreUnreadableError, openDirectStore } from './store'

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
      'getLocalReview',
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

describe('a review answers only the repository that owns it', () => {
  /**
   * Two surfaces over ONE store, exactly as two repositories pointing their
   * daemons at one shared data directory produce. Both are given the SAME
   * toplevel on purpose: branch names collide across repositories far more
   * readily than pull-request numbers do, so the intruding repository really
   * does carry branches spelled identically to the pair the review records —
   * which is the state in which an unscoped store read does not merely leak a
   * row, it resolves the other repository's refs, rewrites its SHAs, and lands
   * durable threads under its id.
   */
  const OWNER_REPO = 'acme/api'
  const INTRUDER_REPO = 'acme/web'
  const INTRUDER_NOW = '2026-03-04T05:06:07.000Z'
  const INTRUDER_SESSION: Session = {
    human: {
      id: 'mallory.finch@example.test',
      name: 'Mallory Finch',
      role: 'contractor',
      email: 'mallory.finch@example.test',
    },
    brokerLogin: '',
    workspace: 'local',
  }

  let store: DirectStore
  let owner: Harness
  let intruder: Harness
  let victimId = 0
  let victimSnapshot: Snapshot
  let victimThreadId = ''
  let victimCommentId = 0
  /** The owning repository's durable rows, serialized before any sweep runs. */
  let victimStateBefore = ''

  /** Everything durable the owning review holds, in one comparable string. */
  function victimStateNow(): string {
    return JSON.stringify({
      review: store.getLocalReview(victimId),
      snapshot: store.getLocalSnapshot(victimId),
      threads: store.listLocalThreads(victimId),
    })
  }

  beforeAll(async () => {
    store = openDirectStore({ dataDir: ':memory:' })
    owner = makeSurface({ toplevel: fixture.dir, store, repo: OWNER_REPO })
    intruder = makeSurface({
      toplevel: fixture.dir,
      store,
      repo: INTRUDER_REPO,
      session: INTRUDER_SESSION,
      // A clock of its own, so any write that slipped through would stamp a
      // timestamp the serialized-state comparison below cannot miss.
      now: () => INTRUDER_NOW,
    })
    const review = await owner.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    victimId = review.id
    victimSnapshot = await owner.surface.syncPull(victimId)
    await owner.surface.submitReview({
      prNumber: victimId,
      expectedHeadSha: victimSnapshot.immutable.headSha,
      event: 'COMMENT',
      body: 'One note.',
      comments: [pendingComment(fixture.paths.modified, 2)],
    })
    const [thread] = owner.surface.listThreads(victimId)
    victimThreadId = thread.id
    victimCommentId = thread.comments[0].id
    victimStateBefore = victimStateNow()
  }, 30_000)

  afterAll(() => {
    store.close()
  })

  /**
   * The verbs that carry no review id, exempt from the sweep by construction:
   * creation has no id yet to be foreign, and the two listings are scoped at
   * their source — the review listing by the repository key, the branch listing
   * by reading git alone. Everything else the surface exports takes a review id
   * somewhere in its arguments and must refuse a foreign one.
   */
  const ID_FREE_VERBS = ['createLocalReview', 'listBranches', 'listLocalReviews'] as const

  /**
   * One driver per id-keyed verb, each aimed at the given surface with the
   * given review id. The thread and comment ids are the victim's REAL ones, so
   * a verb that read the store before checking ownership would find its target
   * and answer rather than refuse.
   */
  const FOREIGN_CALLS: Record<string, (surface: LocalReviewSurface, id: number) => unknown> = {
    syncPull: (surface, id) => surface.syncPull(id),
    // The richer sync is swept in its own right rather than trusted to inherit
    // the refusal from the verb that delegates to it: the delegation runs the
    // other way round, so an ownership check placed only on `syncPull` would
    // leave this one open.
    syncLocalReview: (surface, id) => surface.syncLocalReview(id),
    getLocalReview: (surface, id) => surface.getLocalReview(id),
    getSnapshot: (surface, id) => surface.getSnapshot(id),
    getDraft: (surface, id) => surface.getDraft(id),
    saveDraft: (surface, id) =>
      surface.saveDraft({
        humanId: INTRUDER_SESSION.human.id,
        prNumber: id,
        headSha: victimSnapshot.immutable.headSha,
        compareKey: victimSnapshot.immutable.compareKey,
        body: 'Draft text aimed across repositories.',
        event: 'COMMENT',
        comments: [],
        createdAt: INTRUDER_NOW,
        updatedAt: INTRUDER_NOW,
      }),
    discardDraft: (surface, id) => surface.discardDraft(id),
    reconcileDraft: (surface, id) => surface.reconcileDraft(id),
    getFileViewed: (surface, id) => surface.getFileViewed(id),
    setFileViewed: (surface, id) => surface.setFileViewed(id, fixture.paths.modified, true, null),
    submitReview: (surface, id) =>
      surface.submitReview({
        prNumber: id,
        expectedHeadSha: victimSnapshot.immutable.headSha,
        event: 'COMMENT',
        body: 'A verdict aimed across repositories.',
        comments: [pendingComment(fixture.paths.modified, 2)],
      }),
    replyToThread: (surface, id) =>
      surface.replyToThread(id, victimThreadId, 'A reply aimed across repositories.'),
    resolveThread: (surface, id) => surface.resolveThread(id, victimThreadId, true),
    addReaction: (surface, id) => surface.addReaction(id, victimCommentId, '+1'),
    listThreads: (surface, id) => surface.listThreads(id),
  }

  /** How a driven verb answered, whether it threw synchronously or rejected. */
  const refusal = (run: () => unknown): Promise<string> =>
    Promise.resolve()
      .then(run)
      .then(
        () => 'answered',
        (error: unknown) =>
          error instanceof ApiError ? `threw ${error.code}` : 'threw an untyped error',
      )

  /**
   * The refusal with its code AND its sentence, the id normalized out so a
   * foreign id's answer can be compared byte for byte against an absent one's.
   */
  const normalizedRefusal = (run: () => unknown, id: number): Promise<string> =>
    Promise.resolve()
      .then(run)
      .then(
        () => 'answered',
        (error: unknown) => {
          if (!(error instanceof ApiError)) return 'threw an untyped error'
          return `${error.code}: ${error.message.split(String(id)).join('<id>')}`
        },
      )

  test('every verb the surface exports is classified: swept as id-keyed, or exempt by name', () => {
    // The sweep's coverage is derived from the surface's own key set rather
    // than hand-listed: a verb added later lands in neither list and fails
    // here, so it cannot ship unswept. The exemption list is deliberately
    // short and written out — moving a verb onto it is a reviewed decision,
    // never a default.
    expect([...ID_FREE_VERBS, ...Object.keys(FOREIGN_CALLS)].sort()).toEqual(
      Object.keys(owner.surface).sort(),
    )
  })

  test('the owning repository still answers its own id', () => {
    // The control that stops the sweep from being satisfied by a surface that
    // refuses everything: the same id, asked through the owner, answers.
    expect(owner.surface.getSnapshot(victimId)).not.toBeNull()
    expect(owner.surface.listThreads(victimId)).toHaveLength(1)
  })

  test('the listing never offers another repository review', () => {
    expect(intruder.surface.listLocalReviews()).toEqual([])
    expect(owner.surface.listLocalReviews().map((row) => row.id)).toEqual([victimId])
  })

  test('every id-keyed verb answers a foreign id with not_found — reads and writes alike', async () => {
    // Collected and compared in one shot rather than asserted per verb, so a
    // verb that started answering is NAMED instead of aborting the sweep
    // before the verbs after it are driven.
    const outcomes: (readonly [string, string])[] = []
    for (const [verb, call] of Object.entries(FOREIGN_CALLS)) {
      outcomes.push([verb, await refusal(() => call(intruder.surface, victimId))])
    }
    expect(outcomes).toEqual(
      Object.keys(FOREIGN_CALLS).map((verb) => [verb, 'threw not_found'] as const),
    )
  })

  test('a foreign id is indistinguishable from an absent one, verb by verb', async () => {
    // Any distinguishable answer — a different code, a different sentence —
    // confirms to one repository's caller that the id exists somewhere else.
    // Both refusals are captured with the id normalized out and compared byte
    // for byte. The absent id sits in the review band above anything this
    // store has minted.
    const absentId = victimId + 5000
    const contrasts: (readonly [string, string, string])[] = []
    for (const [verb, call] of Object.entries(FOREIGN_CALLS)) {
      const foreign = await normalizedRefusal(() => call(intruder.surface, victimId), victimId)
      const absent = await normalizedRefusal(() => call(intruder.surface, absentId), absentId)
      contrasts.push([verb, foreign, absent])
    }
    expect(contrasts).toEqual(contrasts.map(([verb, foreign]) => [verb, foreign, foreign]))
    // The shared answer really is the typed not-found, not some other string
    // both halves happen to agree on.
    expect(contrasts.every(([, foreign]) => foreign.startsWith('not_found: '))).toBe(true)
  })

  test('the sweeps above left the owning repository review byte-identical', () => {
    // The durable half of the claim. A refusal that answered not_found AFTER
    // reading git and writing the store would pass every sweep above and still
    // corrupt: the row's SHAs restamped, a thread landed under the owner's id.
    expect(victimStateNow()).toBe(victimStateBefore)
    // Nothing landed under the intruder's own keys either.
    expect(store.getLocalDraft(INTRUDER_SESSION.human.id, victimId)).toBeNull()
  })
})

describe('head resolution failures on ordinary repository states are typed', () => {
  /**
   * A runner that refuses only the commit count and delegates everything else,
   * standing in for a recorded merge base the clone can no longer count from —
   * a history rewrite or an aggressive prune between two syncs. Everything up
   * to the count, the sync included, runs against the real repository.
   */
  function countBlindRunner(): CommandRunner {
    const real = createBunCommandRunner()
    return {
      run(args: string[], opts?: { cwd?: string }): Promise<CommandResult> {
        if (args.includes('rev-list') && args.includes('--count')) {
          return Promise.resolve({ ok: false, code: 128, stdout: '', stderr: 'bad revision' })
        }
        return real.run(args, opts)
      },
    }
  }

  test('a head branch deleted after the review was created answers a typed not-found naming the ref', async () => {
    // The transport maps any bare error to `broker_unreachable` at 500, so an
    // untyped throw here tells the reviewer a broker is down on a daemon that
    // has never had one. A deleted branch is an ordinary state — the review
    // outlives the ref pair it records — and the honest answer names the ref
    // that is gone.
    const doomed = await createFixtureRepo()
    const harness = makeSurface({ toplevel: doomed.dir })
    try {
      const review = await harness.surface.createLocalReview({
        baseRef: doomed.baseBranch,
        headRef: doomed.headBranch,
      })
      const snapshot = await harness.surface.syncPull(review.id)
      await harness.surface.submitReview({
        prNumber: review.id,
        expectedHeadSha: snapshot.immutable.headSha,
        event: 'COMMENT',
        body: 'One note.',
        comments: [pendingComment(doomed.paths.modified, 2)],
      })
      const [thread] = harness.surface.listThreads(review.id)
      const draft = harness.surface.saveDraft({
        humanId: SESSION.human.id,
        prNumber: review.id,
        headSha: snapshot.immutable.headSha,
        compareKey: snapshot.immutable.compareKey,
        body: 'Unsent text that must survive the failure.',
        event: 'COMMENT',
        comments: [],
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      })

      // The fixture leaves its worktree on the base branch, so the head branch
      // deletes cleanly — the state a reviewer reaches by tidying branches
      // after the work merged elsewhere.
      await seedGit(doomed.dir, doomed.env, ['branch', '-q', '-D', doomed.headBranch])

      const submitFailure = await harness.surface
        .submitReview({
          prNumber: review.id,
          expectedHeadSha: snapshot.immutable.headSha,
          event: 'COMMENT',
          body: 'A verdict on a branch that is gone.',
          comments: [],
        })
        .catch((cause: unknown) => cause)
      expect(submitFailure).toBeInstanceOf(ApiError)
      expect((submitFailure as ApiError).code).toBe('not_found')
      expect((submitFailure as ApiError).message).toContain(`refs/heads/${doomed.headBranch}`)

      const replyFailure = await harness.surface
        .replyToThread(review.id, thread.id, 'A reply on a branch that is gone.')
        .catch((cause: unknown) => cause)
      expect(replyFailure).toBeInstanceOf(ApiError)
      expect((replyFailure as ApiError).code).toBe('not_found')
      expect((replyFailure as ApiError).message).toContain(`refs/heads/${doomed.headBranch}`)

      // The failed submit cost the reviewer none of their unsent text.
      const kept = harness.surface.getDraft(review.id)
      expect(JSON.stringify(kept)).toBe(JSON.stringify(draft))
    } finally {
      harness.store.close()
      doomed.dispose()
    }
  }, 30_000)

  test('a compare whose commits cannot be counted answers a typed unprocessable', async () => {
    // The other head-resolution read: `rev-parse` still answers — the branch
    // exists — but the range from the recorded merge base cannot be counted.
    // The sync path never asks for a count, so the same blind runner carries
    // the whole flow up to the one read this case is about.
    const harness = makeSurface({ toplevel: fixture.dir, runner: countBlindRunner() })
    const { localId, snapshot } = await createdAndSynced(harness)
    const failure = await harness.surface
      .submitReview({
        prNumber: localId,
        expectedHeadSha: snapshot.immutable.headSha,
        event: 'COMMENT',
        body: 'A verdict over an uncountable range.',
        comments: [],
      })
      .catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).code).toBe('unprocessable')
    harness.store.close()
  })
})

describe('reconcileDraft resolves ownership before the reconcile it delegates to', () => {
  /**
   * The one verb whose ownership guard a sweep over foreign ids cannot see.
   *
   * Every other id-keyed verb reaches a store read that would visibly answer
   * for a review this repository does not own. `reconcileDraft` reaches one
   * that USUALLY refuses on its own: the delegate's first act is to look for a
   * draft under `(this human, that id)`, and a caller from another repository
   * normally has none, so the delegate answers the same typed not-found the
   * guard would have — and a sweep comparing the two learns nothing about
   * whether the guard is there at all.
   *
   * That coincidence has a gap in it, and the gap is what this block drives.
   * The draft is keyed by human and id, the snapshot by id alone, and NEITHER
   * key carries a repository. One human whose daemons serve two repositories
   * out of a single data directory — the arrangement the whole ownership rule
   * exists for — really can hold a draft on a review the other repository
   * owns. With both rows present the delegate has everything it needs and
   * answers in full: the owning repository's head SHA, its files, its commits.
   * Only the guard above it refuses.
   *
   * Two surfaces are built over one store, differing in their repository
   * identity and in NOTHING else — same store, same session, same human, same
   * review id — so the refusal can be attributed to the repository scope
   * rather than to any other difference between them.
   */
  const OWNING_REPO = 'acme/api'
  const NEIGHBOUR_REPO = 'acme/web'

  /**
   * The head the owning repository's snapshot records. Distinct from every
   * other SHA in this file, so a report carrying it can only have been built
   * from that repository's review.
   */
  const OWNED_HEAD_SHA = 'ab'.repeat(20)

  /**
   * A directory no case here reads. Reconcile is three store reads and a
   * classification; it spawns nothing, and the runner below refuses every
   * command, so a path that grew a git read would fail loudly rather than
   * quietly succeed against whatever this happens to name.
   */
  const UNREAD_TOPLEVEL = join(tmpdir(), 'revu-local-surface-reconcile-scope')

  /**
   * The store with the name of every method called on it recorded, in order.
   * The name is pushed BEFORE the call runs, so an attempted read is recorded
   * even when it throws — which is what makes "nothing after the ownership
   * read happened" an assertion over evidence rather than over an absence.
   */
  function recordingStore(): { store: DirectStore; calls: string[] } {
    const base = openDirectStore({ dataDir: ':memory:' })
    const calls: string[] = []
    const source = base as unknown as Record<string, unknown>
    const wrapped: Record<string, unknown> = {}
    for (const name of Object.keys(base)) {
      const member = source[name]
      wrapped[name] =
        typeof member === 'function'
          ? (...args: unknown[]): unknown => {
              calls.push(name)
              return (member as (...rest: unknown[]) => unknown).apply(base, args)
            }
          : member
    }
    return { store: wrapped as unknown as DirectStore, calls }
  }

  interface ScopeFixture {
    store: DirectStore
    /** Store method names, in call order, since the two surfaces were built. */
    calls: string[]
    /** The review `OWNING_REPO` holds, and that `NEIGHBOUR_REPO` must not reach. */
    reviewId: number
    owner: LocalReviewSurface
    neighbour: LocalReviewSurface
  }

  /**
   * One review owned by `OWNING_REPO`, carrying both rows the delegate reads: a
   * snapshot, and a draft under the human BOTH surfaces are keyed by.
   */
  function seedSharedStore(): ScopeFixture {
    const { store, calls } = recordingStore()
    const review = store.createLocalReview({
      repo: OWNING_REPO,
      baseRef: 'refs/heads/main',
      headRef: 'refs/heads/feature/x',
      title: 'feature/x',
    })
    const snapshot = localSnapshot({
      localId: review.id,
      headSha: OWNED_HEAD_SHA,
      at: FIXED_NOW,
    })
    store.putLocalSnapshot(snapshot)
    const draft: ReviewDraft = {
      humanId: SESSION.human.id,
      prNumber: review.id,
      headSha: OWNED_HEAD_SHA,
      compareKey: snapshot.immutable.compareKey,
      body: 'Notes not sent yet.',
      event: 'COMMENT',
      comments: [],
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    }
    store.putLocalDraft(draft)

    const runner: CommandRunner = {
      run: (): Promise<CommandResult> =>
        Promise.reject(new Error('reconcileDraft must spawn no command')),
    }
    const surfaceFor = (repo: string): LocalReviewSurface =>
      makeSurface({ toplevel: UNREAD_TOPLEVEL, store, runner, repo }).surface
    const owner = surfaceFor(OWNING_REPO)
    const neighbour = surfaceFor(NEIGHBOUR_REPO)

    // The seeding writes belong to no claim below; only what the driven verb
    // does is measured.
    calls.length = 0
    return { store, calls, reviewId: review.id, owner, neighbour }
  }

  test('the owning repository gets the full report — the delegate behind the guard is reachable', () => {
    // The control, and the load-bearing half of the pair: it establishes that
    // with these exact rows in place the delegate DOES answer, so the refusal
    // below is a decision rather than the delegate failing for its own reasons.
    const { store, reviewId, owner, calls } = seedSharedStore()
    const report = owner.reconcileDraft(reviewId)
    expect(report.prNumber).toBe(reviewId)
    expect(report.draftHeadSha).toBe(OWNED_HEAD_SHA)
    expect(report.currentHeadSha).toBe(OWNED_HEAD_SHA)
    // The ownership read ran first here too, and the delegate's two reads
    // followed it rather than replacing it.
    expect(calls).toEqual(['getLocalReview', 'getLocalDraft', 'getLocalSnapshot'])
    store.close()
  })

  test('the neighbouring repository is refused, though the delegate would have answered', () => {
    const { store, reviewId, neighbour } = seedSharedStore()
    let refused = false
    let answered: unknown = null
    try {
      answered = neighbour.reconcileDraft(reviewId)
    } catch (error) {
      refused = true
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).code).toBe('not_found')
      // The ownership sentence, not the delegate's missing-draft one: the
      // draft is right there, so the delegate had no reason to say otherwise.
      expect((error as ApiError).message).toBe(`No local review carries the id ${reviewId}.`)
    }
    expect(refused).toBe(true)
    // Asserted separately because it is the claim the delegate cannot satisfy:
    // a report here would carry the owning repository's head SHA out to a
    // repository with no right to know the review exists.
    expect(answered).toBeNull()
    store.close()
  })

  test('the refusal precedes every store read the delegate would make', () => {
    const { store, reviewId, neighbour, calls } = seedSharedStore()
    const outcome = ((): string => {
      try {
        neighbour.reconcileDraft(reviewId)
        return 'answered'
      } catch {
        return 'refused'
      }
    })()
    expect(outcome).toBe('refused')
    // The ownership read, and nothing after it. The draft and the snapshot are
    // both present and both reachable by keys that carry no repository, so a
    // guard that ran second — or not at all — shows up here as the two extra
    // reads.
    expect(calls).toEqual(['getLocalReview'])
    store.close()
  })
})

// ————————————————————————————————————————————————————————————————————————————
// Object pinning happens before the first object is read.
// ————————————————————————————————————————————————————————————————————————————

/**
 * A runner that fails every `update-ref` and delegates everything else.
 *
 * The pin is the one step of a sync whose failure must not become the sync's
 * failure: a review whose objects are unpinned is completely readable today and
 * merely has no retention guarantee. Standing that case up needs a git that
 * refuses exactly the pin and answers every other read normally, so the
 * resulting snapshot can be compared field for field against the pinned one.
 */
function pinBlindRunner(): CommandRunner {
  const real = createBunCommandRunner()
  return {
    run(args: string[], opts?: { cwd?: string }): Promise<CommandResult> {
      if (args.includes('update-ref')) {
        return Promise.resolve({
          ok: false,
          code: 128,
          stdout: '',
          stderr: 'fatal: cannot lock ref',
        })
      }
      return real.run(args, opts)
    },
  }
}

/** The index of the first recorded argv containing `token`, or -1. */
function firstArgvWith(sink: string[][], token: string): number {
  return sink.findIndex((argv) => argv.some((arg) => arg.includes(token)))
}

describe('a sync pins the objects it is about to read', () => {
  test('the pin is written before the first object read', async () => {
    // An ordering assertion, not a was-it-called assertion. A prune landing
    // between the diff that produces the blob SHAs and the cat-file reads that
    // fetch their bytes turns every one of those SHAs into a missing entry,
    // with no hosted tier to recover them. Pinning first closes that window;
    // pinning afterwards does not close it at all.
    const sink: string[][] = []
    const harness = makeSurface({ toplevel: fixture.dir, runner: recordingRunner(sink) })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    await harness.surface.syncPull(review.id)

    const pin = firstArgvWith(sink, 'update-ref')
    const diff = firstArgvWith(sink, 'diff')
    const catFile = firstArgvWith(sink, 'cat-file')
    // The `>= 0` guard is what stops two absent commands comparing equal: with
    // it, "no pin was written at all" is red rather than vacuously ordered.
    expect(pin).toBeGreaterThanOrEqual(0)
    expect(diff).toBeGreaterThanOrEqual(0)
    expect(catFile).toBeGreaterThanOrEqual(0)
    expect(pin).toBeLessThan(diff)
    expect(pin).toBeLessThan(catFile)
    harness.store.close()
  }, 30_000)

  test('a successful pin is reported on the sync outcome', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    const outcome = await harness.surface.syncLocalReview(review.id)
    expect(outcome.pin?.ok).toBe(true)
    harness.store.close()
  }, 30_000)

  test('a failed pin is not a failed sync, and is reported', async () => {
    // Paired with the row above: without a success case on the same field, a
    // failure assertion is satisfied by a field that is always falsy or absent.
    const harness = makeSurface({ toplevel: fixture.dir, runner: pinBlindRunner() })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    const outcome = await harness.surface.syncLocalReview(review.id)
    expect(outcome.pin?.ok).toBe(false)
    expect(outcome.pin?.reason).toBe('git-failed')
    // The snapshot is complete regardless: the pin buys retention, not content.
    expect(outcome.snapshot.partial).toBeNull()
    harness.store.close()
  }, 30_000)

  test('the pin outcome never leaks into partial', async () => {
    // `partial` means content is missing. An unpinned-but-complete snapshot is
    // not partial, and folding the pin outcome in would make a retention
    // failure indistinguishable from an unreadable object — the exact confusion
    // the separate field exists to prevent. Asserted by comparing the two runs
    // rather than by restating the rule.
    const pinned = makeSurface({ toplevel: fixture.dir })
    const pinnedReview = await pinned.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    const pinnedOut = await pinned.surface.syncLocalReview(pinnedReview.id)

    const unpinned = makeSurface({ toplevel: fixture.dir, runner: pinBlindRunner() })
    const unpinnedReview = await unpinned.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    const unpinnedOut = await unpinned.surface.syncLocalReview(unpinnedReview.id)

    expect(unpinnedOut.snapshot.partial).toEqual(pinnedOut.snapshot.partial)
    expect(unpinnedOut.snapshot.immutable).toEqual(pinnedOut.snapshot.immutable)
    // ...and the two runs genuinely differ on the field that should differ.
    expect(unpinnedOut.pin?.ok).not.toBe(pinnedOut.pin?.ok)
    pinned.store.close()
    unpinned.store.close()
  }, 30_000)

  test('the pin names the compare the snapshot was built from', async () => {
    const harness = makeSurface({ toplevel: fixture.dir })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    const outcome = await harness.surface.syncLocalReview(review.id)
    const listed = await listPins(harness.deps.runner, fixture.dir, review.id)
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const expected = pinRefsFor(review.id, outcome.snapshot.immutable.compareKey)
    expect([...listed.pins].map((p) => p.ref).sort()).toEqual(
      [expected.base, expected.head].sort(),
    )
    expect(listed.pins.find((p) => p.ref === expected.head)?.objectName).toBe(
      outcome.snapshot.immutable.headSha,
    )
    harness.store.close()
  }, 30_000)

  test('syncPull returns exactly the outcome snapshot', async () => {
    // The contract-shaped method stays contract-shaped: the pin rides an
    // internal seam, and nothing about it reaches the wire type.
    const harness = makeSurface({ toplevel: fixture.dir })
    const review = await harness.surface.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    const viaSyncPull = await harness.surface.syncPull(review.id)
    expect(Object.keys(viaSyncPull)).not.toContain('pin')
    harness.store.close()
  }, 30_000)
})

// ————————————————————————————————————————————————————————————————————————————
// A data directory that no longer holds the content its reviews were built from.
// ————————————————————————————————————————————————————————————————————————————

/** The body of the draft the fixture below saves, so its survival is pinned to a literal. */
const SURVIVING_DRAFT_BODY = 'Unsubmitted text, written before the content went missing.'

/** One review in the failing state, plus every id a verb needs to reach it. */
interface LostContent {
  readonly harness: Harness
  readonly localId: number
  /**
   * The head the review was synced at. The removal does not move it, so one
   * value serves the refused call and the repeated call after the repair.
   */
  readonly headSha: string
  /** A thread that really exists, created by a submit while the content was whole. */
  readonly threadId: string
  /** The root comment of that thread. */
  readonly commentId: number
  dispose(): void
}

/**
 * A synced local review with one submitted thread, whose immutable half is then
 * removed from the store while everything else it owns stays where it was.
 *
 * On a real data directory rather than an in-memory one, because the removal is
 * a second connection deleting rows behind the surface's back and a private
 * in-memory database admits no second connection. Emptying the shared
 * content-addressed table is what a data directory that was moved, restored from
 * a partial backup, or pruned leaves behind: the envelope still names a compare
 * key and the row that key addresses is not there. Deleting the review's own row
 * instead would be a different fixture, since an absent review is already a
 * clean answer.
 *
 * The submit runs BEFORE the removal so the thread and the comment the reply,
 * the resolve and the reaction address are real. Invented ids would make every
 * refusal below pass for the wrong reason — those three verbs answer an unknown
 * id with a not-found of their own — and would leave the repaired half of each
 * case with nothing to succeed against.
 */
async function reviewWithItsContentRemoved(): Promise<LostContent> {
  const dataDir = mkdtempSync(join(tmpdir(), 'revu-local-write-rebuild-'))
  const seeding = makeSurface({ toplevel: fixture.dir, store: openDirectStore({ dataDir }) })
  const { localId, snapshot } = await createdAndSynced(seeding)
  await seeding.surface.submitReview({
    prNumber: localId,
    expectedHeadSha: snapshot.immutable.headSha,
    event: 'COMMENT',
    body: 'One note, written while the content was still here.',
    comments: [pendingComment(fixture.paths.modified, 2)],
  })
  const [seeded] = seeding.surface.listThreads(localId)

  // Saved after the submit, which deletes any draft it succeeds on. A draft that
  // the seeding consumed would make the survival assertion below vacuous.
  seeding.surface.saveDraft({
    humanId: SESSION.human.id,
    prNumber: localId,
    headSha: snapshot.immutable.headSha,
    compareKey: snapshot.immutable.compareKey,
    body: SURVIVING_DRAFT_BODY,
    event: 'COMMENT',
    comments: [pendingComment(fixture.paths.modified, 4)],
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  })
  seeding.store.close()

  const raw = new Database(join(dataDir, 'direct.sqlite'))
  raw.run('DELETE FROM immutables')
  raw.close()

  const harness = makeSurface({ toplevel: fixture.dir, store: openDirectStore({ dataDir }) })
  return {
    harness,
    localId,
    headSha: snapshot.immutable.headSha,
    threadId: seeded.id,
    commentId: seeded.comments[0].id,
    dispose: (): void => {
      harness.store.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/**
 * Runs a verb that must refuse and hands the refusal back typed.
 *
 * A capture rather than a `toThrow` matcher because every case below asserts
 * three separate things about the same error — its class, its contract code, and
 * the phrase that says which refusal it is — and a matcher proving only that
 * something was thrown would let a different refusal satisfy all three.
 */
async function refusalFrom(verb: () => Promise<unknown>): Promise<ApiError> {
  let thrown: unknown
  try {
    await verb()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(ApiError)
  // Stated rather than left implied: these two classes are what separate
  // "rebuild this" from "your daemon is broken", and the transport maps only one
  // of them to a 500.
  expect(thrown).not.toBeInstanceOf(StoreUnreadableError)
  return thrown as ApiError
}

/**
 * The refusal a verb owes when the content behind the review is gone: the code a
 * client routes on, and the wording that names the repair.
 *
 * The second phrase is pinned as a literal because the code and the word
 * "re-sync" alone cannot identify this refusal — a thread that does not exist
 * answers `not_found` too, and more than one refusal on this surface names
 * syncing as its remedy. This sentence belongs to the translation of an
 * unreadable store and to nothing else.
 */
function expectRebuildRefusal(refused: ApiError): void {
  expect(refused.code).toBe('not_found')
  expect(refused.message).toMatch(/re-sync it to rebuild/i)
  expect(refused.message).toMatch(/no longer in this data directory/i)
}

describe('every write verb answers a lost data directory with the repair, not a 500', () => {
  test('the fixture really reaches the failing state, and the port is where it is answered', async () => {
    const lost = await reviewWithItsContentRemoved()
    // The positive control, and the block is worthless without it: an absence
    // asserted over a fixture that never reached the failing state proves
    // nothing, and every case below would stay green with the translation
    // deleted outright.
    expect(() => lost.harness.store.getLocalSnapshot(lost.localId)).toThrow(StoreUnreadableError)
    // The other half of the pair. Softening the store and translating at the
    // port look identical from a verb, and only asserting both — the store still
    // throws, the port answers — tells them apart. The port is also the seam the
    // four verbs actually read through, so this is the claim the cases below
    // rest on rather than a restatement of them.
    const port = buildLocalWriteDeps(lost.harness.deps, lost.localId)
    let thrown: unknown
    try {
      port.getLocalSnapshot(lost.localId)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expectRebuildRefusal(thrown as ApiError)
    lost.dispose()
  }, 60_000)

  test('a submit refuses with the repair, and re-syncing makes the same submit land', async () => {
    const lost = await reviewWithItsContentRemoved()
    const { surface } = lost.harness
    const submitting = (): Promise<unknown> =>
      surface.submitReview({
        prNumber: lost.localId,
        expectedHeadSha: lost.headSha,
        event: 'COMMENT',
        body: 'A second note.',
        comments: [pendingComment(fixture.paths.modified, 3)],
      })

    expectRebuildRefusal(await refusalFrom(submitting))

    // The remedy, performed and then measured. A message that names a repair is
    // a promise, and without this half it would be actionable in wording only.
    await surface.syncPull(lost.localId)
    expect(await submitting()).toMatchObject({ status: 'ok' })
    // Two: the one the fixture seeded and the one that just landed. The seeded
    // thread surviving the removal is part of the claim — the repair rebuilds
    // the content, it does not start the review over.
    expect(surface.listThreads(lost.localId)).toHaveLength(2)
    lost.dispose()
  }, 60_000)

  test('a reply refuses with the repair, and re-syncing makes the same reply land', async () => {
    const lost = await reviewWithItsContentRemoved()
    const { surface } = lost.harness
    const replying = (): Promise<unknown> =>
      surface.replyToThread(lost.localId, lost.threadId, 'Agreed.')

    expectRebuildRefusal(await refusalFrom(replying))

    await surface.syncPull(lost.localId)
    expect(await replying()).toMatchObject({ body: 'Agreed.' })
    expect(surface.listThreads(lost.localId)[0].comments).toHaveLength(2)
    lost.dispose()
  }, 60_000)

  test('a resolve refuses with the repair, and re-syncing makes the same resolve land', async () => {
    const lost = await reviewWithItsContentRemoved()
    const { surface } = lost.harness
    const resolving = (): Promise<unknown> =>
      surface.resolveThread(lost.localId, lost.threadId, true)

    expectRebuildRefusal(await refusalFrom(resolving))

    await surface.syncPull(lost.localId)
    expect(await resolving()).toMatchObject({ isResolved: true })
    expect(surface.listThreads(lost.localId)[0].isResolved).toBe(true)
    lost.dispose()
  }, 60_000)

  test('a reaction refuses with the repair, and re-syncing makes the same reaction land', async () => {
    const lost = await reviewWithItsContentRemoved()
    const { surface } = lost.harness
    const reacting = (): Promise<unknown> =>
      surface.addReaction(lost.localId, lost.commentId, 'heart')

    expectRebuildRefusal(await refusalFrom(reacting))

    await surface.syncPull(lost.localId)
    expect(await reacting()).toMatchObject({ heart: 1, total_count: 1 })
    expect(surface.listThreads(lost.localId)[0].comments[0].reactions.heart).toBe(1)
    lost.dispose()
  }, 60_000)

  test('none of the four refusals touches the draft', async () => {
    const lost = await reviewWithItsContentRemoved()
    const { surface } = lost.harness
    // Readable in the failing state because the draft lives in its own table,
    // which the removal did not empty. Read before as well as after, so the
    // assertion is about survival rather than about a draft that was never there.
    expect(surface.getDraft(lost.localId)?.body).toBe(SURVIVING_DRAFT_BODY)

    await refusalFrom(() =>
      surface.submitReview({
        prNumber: lost.localId,
        expectedHeadSha: lost.headSha,
        event: 'COMMENT',
        body: 'A second note.',
        comments: [pendingComment(fixture.paths.modified, 3)],
      }),
    )
    await refusalFrom(() => surface.replyToThread(lost.localId, lost.threadId, 'Agreed.'))
    await refusalFrom(() => surface.resolveThread(lost.localId, lost.threadId, true))
    await refusalFrom(() => surface.addReaction(lost.localId, lost.commentId, 'heart'))

    const kept = surface.getDraft(lost.localId)
    expect(kept?.body).toBe(SURVIVING_DRAFT_BODY)
    // The pending comment too, not just the body: a draft stripped of the notes
    // it carried is as lost to its writer as one deleted outright.
    expect(kept?.comments).toHaveLength(1)
    lost.dispose()
  }, 60_000)
})
