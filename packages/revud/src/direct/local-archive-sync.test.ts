/**
 * Archiving a local review from the direct api's sync path, end to end.
 *
 * Everything here is real except one seam: a real repository on disk, the real
 * hardened git seam, a real store, the real local-review surface and the real
 * direct api, with the branch-pair listing — the one read of the hosted
 * repository this path makes — answered by a fake the case controls. What the
 * cases pin is the wiring the archive detector cannot pin from inside its own
 * unit: that the sync path reads the review through the ownership guard, asks
 * the seam ahead of the git work and outside the sync gate, hands the mark on
 * to a sync that stores a snapshot already reading `closed`, freezes the review
 * from then on, refuses its writes, and never asks about a review this
 * repository does not own.
 *
 * ## Why the seam is a fake and the client is a throwing stub
 *
 * The api is assembled with a GitHub client every method of which throws, and
 * with NO repository beside it, so the client is inert by construction: a
 * GitHub touch that somehow reached the client interface fails naming the
 * method rather than quietly answering. The listing seam is the only thing
 * that may answer a question about the hosted repository, and it records every
 * question it is asked — including how many syncs the gate had in flight at
 * that moment — so "asked ahead of the git work and outside the gate" is an
 * observation over a list rather than a description of the code.
 *
 * ## Why the reviews are seeded live and archived by a later sync
 *
 * A review archived on its very first sync has nothing a write could touch and
 * no earlier snapshot for a freeze to answer with, so the harness syncs each
 * review once while the seam lists nothing, submits one comment on it, and
 * only then lets a case put a pull request in the listing. That is the state
 * an archive lands on in practice, and it is the state in which every claim
 * below has something to measure.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type {
  GhUser,
  LocalReviewSummary,
  PullSummary,
  Snapshot,
  SnapshotImmutable,
} from '@revu/shared'
import { ApiError, archivedReviewRefusal } from '@revu/shared'
import type { CommandResult, CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import { CONFORMANCE_SESSION } from './conformance-fakes'
import { createDirectApi, type DirectApi } from './direct-api'
import { throwingGithubClient } from './github-write-stubs'
import type { SupersedingPullSource } from './local-archive'
import { createFixtureRepo, type FixtureRepo } from './local-fixture-repo'
import { createLocalReviewSurface } from './local-surface'
import type { SyncGate } from './retention'
import { createSyncGate } from './retention'
import { openDirectStore, type DirectStore } from './store'

/** The `owner/name` identity the reviews are scoped to — the shape a pull request can match. */
const SERVED_REPO = 'acme/served'

/** A second base branch, so a review over a DIFFERENT pair can sync in the same run. */
const ALT_BASE = 'release/alt'

const ACTOR: GhUser = {
  login: 'octocat',
  id: 1,
  node_id: 'U_1',
  avatar_url: '',
  html_url: '',
  type: 'User',
}

let fixture: FixtureRepo

beforeAll(async () => {
  fixture = await createFixtureRepo()
  // The alternate base sits at the base tip, so the alternate pair resolves
  // exactly as the seeded one does and differs from it in nothing but its name.
  const made = await createBunCommandRunner().run(
    ['git', 'branch', ALT_BASE, fixture.baseSha],
    { cwd: fixture.dir },
  )
  if (!made.ok) throw new Error(`fixture git failed: branch ${ALT_BASE} — ${made.stderr}`)
}, 120_000)

afterAll(() => {
  fixture.dispose()
})

// ————————————————————————————————————————————————————————————————
// The seam and the pull requests it lists
// ————————————————————————————————————————————————————————————————

/** A pull request over the fixture's seeded pair unless a field says otherwise. */
function pull(over: {
  number: number
  headRef?: string
  baseRef?: string
  headRepo?: string
  state?: 'open' | 'closed'
}): PullSummary {
  const headRef = over.headRef ?? fixture.headBranch
  const baseRef = over.baseRef ?? fixture.baseBranch
  const headRepo = over.headRepo ?? SERVED_REPO
  return {
    id: 1000 + over.number,
    node_id: `PR_${over.number}`,
    number: over.number,
    state: over.state ?? 'open',
    draft: false,
    merged_at: null,
    title: `pull ${over.number}`,
    body: null,
    user: ACTOR,
    labels: [],
    requested_reviewers: [],
    head: {
      ref: headRef,
      sha: 'a'.repeat(40),
      label: `${headRepo}:${headRef}`,
      repo: { full_name: headRepo, default_branch: 'main' },
    },
    base: {
      ref: baseRef,
      sha: 'b'.repeat(40),
      label: `${SERVED_REPO}:${baseRef}`,
      repo: { full_name: SERVED_REPO, default_branch: 'main' },
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  }
}

/** One question the seam was asked, with the gate's count at that moment. */
interface Asked {
  readonly headRef: string
  readonly baseRef: string
  readonly inFlight: number
}

/**
 * A seam whose answer a case moves between syncs: the listing it returns, or
 * the failure it throws instead. Every question is recorded with the sync
 * gate's count as it stood when the question arrived.
 */
interface RecordingSource extends SupersedingPullSource {
  readonly asked: Asked[]
  pulls: PullSummary[]
  failure: unknown
}

function recordingSource(gate: SyncGate): RecordingSource {
  const source: RecordingSource = {
    asked: [],
    pulls: [],
    failure: null,
    async listOpenPullsForPair(pair) {
      source.asked.push({ ...pair, inFlight: gate.inFlight })
      if (source.failure !== null) throw source.failure
      return source.pulls
    },
  }
  return source
}

/** The sentinel a leaked error message would carry: a URL with a credential in it. */
const SENTINEL_URL = 'https://api.github.test/repos/acme/served/pulls?token=hunter2'

function githubFailure(): Error {
  const error = new Error(`request to ${SENTINEL_URL} failed`)
  error.name = 'GithubRequestError'
  return error
}

// ————————————————————————————————————————————————————————————————
// The world: store, surface, api, and two seeded reviews
// ————————————————————————————————————————————————————————————————

/** A runner that records the gate's count at every git call, and delegates. */
function gateWatchingRunner(gate: SyncGate, seen: number[]): CommandRunner {
  const real = createBunCommandRunner()
  return {
    run(args: string[], opts?: { cwd?: string }): Promise<CommandResult> {
      seen.push(gate.inFlight)
      return real.run(args, opts)
    },
  }
}

/** A clock a case moves by hand, so "a fresh snapshot" is a moved timestamp. */
function movingClock(): { now: () => string; tick: () => void } {
  let ticks = 0
  return {
    now: () => `2026-02-01T00:00:${String(ticks).padStart(2, '0')}.000Z`,
    tick: () => {
      ticks += 1
    },
  }
}

interface World {
  readonly store: DirectStore
  readonly api: DirectApi
  readonly gate: SyncGate
  /** Present unless the world was assembled with no seam at all. */
  readonly source: RecordingSource
  /** The gate's count at every git call the surface made. */
  readonly gateAtGit: number[]
  readonly clock: ReturnType<typeof movingClock>
  /** `main ← feature/x`, synced once and carrying one thread. */
  readonly reviewId: number
  /** `release/alt ← feature/x`, synced once and carrying one thread. */
  readonly altId: number
  close(): void
}

/**
 * Assemble the api over a fresh in-memory store, seed both reviews live, and
 * clear the seam's record so a case reads only its own questions.
 */
async function world(options: { seam?: 'present' | 'absent' } = {}): Promise<World> {
  const store = openDirectStore({ dataDir: ':memory:' })
  const gate = createSyncGate()
  const source = recordingSource(gate)
  const gateAtGit: number[] = []
  const clock = movingClock()
  const runner = gateWatchingRunner(gate, gateAtGit)
  const localReviews = createLocalReviewSurface({
    store,
    runner,
    toplevel: fixture.dir,
    repo: SERVED_REPO,
    session: CONFORMANCE_SESSION,
    now: clock.now,
  })
  const api = createDirectApi({
    session: CONFORMANCE_SESSION,
    store,
    runner,
    cwd: fixture.dir,
    localReviews,
    github: throwingGithubClient(),
    syncGate: gate,
    ...(options.seam === 'absent' ? {} : { supersedingPulls: source }),
  })

  const seedReview = async (baseRef: string): Promise<number> => {
    const review = await api.createLocalReview({ baseRef, headRef: fixture.headBranch })
    const synced = await api.syncPull(review.id)
    const submitted = await api.submitReview({
      prNumber: review.id,
      expectedHeadSha: synced.immutable.headSha,
      event: 'COMMENT',
      body: 'A note written while the review was live.',
      comments: [
        {
          key: `seed-${review.id}`,
          path: fixture.paths.modified,
          side: 'RIGHT',
          start_side: null,
          line: 2,
          start_line: null,
          body: 'Seeded thread.',
          createdAt: clock.now(),
          updatedAt: clock.now(),
          anchor: { lineText: '', contextBefore: [], contextAfter: [] },
        },
      ],
    })
    if (submitted.status !== 'ok') throw new Error(`seeding submit answered ${submitted.status}`)
    return review.id
  }
  const reviewId = await seedReview(fixture.baseBranch)
  const altId = await seedReview(ALT_BASE)
  source.asked.length = 0
  gateAtGit.length = 0
  clock.tick()

  return {
    store,
    api,
    gate,
    source,
    gateAtGit,
    clock,
    reviewId,
    altId,
    close: () => store.close(),
  }
}

/** The row as persisted, or a throw naming the id — never a silent undefined. */
function rowOf(w: World, localId: number): LocalReviewSummary {
  const row = w.store.getLocalReview(localId)
  if (row === null) throw new Error(`no row for local review ${localId}`)
  return row
}

/** The stored snapshot read back through the api, serialized for byte comparison. */
function storedBytes(w: World, localId: number): string {
  return JSON.stringify(w.api.getSnapshot(localId))
}

/** The thread and comment the seed left on a review, for the writes to aim at. */
function seededTarget(w: World, localId: number): { threadId: string; commentId: number } {
  const snapshot = w.api.getSnapshot(localId)
  const thread = snapshot?.mutable.threads[0]
  const comment = thread?.comments[0]
  if (thread === undefined || comment === undefined) {
    throw new Error(`local review ${localId} carries no seeded thread`)
  }
  return { threadId: thread.id, commentId: comment.id }
}

/**
 * Drive all four write verbs at a review and report how each answered, so a
 * case compares the whole set in one assertion rather than stopping at the
 * first verb that stopped refusing.
 */
async function writeOutcomes(w: World, localId: number): Promise<string[]> {
  const { threadId, commentId } = seededTarget(w, localId)
  const headSha = w.api.getSnapshot(localId)?.immutable.headSha ?? ''
  const describe = (result: unknown): string => JSON.stringify(result)
  const thrown = (run: () => Promise<unknown>): Promise<string> =>
    run().then(
      (value) => `answered ${describe(value)}`,
      (error: unknown) =>
        error instanceof ApiError ? `${error.code}: ${error.message}` : 'untyped',
    )
  const submit = await w.api.submitReview({
    prNumber: localId,
    expectedHeadSha: headSha,
    event: 'COMMENT',
    body: 'A verdict aimed at an archived review.',
    comments: [],
  })
  return [
    `submit ${describe(submit)}`,
    `reply ${await thrown(() => w.api.replyToThread(localId, threadId, 'Aimed at an archive.'))}`,
    `resolve ${await thrown(() => w.api.resolveThread(localId, threadId, true))}`,
    `react ${await thrown(() => w.api.addReaction(localId, commentId, '+1'))}`,
  ]
}

/** What all four verbs must answer once `localId` is archived. */
function refusedOutcomes(w: World, localId: number): string[] {
  const row = rowOf(w, localId)
  if (row.archivedPr === null) throw new Error(`local review ${localId} is not archived`)
  const reason = archivedReviewRefusal({
    archivedPr: row.archivedPr,
    baseRef: row.baseRef,
    headRef: row.headRef,
  })
  return [
    `submit ${JSON.stringify({ status: 'forbidden', reason })}`,
    `reply forbidden: ${reason}`,
    `resolve forbidden: ${reason}`,
    `react forbidden: ${reason}`,
  ]
}

/**
 * Every line written through `console.warn` while the capture stands, joined
 * the way the console would join it. The detector's default sink is the
 * console, and the api hands it no other, so the console is where the one
 * warning a failing seam produces has to be read.
 */
function captureWarnings(): { readonly lines: string[]; restore: () => void } {
  const original = console.warn
  const lines: string[] = []
  console.warn = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '))
  }
  return {
    lines,
    restore: () => {
      console.warn = original
    },
  }
}

/** An immutable half nothing references, so a reclamation has something to remove. */
const ORPHAN_KEY = 'orphan...half'

function orphanHalf(): SnapshotImmutable {
  return {
    compareKey: ORPHAN_KEY,
    mergeBaseSha: 'orphan',
    headSha: 'half',
    files: [],
    blobIndex: {},
    commits: [],
  }
}

// ————————————————————————————————————————————————————————————————
// The cases
// ————————————————————————————————————————————————————————————————

describe('a matching open pull request archives the review on the next sync', () => {
  let w: World
  let synced: Snapshot

  beforeAll(async () => {
    w = await world()
    // The fork carries the LOWER number: were it not rejected, it would win.
    w.source.pulls = [pull({ number: 12 }), pull({ number: 3, headRepo: 'stranger/served' })]
    synced = await w.api.syncPull(w.reviewId)
  }, 120_000)

  afterAll(() => w.close())

  test('the row records the pull request — the one from this repository, not the fork', () => {
    expect(rowOf(w, w.reviewId).archivedPr).toBe(12)
  })

  test('the snapshot the sync returned already reads closed, and the stored one agrees', () => {
    expect(synced.mutable.pull.state).toBe('closed')
    expect(storedBytes(w, w.reviewId)).toBe(JSON.stringify(synced))
  })

  test('the list shows the review closed', () => {
    const row = w.api.listPulls(null).items.find((item) => item.pull.number === w.reviewId)
    expect(row?.pull.state).toBe('closed')
  })

  test('the seam was asked about the bare pair, once, ahead of the git work and outside the gate', () => {
    expect(w.source.asked).toEqual([{ headRef: 'feature/x', baseRef: 'main', inFlight: 0 }])
    // The control for `inFlight: 0`: the gate really does rise for the git
    // work of the same sync, so a question asked inside it would have read 1.
    expect(w.gateAtGit.length).toBeGreaterThan(0)
    expect(w.gateAtGit.every((count) => count === 1)).toBe(true)
  })

  test('a review over a different pair synced in the same run stays live', async () => {
    const before = storedBytes(w, w.altId)
    await w.api.syncPull(w.altId)
    expect(rowOf(w, w.altId).archivedPr).toBeNull()
    expect(w.source.asked.at(-1)).toEqual({
      headRef: 'feature/x',
      baseRef: ALT_BASE,
      inFlight: 0,
    })
    // Live means synced: the clock moved, so a full sync stores a new envelope.
    expect(storedBytes(w, w.altId)).not.toBe(before)
    const row = w.api.listPulls(null).items.find((item) => item.pull.number === w.altId)
    expect(row?.pull.state).toBe('open')
  })
})

describe('with no seam, a sync archives nothing and issues no request', () => {
  test('zero requests under a throwing fetch double, and the review stays live', async () => {
    const w = await world({ seam: 'absent' })
    const realFetch = globalThis.fetch
    const attempted: string[] = []
    globalThis.fetch = ((input: unknown): never => {
      attempted.push(String(input))
      throw new Error('the local sync path must not reach the network')
    }) as unknown as typeof fetch
    try {
      // The control: the double IS installed, so a call through it throws and
      // is recorded. Without this, an empty list would pass just as well on a
      // double nobody installed.
      const probe = 'https://api.github.test/probe'
      expect(() => fetch(probe)).toThrow('the local sync path must not reach the network')
      expect(attempted).toEqual([probe])

      // A listing the world's seam WOULD have answered with had it been wired.
      w.source.pulls = [pull({ number: 12 })]
      await w.api.syncPull(w.reviewId)

      expect(rowOf(w, w.reviewId).archivedPr).toBeNull()
      expect(w.source.asked).toEqual([])
      expect(attempted).toEqual([probe])
    } finally {
      globalThis.fetch = realFetch
      w.close()
    }
  }, 120_000)

  test('the control: the same listing through a wired seam archives the same review', async () => {
    const w = await world()
    try {
      w.source.pulls = [pull({ number: 12 })]
      await w.api.syncPull(w.reviewId)
      expect(rowOf(w, w.reviewId).archivedPr).toBe(12)
    } finally {
      w.close()
    }
  }, 120_000)
})

describe('a pull request closed without merging is a no-op, in both directions', () => {
  let w: World

  beforeAll(async () => {
    w = await world()
  }, 120_000)

  afterAll(() => w.close())

  test('archived first: the seeded review goes read-only against an open pull request', async () => {
    w.source.pulls = [pull({ number: 12 })]
    await w.api.syncPull(w.reviewId)
    expect(rowOf(w, w.reviewId).archivedPr).toBe(12)
    expect(await writeOutcomes(w, w.reviewId)).toEqual(refusedOutcomes(w, w.reviewId))
  })

  test('the pull request closing afterwards un-archives nothing: the number and the refusals stand', async () => {
    w.source.pulls = [pull({ number: 12, state: 'closed' })]
    await w.api.syncPull(w.reviewId)
    expect(rowOf(w, w.reviewId).archivedPr).toBe(12)
    expect(await writeOutcomes(w, w.reviewId)).toEqual(refusedOutcomes(w, w.reviewId))
  })

  test('a closed pull request over a live pair archives nothing', async () => {
    w.source.pulls = [pull({ number: 20, baseRef: ALT_BASE, state: 'closed' })]
    await w.api.syncPull(w.altId)
    expect(rowOf(w, w.altId).archivedPr).toBeNull()
  })

  test('the control: the same pull request open archives that pair in the same run', async () => {
    w.source.pulls = [pull({ number: 20, baseRef: ALT_BASE })]
    await w.api.syncPull(w.altId)
    expect(rowOf(w, w.altId).archivedPr).toBe(20)
    expect(await writeOutcomes(w, w.altId)).toEqual(refusedOutcomes(w, w.altId))
  })
})

describe('a failing seam never fails a sync', () => {
  test('the sync resolves with a fresh snapshot, the review stays live, and exactly one warning is written', async () => {
    const w = await world()
    const warnings = captureWarnings()
    try {
      const before = storedBytes(w, w.reviewId)
      w.source.failure = githubFailure()
      const synced = await w.api.syncPull(w.reviewId)

      expect(rowOf(w, w.reviewId).archivedPr).toBeNull()
      // Fresh: the clock moved since the seed, so a sync that ran stores a new
      // envelope, and the one returned is the one stored.
      expect(JSON.stringify(synced)).not.toBe(before)
      expect(storedBytes(w, w.reviewId)).toBe(JSON.stringify(synced))
      expect(warnings.lines).toHaveLength(1)

      // The control for "stays live": lift the failure and the same sync
      // archives, so the null above was the seam failing rather than nothing
      // ever listening to it.
      w.source.failure = null
      w.source.pulls = [pull({ number: 12 })]
      await w.api.syncPull(w.reviewId)
      expect(rowOf(w, w.reviewId).archivedPr).toBe(12)
    } finally {
      warnings.restore()
      w.close()
    }
  }, 120_000)

  test('the warning names the failure kind and carries nothing from its message', async () => {
    const w = await world()
    const warnings = captureWarnings()
    try {
      w.source.failure = githubFailure()
      await w.api.syncPull(w.reviewId)
      expect(warnings.lines).toHaveLength(1)
      expect(warnings.lines[0]).toContain('GithubRequestError')
      expect(warnings.lines[0]).not.toContain('hunter2')
    } finally {
      warnings.restore()
      w.close()
    }
  }, 120_000)
})

describe('after a frozen sync, the writes still refuse and nothing is reclaimed', () => {
  let w: World
  let gitCallsDuringFrozen = 0

  beforeAll(async () => {
    w = await world()
    w.source.pulls = [pull({ number: 12 })]
    // The sync that finds the pull request: the review's last full sync.
    await w.api.syncPull(w.reviewId)
    // A half nothing references, put down AFTER that sync's own reclamation,
    // so the next reclamation — if one runs — has something to remove.
    w.store.putImmutable(orphanHalf())
    w.clock.tick()
  }, 120_000)

  afterAll(() => w.close())

  test('the orphan is really there to be reclaimed', () => {
    expect(w.store.listImmutableKeys()).toContain(ORPHAN_KEY)
  })

  test('the next sync is frozen: same bytes, no git, and the orphan survives', async () => {
    const before = storedBytes(w, w.reviewId)
    const gitBefore = w.gateAtGit.length
    const frozen = await w.api.syncPull(w.reviewId)
    gitCallsDuringFrozen = w.gateAtGit.length - gitBefore

    expect(JSON.stringify(frozen)).toBe(before)
    expect(gitCallsDuringFrozen).toBe(0)
    expect(w.store.listImmutableKeys()).toContain(ORPHAN_KEY)
  })

  test('all four writes still refuse after the frozen sync', async () => {
    expect(await writeOutcomes(w, w.reviewId)).toEqual(refusedOutcomes(w, w.reviewId))
  })

  test('the control: a live review syncing in the same store reclaims the orphan', async () => {
    await w.api.syncPull(w.altId)
    expect(w.store.listImmutableKeys()).not.toContain(ORPHAN_KEY)
  })
})

describe('a review another repository owns is never asked about', () => {
  test('the sync answers not_found, and the seam records no question for it', async () => {
    const w = await world()
    try {
      const foreignId = w.store.createLocalReview({
        repo: 'other/place',
        baseRef: `refs/heads/${fixture.baseBranch}`,
        headRef: `refs/heads/${fixture.headBranch}`,
        title: 'a stranger’s review of the same branch names',
      }).id
      w.source.pulls = [pull({ number: 12 })]

      const outcome = await w.api.syncPull(foreignId).then(
        () => 'answered',
        (error: unknown) => (error instanceof ApiError ? error.code : 'untyped'),
      )
      expect(outcome).toBe('not_found')
      expect(w.source.asked).toEqual([])
      expect(w.store.getLocalReview(foreignId)?.archivedPr).toBeNull()

      // The control: the owned review over the same branch names IS asked
      // about by the same seam, in the same world.
      await w.api.syncPull(w.reviewId)
      expect(w.source.asked).toEqual([{ headRef: 'feature/x', baseRef: 'main', inFlight: 0 }])
    } finally {
      w.close()
    }
  }, 120_000)
})

// ————————————————————————————————————————————————————————————————
// A branch that stops existing between one sync and the next
// ————————————————————————————————————————————————————————————————

/**
 * A head branch of this file's own, at the fixture's head tip, so a case can
 * delete it without touching the pair every other case in this file reviews.
 */
async function createHeadBranch(name: string): Promise<void> {
  const made = await createBunCommandRunner().run(['git', 'branch', name, fixture.headSha], {
    cwd: fixture.dir,
  })
  if (!made.ok) throw new Error(`fixture git failed: branch ${name} — ${made.stderr}`)
}

/** Delete such a branch, as a reviewer does once the pull request is open. */
async function deleteHeadBranch(name: string): Promise<void> {
  const gone = await createBunCommandRunner().run(['git', 'branch', '-D', name], {
    cwd: fixture.dir,
  })
  if (!gone.ok) throw new Error(`fixture git failed: branch -D ${name} — ${gone.stderr}`)
}

/** How `syncPull` answered: the code of its typed refusal, or that it resolved. */
async function syncOutcome(w: World, localId: number): Promise<string> {
  return w.api.syncPull(localId).then(
    () => 'answered',
    (error: unknown) => (error instanceof ApiError ? error.code : 'untyped'),
  )
}

/**
 * The reviewer pushed the branch, opened a pull request, and deleted their local
 * head. The archive check runs before the sync and marks the row; the catch-up
 * sync that would produce the closing snapshot then has no branch to resolve.
 *
 * Without a fallback the review is stranded: the row says archived, the stored
 * snapshot still says open, and every later sync re-runs the same git and fails
 * the same way, so nothing ever freezes and the review can never be read again.
 * The documented promise is that an archived review stands at its last sync, and
 * the last SUCCESSFUL sync is the only one there is to stand at.
 */
describe('an archived review whose branch is gone freezes at its last successful sync', () => {
  const DOOMED = 'feature/doomed-archive'
  let w: World
  let doomedId: number
  /** The pull state of the snapshot the last successful sync stored. */
  let liveState: string
  let frozenBytes: string
  let againBytes: string
  let gitDuringSecond = 0

  beforeAll(async () => {
    w = await world()
    await createHeadBranch(DOOMED)
    doomedId = (
      await w.api.createLocalReview({ baseRef: fixture.baseBranch, headRef: DOOMED })
    ).id
    // A thread of its own, written while the review is live, so the refusals
    // asserted below have something real to be aimed at — and a second sync
    // after it, so the envelope this review freezes at carries that thread.
    const first = await w.api.syncPull(doomedId)
    const submitted = await w.api.submitReview({
      prNumber: doomedId,
      expectedHeadSha: first.immutable.headSha,
      event: 'COMMENT',
      body: 'A note written while the branch still existed.',
      comments: [
        {
          key: `doomed-${doomedId}`,
          path: fixture.paths.modified,
          side: 'RIGHT',
          start_side: null,
          line: 2,
          start_line: null,
          body: 'Seeded thread.',
          createdAt: w.clock.now(),
          updatedAt: w.clock.now(),
          anchor: { lineText: '', contextBefore: [], contextAfter: [] },
        },
      ],
    })
    if (submitted.status !== 'ok') throw new Error(`seeding submit answered ${submitted.status}`)

    // The last sync that can read the repository: no pull request is listed yet,
    // so the review is live and its snapshot reads open.
    liveState = (await w.api.syncPull(doomedId)).mutable.pull.state

    w.source.pulls = [pull({ number: 55, headRef: DOOMED })]
    await deleteHeadBranch(DOOMED)
    w.clock.tick()

    frozenBytes = JSON.stringify(await w.api.syncPull(doomedId))

    const gitBefore = w.gateAtGit.length
    againBytes = JSON.stringify(await w.api.syncPull(doomedId))
    gitDuringSecond = w.gateAtGit.length - gitBefore
  }, 120_000)

  afterAll(() => w.close())

  test('the precondition: the last successful sync stored a snapshot reading open', () => {
    expect(liveState).toBe('open')
  })

  test('the row is archived against the pull request the check found', () => {
    expect(rowOf(w, doomedId).archivedPr).toBe(55)
  })

  test('the sync answers the stored snapshot, closed, instead of failing', () => {
    expect(JSON.parse(frozenBytes).mutable.pull.state).toBe('closed')
  })

  test('the stored snapshot reads closed when it is read back', () => {
    expect(storedBytes(w, doomedId)).toBe(frozenBytes)
    expect(w.api.getSnapshot(doomedId)?.mutable.pull.state).toBe('closed')
  })

  test('the list shows the review closed', () => {
    const row = w.api.listPulls(null).items.find((item) => item.pull.number === doomedId)
    expect(row?.pull.state).toBe('closed')
  })

  test('the sync after it is byte-identical and runs no git at all', () => {
    expect(againBytes).toBe(frozenBytes)
    expect(gitDuringSecond).toBe(0)
  })

  test('all four writes refuse, exactly as on any other archived review', async () => {
    expect(await writeOutcomes(w, doomedId)).toEqual(refusedOutcomes(w, doomedId))
  })

  test('the control: a LIVE review over a deleted branch still refuses, rewriting nothing', async () => {
    const LIVE_DOOMED = 'feature/doomed-live'
    await createHeadBranch(LIVE_DOOMED)
    const liveId = (
      await w.api.createLocalReview({ baseRef: fixture.baseBranch, headRef: LIVE_DOOMED })
    ).id
    await w.api.syncPull(liveId)
    const before = storedBytes(w, liveId)
    await deleteHeadBranch(LIVE_DOOMED)
    w.clock.tick()

    // No pull request over THIS pair, so nothing archives it and the failure has
    // to travel: a review nobody superseded has no last-archived state to stand
    // at, and answering a stale snapshot would hide a branch the reviewer still
    // has to restore.
    expect(await syncOutcome(w, liveId)).toBe('not_found')
    expect(rowOf(w, liveId).archivedPr).toBeNull()
    expect(storedBytes(w, liveId)).toBe(before)
    expect(w.api.getSnapshot(liveId)?.mutable.pull.state).toBe('open')
  }, 120_000)

  test('the control: an archived review that never synced still refuses — there is nothing to serve', async () => {
    const NEVER_SYNCED = 'feature/doomed-unsynced'
    await createHeadBranch(NEVER_SYNCED)
    const unsyncedId = (
      await w.api.createLocalReview({ baseRef: fixture.baseBranch, headRef: NEVER_SYNCED })
    ).id
    w.source.pulls = [pull({ number: 56, headRef: NEVER_SYNCED })]
    await deleteHeadBranch(NEVER_SYNCED)

    // The check marks the row without touching git, so this review is archived
    // AND has no snapshot: the freeze has nothing to answer with and the refusal
    // is the honest answer.
    expect(await syncOutcome(w, unsyncedId)).toBe('not_found')
    expect(rowOf(w, unsyncedId).archivedPr).toBe(56)
    expect(w.api.getSnapshot(unsyncedId)).toBeNull()
  }, 120_000)
})

/**
 * The GitHub mapper turns a listing row with no `number` into a pull request
 * numbered 0, and the lowest number wins the tiebreak — so an unguarded zero
 * beats every real pull request and then hands the store a value it refuses.
 * What arrives at the daemon is a malformed row in somebody else's listing, and
 * what it must cost is nothing: the sync answers, and the review stays live.
 */
describe('a listing row carrying no pull request number never fails a sync', () => {
  test('a zero-numbered row archives nothing and the sync answers normally', async () => {
    const w = await world()
    try {
      w.source.pulls = [pull({ number: 0 })]

      expect(await syncOutcome(w, w.reviewId)).toBe('answered')
      expect(rowOf(w, w.reviewId).archivedPr).toBeNull()
      expect(w.api.getSnapshot(w.reviewId)?.mutable.pull.state).toBe('open')
      // The seam really was consulted, so the row above was rejected rather
      // than never looked at.
      expect(w.source.asked).toHaveLength(1)

      // The control for "never fails": 0 is a number the store refuses outright,
      // so a zero that reached the column would have thrown out of that sync —
      // and the refusal leaves the review exactly as live as it was.
      expect(() => w.store.markLocalReviewArchived(w.reviewId, 0)).toThrow(RangeError)
      expect(rowOf(w, w.reviewId).archivedPr).toBeNull()
    } finally {
      w.close()
    }
  }, 120_000)

  test('a real pull request listed beside it still archives, against the real number', async () => {
    const w = await world()
    try {
      // Were the zero taken for a pull request it would win on number and
      // archive this review against nothing.
      w.source.pulls = [pull({ number: 77 }), pull({ number: 0 })]
      await w.api.syncPull(w.reviewId)
      expect(rowOf(w, w.reviewId).archivedPr).toBe(77)
      expect(w.api.getSnapshot(w.reviewId)?.mutable.pull.state).toBe('closed')
    } finally {
      w.close()
    }
  }, 120_000)
})
