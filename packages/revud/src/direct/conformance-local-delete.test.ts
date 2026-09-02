/**
 * Contract-conformance for deleting a local review on the DIRECT transport,
 * driven end to end against the real adapter (`createDirectApi`), the real
 * local-review surface, the real hardened git seam and a real store on disk,
 * over a seeded repository — because a delete has to reach the object database
 * to drop a review's pins, and a fake runner would let "the refusal touched
 * nothing" pass as a string nobody compared against a repository.
 *
 * The assertions themselves live in `@revu/shared/conformance` and are run
 * identically against the in-process mock and against the daemon over HTTP by
 * their own runners, so every transport is held to one bar from one source of
 * truth: a review holding text is refused whole as `unprocessable`, the remedy
 * the message names works, an absent id is the same `not_found` whether it was
 * deleted or never created, and the empty draft an editor creates on open never
 * blocks and goes with the review.
 *
 * ## What this runner adds beyond the shared block
 *
 * **A second handle on the store.** The shared block asserts the refusal moved
 * nothing through the contract; the storage witness handed in here counts the
 * rows of all six local tables off a raw connection to the same file, so
 * "every row intact" is a claim about rows and not about what the adapter
 * under test chose to report. That is why the store is opened on a temp
 * directory and never `:memory:`, which gives no second handle.
 *
 * **Every human, not just the caller.** The precondition spans every human's
 * draft, and only a second session over the same store can show it: the other
 * reviewer's text blocks the caller's delete, and their discard is what lets
 * it through.
 *
 * **The three absent-id cases answer alike.** Ids are minted from one mark
 * shared by every repository using a data directory, so an id can name a
 * review of a repository this daemon does not serve. Never-created, already
 * deleted and foreign all get the same `not_found` in the same words — and the
 * foreign review's rows and refs are exactly where they were, because an
 * answer of "not found" has no side effect. The git seam is wrapped to count
 * spawns, so "no side effect" includes the object database: a refusal of
 * either kind runs no git command at all.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewDraft, Session } from '@revu/shared'
import { ApiError } from '@revu/shared'
import { runLocalReviewDeleteConformance } from '@revu/shared/conformance'
import type { CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import { CONFORMANCE_SESSION } from './conformance-fakes'
import { createDirectApi, type DirectApi } from './direct-api'
import { createFixtureRepo, type FixtureRepo } from './local-fixture-repo'
import { createLocalReviewSurface } from './local-surface'
import { openDirectStore, type DirectStore } from './store'

/** The repository identity this daemon serves. */
const SERVED_REPO = 'acme/served'

/** A repository sharing the data directory that this daemon knows nothing about. */
const FOREIGN_REPO = 'acme/elsewhere'

/** A second reviewer of the same branch pair, in the same workspace. */
const OTHER_SESSION: Session = {
  human: { id: 'other@x.io', name: 'Other', role: 'contractor', email: 'other@x.io' },
  brokerLogin: '',
  workspace: CONFORMANCE_SESSION.workspace,
  viewerLogin: 'other-gh',
}

/**
 * The six tables a local review has rows in, with the column each keys the
 * review by. `local_reviews` is keyed by `id` and the other five by
 * `local_id`, and both are spelled here so a count cannot quietly match nothing
 * and report a table as empty.
 */
const LOCAL_TABLES: readonly { table: string; column: string }[] = [
  { table: 'local_reviews', column: 'id' },
  { table: 'local_snapshots', column: 'local_id' },
  { table: 'local_threads', column: 'local_id' },
  { table: 'local_reviews_submitted', column: 'local_id' },
  { table: 'local_drafts', column: 'local_id' },
  { table: 'local_viewed', column: 'local_id' },
]

/** A runner that counts what it is asked to run, then really runs it. */
function countingRunner(inner: CommandRunner): CommandRunner & { spawned: number } {
  const counted = {
    spawned: 0,
    async run(args: string[], opts?: { cwd?: string }) {
      counted.spawned += 1
      return inner.run([...args], opts)
    },
  }
  return counted
}

let fixture: FixtureRepo
let storeDir: string
let store: DirectStore
let runner: CommandRunner & { spawned: number }

/** The rows every local table holds for one review, read off a second handle. */
function rowsOf(reviewId: number): Record<string, number> {
  const raw = new Database(join(storeDir, 'direct.sqlite'))
  const counts: Record<string, number> = {}
  for (const { table, column } of LOCAL_TABLES) {
    const row = raw
      .query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
      .get(reviewId) as { n: number }
    counts[table] = row.n
  }
  raw.close()
  return counts
}

/** The api one session sees over the shared store, scoped to one repository. */
function apiFor(session: Session, repo: string, git: CommandRunner): DirectApi {
  const surface = createLocalReviewSurface({
    store,
    runner: git,
    toplevel: fixture.dir,
    repo,
    session,
  })
  return createDirectApi({
    session,
    store,
    runner: git,
    cwd: fixture.dir,
    localReviews: surface,
  })
}

/** A draft on one review carrying the given body, keyed to whoever saves it. */
function draftOn(reviewId: number, headSha: string, body: string): ReviewDraft {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    humanId: 'rekeyed-by-the-surface',
    prNumber: reviewId,
    headSha,
    compareKey: `merge-base...${headSha}`,
    body,
    event: 'COMMENT',
    comments: [],
    createdAt: at,
    updatedAt: at,
  }
}

/** One rejection, captured whole. */
async function rejection(p: Promise<unknown>): Promise<ApiError | null> {
  try {
    await p
    return null
  } catch (e) {
    return e instanceof ApiError ? e : null
  }
}

beforeAll(async () => {
  fixture = await createFixtureRepo()
  storeDir = mkdtempSync(join(tmpdir(), 'revu-delete-conformance-'))
  store = openDirectStore({ dataDir: storeDir })
  runner = countingRunner(createBunCommandRunner())
}, 120_000)

afterAll(() => {
  store.close()
  rmSync(storeDir, { recursive: true, force: true })
  fixture.dispose()
})

describe('direct local-review delete — contract conformance', () => {
  runLocalReviewDeleteConformance({
    label: 'direct engine in-process',
    makeApi: () => apiFor(CONFORMANCE_SESSION, SERVED_REPO, runner),
    humanId: CONFORMANCE_SESSION.human.id,
    pair: () => ({ baseRef: fixture.baseBranch, headRef: fixture.headBranch }),
    anchor: () => ({ path: fixture.paths.modified, line: 1, lineText: 'modified' }),
    rowsOf,
  })
})

describe("another human's draft on the same review", () => {
  test("blocks the caller's delete until that human discards it", async () => {
    const mine = apiFor(CONFORMANCE_SESSION, SERVED_REPO, runner)
    const theirs = apiFor(OTHER_SESSION, SERVED_REPO, runner)

    // Created by the caller, drafted on by someone else. The other reviewer's
    // draft holds text; the caller holds nothing on the review at all.
    const review = await mine.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
      title: 'Shared pair',
    })
    theirs.saveDraft(draftOn(review.id, fixture.headSha, 'text the other reviewer has not sent'))
    expect(mine.getDraft(review.id)).toBeNull()
    expect(store.listLocalDrafts(review.id).map((d) => d.humanId)).toEqual([OTHER_SESSION.human.id])
    const before = rowsOf(review.id)
    expect(before.local_drafts).toBe(1)
    const spawnedBefore = runner.spawned

    const refused = await rejection(mine.deleteLocalReview(review.id))
    expect(refused?.code).toBe('unprocessable')
    // Their row is where it was, and nothing reached git on the way to no.
    expect(rowsOf(review.id)).toEqual(before)
    expect(store.getLocalDraft(OTHER_SESSION.human.id, review.id)?.body).toBe(
      'text the other reviewer has not sent',
    )
    expect(runner.spawned).toBe(spawnedBefore)

    // The caller's own discard changes nothing: it is not their draft.
    mine.discardDraft(review.id)
    expect((await rejection(mine.deleteLocalReview(review.id)))?.code).toBe('unprocessable')

    // Theirs does. The remedy is the draft's own human discarding it.
    theirs.discardDraft(review.id)
    await mine.deleteLocalReview(review.id)
    expect(store.getLocalReview(review.id)).toBeNull()
    for (const [table, count] of Object.entries(rowsOf(review.id))) {
      expect([table, count]).toEqual([table, 0])
    }
  }, 60_000)
})

describe('an id that names no review this daemon serves', () => {
  test('never-created, just-deleted and foreign ids answer the same not_found, and nothing moves', async () => {
    const mine = apiFor(CONFORMANCE_SESSION, SERVED_REPO, runner)
    const elsewhere = apiFor(CONFORMANCE_SESSION, FOREIGN_REPO, runner)

    // A review this daemon serves, removed a moment ago...
    const gone = await mine.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    await mine.deleteLocalReview(gone.id)
    expect(store.getLocalReview(gone.id)).toBeNull()

    // ...one belonging to a repository sharing the data directory, synced so it
    // holds a snapshot, a draft with text, and pinned refs — everything a
    // removal reaching it by mistake would take...
    const foreign = await elsewhere.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    await elsewhere.syncPull(foreign.id)
    elsewhere.saveDraft(draftOn(foreign.id, fixture.headSha, 'text belonging to another repository'))
    const foreignRows = rowsOf(foreign.id)
    expect(foreignRows.local_reviews).toBe(1)
    expect(foreignRows.local_snapshots).toBe(1)
    expect(foreignRows.local_drafts).toBe(1)

    // ...and one that was never minted at all.
    const neverCreated = foreign.id + 987_654
    expect(store.getLocalReview(neverCreated)).toBeNull()

    const spawnedBefore = runner.spawned
    const answers = await Promise.all([
      rejection(mine.deleteLocalReview(gone.id)),
      rejection(mine.deleteLocalReview(foreign.id)),
      rejection(mine.deleteLocalReview(neverCreated)),
    ])

    // The same code and, with the id erased, the same message — so no answer
    // confirms that a review exists under an id this caller cannot see.
    const ids = [gone.id, foreign.id, neverCreated]
    const shapes = answers.map((err, i) => err?.message.split(String(ids[i])).join('<id>'))
    expect(answers.map((err) => err?.code)).toEqual(['not_found', 'not_found', 'not_found'])
    expect(new Set(shapes).size).toBe(1)
    expect(shapes[0]).toContain('<id>')

    // No side effect: the foreign review keeps every row and every pin, and
    // not one git command ran for any of the three answers.
    expect(rowsOf(foreign.id)).toEqual(foreignRows)
    expect(store.getLocalDraft(CONFORMANCE_SESSION.human.id, foreign.id)?.body).toBe(
      'text belonging to another repository',
    )
    expect(runner.spawned).toBe(spawnedBefore)

    // The control for "not one git command": a removal that goes through does
    // spawn — the drop discovers the review's refs — so a count that stood
    // still above is the refusals' doing and not a runner nobody wired.
    const served = await mine.createLocalReview({
      baseRef: fixture.baseBranch,
      headRef: fixture.headBranch,
    })
    await mine.deleteLocalReview(served.id)
    expect(runner.spawned).toBeGreaterThan(spawnedBefore)
  }, 60_000)
})
