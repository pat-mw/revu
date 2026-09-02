/**
 * Archiving a local review against the pull request that supersedes it.
 *
 * A local review names a branch PAIR. Once an open pull request covers the same
 * repository and the same pair, the review is no longer where feedback belongs:
 * the next sync records that pull request's number on the record, the review
 * freezes at that sync, and every write verb refuses. Nothing is ever copied to
 * the pull request, and nothing un-archives — a pull request closed afterwards
 * leaves the review archived, and detection never runs again on a record that
 * already carries a number.
 *
 * What these tests pin, and why each one can fail:
 *
 * - Detection runs BEFORE the sync's own work, so the sync that finds the pull
 *   request is the review's last one and the snapshot it leaves behind already
 *   presents `state: 'closed'`. Read back through the store, never off the
 *   returned value, so a synthesized answer that never reached storage is red.
 * - Frozen means TOUCHED NOTHING. Each freeze assertion first pokes the stored
 *   record with values a live sync would overwrite (a past `lastSyncedAt`, a
 *   sentinel head SHA, `dirty: true`) and then requires them intact — a sync
 *   that quietly re-ran its work would rewrite all three. Timestamps alone
 *   could not carry that claim: two syncs in one millisecond stamp the same
 *   ISO string.
 * - Every refusal test serializes the review's whole local state — record,
 *   snapshot, drafts, viewed marks — before the call and requires it byte
 *   identical after, so a verb that refuses only after mutating is red.
 * - Every absence assertion (stayed live, stayed null) is accompanied in its
 *   own body by a review that DID archive in the same run, so a detection that
 *   stopped firing altogether cannot pass as "correctly declined".
 *
 * The mock store is one process-wide document shared across every test file in
 * the process, so this suite resets it before and after itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { LocalReviewSummary, PendingComment, ReviewDraft } from '@revu/shared'
import { ApiError, archivedReviewRefusal } from '@revu/shared'
import { fixtureDB } from '@/fixtures'
import { createMockApi } from './adapter'
import { mockDev } from './devtools'
import {
  addLocalReaction,
  createLocalReview,
  getLocalReview,
  listLocalPullRows,
  listLocalReviews,
  replyToLocalThread,
  resolveLocalThread,
  submitLocalReview,
  syncLocalReview,
} from './local'
import type { LocalReviewRecord } from './store'
import { store } from './store'

const api = createMockApi()

beforeAll(() => {
  mockDev.reset()
  mockDev.setLatency('zero')
})

afterAll(() => {
  mockDev.reset()
})

/**
 * The fixture pull requests this file names by number, with the pair each one
 * covers. Written out as literals rather than read from the fixture, so a
 * fixture edit that moved a branch pair or closed a pull request turns the
 * pin below red instead of silently making every archive assertion vacuous.
 */
const COVERED: ReadonlyArray<{ number: number; baseName: string; headName: string }> = [
  { number: 101, baseName: 'main', headName: 'fix/cache-ttl-jitter' },
  { number: 312, baseName: 'main', headName: 'feat/gateway-rate-limiting' },
  { number: 347, baseName: 'main', headName: 'metering/usage-rollups' },
  { number: 355, baseName: 'main', headName: 'chore/node-22' },
  { number: 362, baseName: 'chore/node-22', headName: 'marcus/strict-null-checks' },
  { number: 389, baseName: 'main', headName: 'auth/refresh-scheduler' },
  { number: 410, baseName: 'main', headName: 'storage/retention-sweep' },
  { number: 415, baseName: 'release/0.41', headName: 'webhooks/constant-time-verify' },
]

/** A branch pair no fixture pull request covers, used wherever a review must stay live. */
function uncoveredPair(name: string): { baseRef: string; headRef: string } {
  return { baseRef: 'main', headRef: `feature/${name}` }
}

/** The pull row for a review, read from the list every review is resolved out of. */
function pullRowOf(id: number): { state: 'open' | 'closed' } {
  const row = listLocalPullRows().find((r) => r.detail.number === id)
  if (!row) throw new Error(`local review ${id} has no pull row`)
  return { state: row.detail.state }
}

function summaryOf(id: number): LocalReviewSummary {
  const found = listLocalReviews().find((s) => s.id === id)
  if (!found) throw new Error(`local review ${id} is not listed`)
  return found
}

/** The whole of one review's local state, serialized for a byte comparison. */
function serializeLocalState(id: number): string {
  return JSON.stringify({
    record: store.getLocalReview(id),
    snapshot: store.getSnapshot(id),
    drafts: store.listDraftsFor(id),
    viewed: store.getViewed(mockDev.get().humanId, id),
  })
}

/** The stored record, or a loud failure — every caller has just written one. */
function storedRecord(id: number): LocalReviewRecord {
  const record = store.getLocalReview(id)
  if (!record) throw new Error(`local review ${id} is not stored`)
  return record
}

const FROZEN_SENTINEL_SHA = 'sentinel-head-sha-a-live-sync-would-overwrite'
const FROZEN_SENTINEL_SYNCED_AT = '2001-02-03T04:05:06.000Z'

/**
 * Poke a stored record with three values the sync's own work overwrites, so a
 * later "nothing was touched" assertion has something to lose.
 */
function pokeWithLiveSyncBait(id: number): void {
  const record = storedRecord(id)
  record.headSha = FROZEN_SENTINEL_SHA
  record.dirty = true
  record.lastSyncedAt = FROZEN_SENTINEL_SYNCED_AT
  store.putLocalReview(record)
}

/**
 * A local review record written straight into the store, bypassing creation —
 * the hand-edited document the defensive branches exist for. `archivedPr` is
 * set with no snapshot stored, which no runtime path produces.
 */
function putArchivedRecordWithoutSnapshot(input: {
  baseName: string
  headName: string
  archivedPr: number
}): number {
  const at = new Date().toISOString()
  const id = store.nextLocalReviewId()
  store.putLocalReview({
    id,
    repo: fixtureDB.repo.full_name,
    baseRef: `refs/heads/${input.baseName}`,
    headRef: `refs/heads/${input.headName}`,
    title: `Hand-written record for ${input.headName}`,
    baseSha: null,
    mergeBaseSha: null,
    headSha: null,
    dirty: false,
    archivedPr: input.archivedPr,
    createdAt: at,
    updatedAt: at,
    lastSyncedAt: null,
    submitted: [],
    threads: [],
    commentAuthors: {},
  })
  return id
}

function pending(body: string, line: number): PendingComment {
  const at = new Date().toISOString()
  return {
    key: `local-archive-test-${line}`,
    path: 'src/index.ts',
    side: 'RIGHT',
    start_side: null,
    line,
    start_line: null,
    body,
    createdAt: at,
    updatedAt: at,
    anchor: { lineText: 'const x = compute()', contextBefore: [], contextAfter: [] },
  }
}

describe('the fixture pull requests these tests lean on', () => {
  test('each is open and covers exactly the pair written out beside its number', () => {
    for (const covered of COVERED) {
      const fixture = fixtureDB.pulls.find((p) => p.detail.number === covered.number)
      if (!fixture) throw new Error(`fixture pull request ${covered.number} is missing`)
      expect(fixture.detail.state).toBe('open')
      expect(fixture.detail.base.ref).toBe(covered.baseName)
      expect(fixture.detail.head.ref).toBe(covered.headName)
      // A fork's identically named branch is a different pair; the head
      // repository is what separates them.
      expect(fixture.detail.head.repo.full_name).toBe(fixtureDB.repo.full_name)
    }
  })
})

describe('detection on sync', () => {
  test('a review whose pair an open pull request covers archives on its first sync', () => {
    const created = createLocalReview({ baseRef: 'main', headRef: 'fix/cache-ttl-jitter' })
    // Before the sync there is nothing to have found it: the record is live and
    // the row it renders through says so.
    expect(created.archivedPr).toBeNull()
    expect(summaryOf(created.id).archivedPr).toBeNull()
    expect(pullRowOf(created.id).state).toBe('open')

    const returned = syncLocalReview(created.id)

    expect(summaryOf(created.id).archivedPr).toBe(101)
    // Detection precedes the sync's own work, so the snapshot this very sync
    // stored already presents the review as closed.
    expect(returned.mutable.pull.state).toBe('closed')
    const stored = store.getSnapshot(created.id)
    expect(stored?.mutable.pull.state).toBe('closed')
    expect(pullRowOf(created.id).state).toBe('closed')
  })

  test('a review no pull request covers syncs and stays live', () => {
    const covered = createLocalReview({ baseRef: 'main', headRef: 'auth/refresh-scheduler' })
    const live = createLocalReview(uncoveredPair('no-pull-request-covers-this'))

    syncLocalReview(covered.id)
    const returned = syncLocalReview(live.id)

    // The control: detection is demonstrably running in this same body.
    expect(summaryOf(covered.id).archivedPr).toBe(389)

    expect(summaryOf(live.id).archivedPr).toBeNull()
    expect(returned.mutable.pull.state).toBe('open')
    expect(store.getSnapshot(live.id)?.mutable.pull.state).toBe('open')
    expect(pullRowOf(live.id).state).toBe('open')
  })
})

describe('an archived review is frozen at its last sync', () => {
  test('a second sync returns the stored snapshot and touches nothing', () => {
    const created = createLocalReview({ baseRef: 'main', headRef: 'storage/retention-sweep' })
    syncLocalReview(created.id)
    expect(summaryOf(created.id).archivedPr).toBe(410)

    const storedSnapshot = JSON.stringify(store.getSnapshot(created.id))
    const compareKey = store.getSnapshot(created.id)?.immutable.compareKey
    pokeWithLiveSyncBait(created.id)

    const returned = syncLocalReview(created.id)

    expect(JSON.stringify(returned)).toBe(storedSnapshot)
    expect(JSON.stringify(store.getSnapshot(created.id))).toBe(storedSnapshot)
    expect(store.getSnapshot(created.id)?.immutable.compareKey).toBe(compareKey)
    // The bait survives: a sync that re-ran its work would have overwritten
    // all three of these.
    const record = storedRecord(created.id)
    expect(record.headSha).toBe(FROZEN_SENTINEL_SHA)
    expect(record.dirty).toBe(true)
    expect(record.lastSyncedAt).toBe(FROZEN_SENTINEL_SYNCED_AT)
    expect(record.updatedAt).toBe(summaryOf(created.id).updatedAt)
  })

  test('a live review is the control: the same bait is overwritten by its sync', () => {
    const live = createLocalReview(uncoveredPair('freeze-control'))
    syncLocalReview(live.id)
    pokeWithLiveSyncBait(live.id)

    syncLocalReview(live.id)

    const record = storedRecord(live.id)
    expect(record.headSha).not.toBe(FROZEN_SENTINEL_SHA)
    expect(record.dirty).toBe(false)
    expect(record.lastSyncedAt).not.toBe(FROZEN_SENTINEL_SYNCED_AT)
  })

  test('a mark the stored snapshot does not yet reflect earns exactly one catch-up sync', () => {
    // The sync that finds a pull request stores a snapshot that already reads
    // closed, so an archived review normally freezes onto a closed snapshot.
    // A mark the snapshot does not reflect — set by hand here, as another
    // writer would — must not freeze the review onto a stale open snapshot:
    // one more real sync brings the snapshot into agreement with the row, and
    // only then does the freeze take hold.
    const { id } = createLocalReview(uncoveredPair('catch-up'))
    const live = syncLocalReview(id)
    expect(live.mutable.pull.state).toBe('open')

    store.putLocalReview({ ...storedRecord(id), archivedPr: 4242 })

    const caughtUp = syncLocalReview(id)
    expect(caughtUp.mutable.pull.state).toBe('closed')
    expect(store.getSnapshot(id)?.mutable.pull.state).toBe('closed')

    const frozen = syncLocalReview(id)
    expect(JSON.stringify(frozen)).toBe(JSON.stringify(caughtUp))
  })

  test('an archived record with no stored snapshot syncs once, then freezes', () => {
    const id = putArchivedRecordWithoutSnapshot({
      baseName: 'main',
      headName: 'feat/gateway-rate-limiting',
      archivedPr: 312,
    })
    expect(store.getSnapshot(id)).toBeNull()

    // Unreachable by construction, reachable by a hand-edited document: with
    // nothing stored to serve, the review syncs normally exactly once.
    const first = syncLocalReview(id)
    expect(store.getSnapshot(id)).not.toBeNull()
    expect(JSON.stringify(store.getSnapshot(id))).toBe(JSON.stringify(first))
    expect(first.mutable.pull.state).toBe('closed')
    expect(summaryOf(id).archivedPr).toBe(312)

    const storedSnapshot = JSON.stringify(store.getSnapshot(id))
    pokeWithLiveSyncBait(id)
    const second = syncLocalReview(id)

    expect(JSON.stringify(second)).toBe(storedSnapshot)
    expect(storedRecord(id).headSha).toBe(FROZEN_SENTINEL_SHA)
  })
})

describe('archiving is sticky', () => {
  test('a review stays archived when no pull request covers its pair any more', () => {
    const orphaned = putArchivedRecordWithoutSnapshot({
      baseName: 'main',
      headName: 'feature/its-pull-request-was-closed',
      archivedPr: 101,
    })
    const control = createLocalReview({ baseRef: 'main', headRef: 'chore/node-22' })

    syncLocalReview(orphaned)
    syncLocalReview(control.id)

    // The control archives in this same run, so the number below is not the
    // reading of a detector that has stopped firing.
    expect(summaryOf(control.id).archivedPr).toBe(355)

    expect(summaryOf(orphaned).archivedPr).toBe(101)
    expect(store.getSnapshot(orphaned)?.mutable.pull.state).toBe('closed')
  })

  test('detection never runs again on an archived record, so its number never moves', () => {
    // The pair this record names IS covered — by pull request 415 — and the
    // number it already carries is not 415. A detector that re-ran on an
    // archived record would correct it; nothing may.
    const misnumbered = putArchivedRecordWithoutSnapshot({
      baseName: 'release/0.41',
      headName: 'webhooks/constant-time-verify',
      archivedPr: 4242,
    })
    const control = createLocalReview({
      baseRef: 'chore/node-22',
      headRef: 'marcus/strict-null-checks',
    })

    syncLocalReview(misnumbered)
    syncLocalReview(control.id)

    expect(summaryOf(control.id).archivedPr).toBe(362)
    expect(summaryOf(misnumbered).archivedPr).toBe(4242)
  })
})

describe('the four write verbs on an archived review', () => {
  let reviewId = 0
  let refusal = ''
  let threadId = ''
  let rootCommentId = 0

  beforeAll(() => {
    // Built along the honest path: a live review that is synced, submitted
    // against, and only then moved onto a pair pull request 347 covers, so the
    // next sync archives a review that already holds a thread.
    const created = createLocalReview(uncoveredPair('archived-with-a-thread'))
    const synced = syncLocalReview(created.id)
    const submitted = submitLocalReview({
      prNumber: created.id,
      expectedHeadSha: synced.immutable.headSha,
      event: 'COMMENT',
      body: 'Written while the review was still live.',
      comments: [pending('An inline note from before the archive.', 12)],
    })
    if (submitted.status !== 'ok') throw new Error(`submit returned ${submitted.status}`)

    const record = storedRecord(created.id)
    record.headRef = 'refs/heads/metering/usage-rollups'
    store.putLocalReview(record)
    syncLocalReview(created.id)

    reviewId = created.id
    const archived = storedRecord(reviewId)
    if (archived.archivedPr !== 347) {
      throw new Error(`expected the review to archive against 347, got ${String(archived.archivedPr)}`)
    }
    refusal = archivedReviewRefusal({
      archivedPr: 347,
      baseRef: archived.baseRef,
      headRef: archived.headRef,
    })
    const only = archived.threads[0]
    if (!only) throw new Error('the archived review holds no thread')
    threadId = only.id
    rootCommentId = only.comments[0].id
  })

  test('submitting returns a forbidden VALUE naming the pull request, and mutates nothing', () => {
    const before = serializeLocalState(reviewId)
    const result = submitLocalReview({
      prNumber: reviewId,
      expectedHeadSha: storedRecord(reviewId).headSha ?? '',
      event: 'APPROVE',
      body: 'This verdict must not land.',
      comments: [pending('Nor this comment.', 20)],
    })

    expect(result.status).toBe('forbidden')
    expect(result).toEqual({ status: 'forbidden', reason: refusal })
    expect(serializeLocalState(reviewId)).toBe(before)
  })

  test('replying throws a forbidden ApiError and mutates nothing', () => {
    const before = serializeLocalState(reviewId)
    let caught: ApiError | null = null
    try {
      replyToLocalThread(reviewId, threadId, 'This reply must not land.')
    } catch (e) {
      caught = e instanceof ApiError ? e : null
    }

    expect(caught?.code).toBe('forbidden')
    expect(caught?.message).toBe(refusal)
    expect(serializeLocalState(reviewId)).toBe(before)
  })

  test('resolving throws a forbidden ApiError and mutates nothing', () => {
    const before = serializeLocalState(reviewId)
    let caught: ApiError | null = null
    try {
      resolveLocalThread(reviewId, threadId, true)
    } catch (e) {
      caught = e instanceof ApiError ? e : null
    }

    expect(caught?.code).toBe('forbidden')
    expect(caught?.message).toBe(refusal)
    expect(serializeLocalState(reviewId)).toBe(before)
  })

  test('reacting throws a forbidden ApiError and mutates nothing', () => {
    const before = serializeLocalState(reviewId)
    let caught: ApiError | null = null
    try {
      addLocalReaction(reviewId, rootCommentId, 'rocket')
    } catch (e) {
      caught = e instanceof ApiError ? e : null
    }

    expect(caught?.code).toBe('forbidden')
    expect(caught?.message).toBe(refusal)
    expect(serializeLocalState(reviewId)).toBe(before)
  })

  test('the refusal names the pull request and the pair, and promises nothing was sent', () => {
    const record = storedRecord(reviewId)
    expect(refusal).toContain('#347')
    expect(refusal).toContain('main')
    expect(refusal).toContain('metering/usage-rollups')
    // Copied from the shared sentence rather than paraphrased, so the two can
    // never drift into two different refusals.
    expect(refusal).toBe(
      archivedReviewRefusal({
        archivedPr: 347,
        baseRef: record.baseRef,
        headRef: record.headRef,
      }),
    )
  })

  describe('while every read and every draft keeps working', () => {
    test('the snapshot, the threads, a draft and a viewed mark all still answer', async () => {
      const snapshotBefore = store.getSnapshot(reviewId)
      const threadsBefore = snapshotBefore?.mutable.threads

      expect(await api.getSnapshot(reviewId)).toEqual(snapshotBefore)
      expect(await api.listReviewThreads(reviewId)).toEqual(threadsBefore ?? [])
      expect(getLocalReview(reviewId)?.archivedPr).toBe(347)

      const at = new Date().toISOString()
      const draft: ReviewDraft = {
        humanId: mockDev.get().humanId,
        prNumber: reviewId,
        headSha: snapshotBefore?.immutable.headSha ?? '',
        compareKey: snapshotBefore?.immutable.compareKey ?? '',
        body: 'Text a human typed is never refused, archived or not.',
        event: 'COMMENT',
        comments: [],
        createdAt: at,
        updatedAt: at,
      }
      const saved = await api.saveDraft(draft)
      expect((await api.getDraft(reviewId))?.body).toBe(saved.body)

      const viewed = await api.setFileViewed(reviewId, 'src/index.ts', true, null)
      expect(viewed['src/index.ts'].viewed).toBe(true)
      expect(await api.getFileViewed(reviewId)).toEqual(viewed)
    })
  })
})
