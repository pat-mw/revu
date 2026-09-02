/**
 * The query layer for local-only reviews, asserted where it is assertable:
 * against the real mock transport and a real `QueryClient`, with no renderer.
 *
 * The load-bearing property here is the division of labour between the two
 * query sources. `usePullList` is the row source for every rendered row; the
 * annotation query supplies only what the frozen list-item type cannot carry.
 * A collision between their keys, or a refresh that fails to land the new row,
 * is what these assertions catch.
 *
 * The mock's store is a single localStorage-backed document shared by every
 * `bun test` file in the process, so this suite resets it and forces zero
 * latency before the first test and restores it after the last — otherwise
 * another file's mutations leak in and the suite is green locally and red on a
 * slower runner.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import type { LocalReviewSummary, PullListResponse, ReviewDraft, RevuApi, Snapshot } from '@revu/shared'
import { ApiError, draftHoldsText, isLocalReviewId } from '@revu/shared'
import { createMockApi } from '@/api/mock/adapter'
import { mockDev } from '@/api/mock/devtools'
import { qk, refreshAfterLocalReviewSync } from './queries'
import {
  hasAnyLocalReview,
  performLocalReviewDelete,
  refreshAfterLocalReviewCreate,
  refreshAfterLocalReviewDelete,
} from './local-reviews'

const api = createMockApi()

/**
 * Branch pairs the workspace could really offer: every ref below is one the
 * branch listing returns, and none of them is the pair the seeded review
 * already holds — creating that one would return the seeded review and quietly
 * defeat the "this id is new" precondition two tests depend on.
 */
const BASE = 'refs/heads/main'
const HEAD_IDEMPOTENT = 'refs/heads/chore/node-22'
const HEAD_REFRESH = 'refs/heads/fix/cache-ttl-jitter'
const HEAD_ETAG = 'refs/heads/feat/gateway-rate-limiting'

beforeAll(() => {
  mockDev.reset()
  mockDev.setLatency('zero')
})

afterAll(() => {
  // This suite creates local reviews; hand the shared store back pristine.
  mockDev.reset()
})

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function cachedPullNumbers(qc: QueryClient): number[] {
  const cached = qc.getQueryData<PullListResponse>(qk.pulls)
  if (!cached) throw new Error('The pull list was expected in the cache and was not there.')
  return cached.items.map((i) => i.pull.number)
}

// ————————————————————————————————————————————————————————————————
// 1 — Creating the same branch pair twice yields one review, and the pull list
//     (the row source) carries it exactly once.
// ————————————————————————————————————————————————————————————————

describe('creating the same branch pair twice', () => {
  test('returns the same local-band id and lands exactly one row', async () => {
    const first = await api.createLocalReview({ baseRef: BASE, headRef: HEAD_IDEMPOTENT })
    const second = await api.createLocalReview({ baseRef: BASE, headRef: HEAD_IDEMPOTENT })

    expect(second.id).toBe(first.id)
    expect(isLocalReviewId(first.id)).toBe(true)

    const list = await api.listPulls()
    const matching = list.items.filter((i) => i.pull.number === first.id)
    expect(matching).toHaveLength(1)
  })
})

// ————————————————————————————————————————————————————————————————
// 2 — The post-create refresh actually lands the row in the cache. A helper
//     that only marks the entry stale leaves the old items in place, and the
//     caller navigates to a review the layout cannot resolve.
// ————————————————————————————————————————————————————————————————

describe('refreshAfterLocalReviewCreate', () => {
  test('leaves the pull list cache carrying the new review', async () => {
    const qc = newQueryClient()
    await qc.fetchQuery({ queryKey: qk.pulls, queryFn: () => api.listPulls() })

    const created = await api.createLocalReview({ baseRef: BASE, headRef: HEAD_REFRESH })

    // The precondition that makes the assertion below sensitive: without the
    // refresh, the cache holds a list minted before the review existed.
    expect(cachedPullNumbers(qc)).not.toContain(created.id)

    // And this client holds no mounted observer — the exact condition under
    // which a plain `invalidateQueries` refetches nothing at all.
    const entry = qc.getQueryCache().find({ queryKey: qk.pulls })
    expect(entry?.getObserversCount()).toBe(0)

    await refreshAfterLocalReviewCreate(qc)

    expect(cachedPullNumbers(qc)).toContain(created.id)
    qc.clear()
  })
})

// ————————————————————————————————————————————————————————————————
// 3 — The conditional-request short-circuit cannot hide a brand-new review.
//     The local half of the list ETag is a hash over the local reviews, so it
//     has to move across a create; this is the app-side pin on that promise.
// ————————————————————————————————————————————————————————————————

describe('the list ETag across a create', () => {
  test('does not answer not-modified, and carries the new review', async () => {
    const before = await api.listPulls()
    const created = await api.createLocalReview({ baseRef: BASE, headRef: HEAD_ETAG })

    const after = await api.listPulls({ etag: before.etag })

    expect(after.notModified).not.toBe(true)
    expect(after.items.map((i) => i.pull.number)).toContain(created.id)
  })
})

// ————————————————————————————————————————————————————————————————
// 4 — Both keys live in the factory and none of the three collide. A shared
//     cache entry between the annotation query and the row source is the
//     two-truths hazard in its cheapest form.
// ————————————————————————————————————————————————————————————————

describe('the query key factory', () => {
  test('carries branches and local reviews as keys distinct from the pull list', () => {
    expect(Array.isArray(qk.branches)).toBe(true)
    expect(Array.isArray(qk.localReviews)).toBe(true)

    const branches = JSON.stringify(qk.branches)
    const localReviews = JSON.stringify(qk.localReviews)
    const pulls = JSON.stringify(qk.pulls)

    expect(branches).not.toBe(pulls)
    expect(localReviews).not.toBe(pulls)
    expect(branches).not.toBe(localReviews)
  })
})

// ————————————————————————————————————————————————————————————————
// 5 — The one existence question the row source cannot answer. The inbox's
//     local section renders iff the human has ANY local review, and the
//     derivation reads the annotation list — never a row, and never the pull
//     list cache.
// ————————————————————————————————————————————————————————————————

describe('hasAnyLocalReview', () => {
  test('is false for a workspace with no local reviews, and while the query is loading', () => {
    expect(hasAnyLocalReview([])).toBe(false)
    expect(hasAnyLocalReview(undefined)).toBe(false)
  })

  test('is true from the annotation list alone, with no rows cached anywhere', async () => {
    const summaries = await api.listLocalReviews()
    expect(summaries.length).toBeGreaterThan(0)

    // A client that has never fetched the row source: if the derivation read
    // rows rather than annotations, it could only answer false here.
    const qc = newQueryClient()
    expect(qc.getQueryData<PullListResponse>(qk.pulls)).toBeUndefined()
    expect(hasAnyLocalReview(summaries)).toBe(true)
    expect(hasAnyLocalReview([summaries[0]!])).toBe(true)
    qc.clear()
  })
})

// ————————————————————————————————————————————————————————————————
// 5 — A sync can change what the two caches say about a local review: it can
//     archive it (the row closes, the annotation gains the pull request number)
//     or flip its dirty flag. The sync mutation therefore refreshes both, the
//     same way a create does — and only for a local review, because a pull
//     request's sync moves nothing in either list.
// ————————————————————————————————————————————————————————————————

function cachedRowState(qc: QueryClient, id: number): string {
  const cached = qc.getQueryData<PullListResponse>(qk.pulls)
  const row = cached?.items.find((i) => i.pull.number === id)
  if (!row) throw new Error(`Review ${id} was expected in the cached pull list and was not there.`)
  return row.pull.state
}

function cachedArchivedPr(qc: QueryClient, id: number): number | null {
  const cached = qc.getQueryData<LocalReviewSummary[]>(qk.localReviews)
  const summary = cached?.find((s) => s.id === id)
  if (!summary) throw new Error(`Review ${id} was expected in the cached annotations and was not there.`)
  return summary.archivedPr
}

function updateCounts(qc: QueryClient): number[] {
  return [qk.pulls, qk.localReviews].map(
    (key) => qc.getQueryCache().find({ queryKey: key })?.state.dataUpdateCount ?? -1,
  )
}

describe('refreshAfterLocalReviewSync', () => {
  test('lands the archived state a sync just produced in both caches', async () => {
    const qc = newQueryClient()
    // A pair an open fixture pull request covers, so the mock archives the
    // review on its first sync — the one sync outcome both caches must learn.
    const review = await api.createLocalReview({ baseRef: BASE, headRef: HEAD_REFRESH })
    await qc.fetchQuery({ queryKey: qk.pulls, queryFn: () => api.listPulls() })
    await qc.fetchQuery({ queryKey: qk.localReviews, queryFn: () => api.listLocalReviews() })
    expect(cachedRowState(qc, review.id)).toBe('open')
    expect(cachedArchivedPr(qc, review.id)).toBeNull()

    const snapshot = await api.syncPull(review.id)
    expect(snapshot.mutable.pull.state).toBe('closed')

    // The precondition that makes the assertion sensitive: the transport has
    // moved on and both caches still describe a live review.
    expect(cachedRowState(qc, review.id)).toBe('open')
    expect(cachedArchivedPr(qc, review.id)).toBeNull()
    expect(qc.getQueryCache().find({ queryKey: qk.pulls })?.getObserversCount()).toBe(0)

    await refreshAfterLocalReviewSync(qc, review.id)

    expect(cachedRowState(qc, review.id)).toBe('closed')
    expect(cachedArchivedPr(qc, review.id)).toBe(101)
    qc.clear()
  })

  test('a pull request sync leaves both caches untouched — the control', async () => {
    const qc = newQueryClient()
    await qc.fetchQuery({ queryKey: qk.pulls, queryFn: () => api.listPulls() })
    await qc.fetchQuery({ queryKey: qk.localReviews, queryFn: () => api.listLocalReviews() })
    const before = updateCounts(qc)
    expect(before.every((n) => n === 1)).toBe(true)

    await refreshAfterLocalReviewSync(qc, 101)

    expect(updateCounts(qc)).toEqual(before)
    expect(qc.getQueryCache().find({ queryKey: qk.pulls })?.state.isInvalidated).toBe(false)
    qc.clear()
  })
})

// ————————————————————————————————————————————————————————————————
// 6 — Deleting a local review. The delete is refused where the review is held
//     for as long as any human's draft on it holds text, and the only way past
//     that refusal is the one the refusal names: discard the draft, then repeat
//     the identical call. Driven here through the same pure function the dialog
//     calls, with no renderer anywhere.
// ————————————————————————————————————————————————————————————————

/**
 * Branch pairs no earlier test in this file has created. A base that is a
 * remote-tracking ref is an ordinary thing to review against, and it is what
 * keeps these pairs distinct from the ones above without needing branches the
 * workspace does not have.
 */
const DELETE_BASE = 'refs/remotes/origin/main'
const CONTROL_BASE = 'refs/remotes/origin/release/0.41'
const HEAD_DELETE_DRAFT = 'refs/heads/marcus/strict-null-checks'
const HEAD_DELETE_CLEAN = 'refs/heads/chore/node-22'
const HEAD_DELETE_CACHE = 'refs/heads/feat/gateway-rate-limiting'

/** A draft with text in it, anchored to the compare the review was synced at. */
function draftWithText(reviewId: number, snapshot: Snapshot): ReviewDraft {
  const at = new Date().toISOString()
  return {
    humanId: mockDev.get().humanId,
    prNumber: reviewId,
    headSha: snapshot.immutable.headSha,
    compareKey: snapshot.immutable.compareKey,
    body: 'Half a review, still being written.',
    event: 'COMMENT',
    comments: [],
    createdAt: at,
    updatedAt: at,
  }
}

/**
 * The two calls a delete can make, wrapped so the test can see WHICH were made.
 *
 * A delete that discards a draft nobody asked it to discard destroys text
 * silently, and the outcome of both paths is the same word — so the only thing
 * that can tell them apart is whether the discard was called at all.
 */
function spyingApi(): {
  api: Pick<RevuApi, 'discardDraft' | 'deleteLocalReview'>
  discarded: number[]
} {
  const discarded: number[] = []
  return {
    api: {
      discardDraft: async (reviewId: number) => {
        discarded.push(reviewId)
        await api.discardDraft(reviewId)
      },
      deleteLocalReview: (reviewId: number) => api.deleteLocalReview(reviewId),
    },
    discarded,
  }
}

/** Whether the row source still lists this review. */
async function stillListed(reviewId: number): Promise<boolean> {
  return (await api.listPulls()).items.some((i) => i.pull.number === reviewId)
}

describe('performLocalReviewDelete on a review holding unsubmitted text', () => {
  test('comes back refused, with the refusal worded where the review is held', async () => {
    const review = await api.createLocalReview({
      baseRef: DELETE_BASE,
      headRef: HEAD_DELETE_DRAFT,
    })
    const snapshot = await api.syncPull(review.id)
    const saved = await api.saveDraft(draftWithText(review.id, snapshot))
    expect(draftHoldsText(saved)).toBe(true)

    const spy = spyingApi()
    const result = await performLocalReviewDelete({
      api: spy.api,
      reviewId: review.id,
      discardOwnDraft: false,
    })

    expect(result.outcome).toBe('refused')
    // The sentence names its own remedy, and the dialog shows it verbatim —
    // so a refusal that stopped naming one would leave a reader stuck.
    expect(result.outcome === 'refused' ? result.reason : '').toMatch(/discard/i)

    // A refusal is a precondition, not a partial delete: nothing was discarded
    // on the way to it, the review is still listed, and the text is still there.
    expect(spy.discarded).toEqual([])
    expect(await stillListed(review.id)).toBe(true)
    expect((await api.getDraft(review.id))?.body).toBe(saved.body)
  })

  test('and goes through when the identical call is asked to discard first', async () => {
    // The same review — creation is idempotent per branch pair, so this is the
    // one the test above left standing rather than a second one.
    const review = await api.createLocalReview({
      baseRef: DELETE_BASE,
      headRef: HEAD_DELETE_DRAFT,
    })
    expect((await api.getDraft(review.id))?.body).toBe('Half a review, still being written.')

    const spy = spyingApi()
    const result = await performLocalReviewDelete({
      api: spy.api,
      reviewId: review.id,
      discardOwnDraft: true,
    })

    expect(result).toEqual({ outcome: 'deleted' })
    expect(spy.discarded).toEqual([review.id])
    expect(await stillListed(review.id)).toBe(false)
    expect((await api.listLocalReviews()).some((r) => r.id === review.id)).toBe(false)
    expect(await api.getDraft(review.id)).toBeNull()
  })

  test('a review holding no text is deleted without any discard at all', async () => {
    const clean = await api.createLocalReview({
      baseRef: DELETE_BASE,
      headRef: HEAD_DELETE_CLEAN,
    })
    const spy = spyingApi()

    expect(
      await performLocalReviewDelete({
        api: spy.api,
        reviewId: clean.id,
        discardOwnDraft: false,
      }),
    ).toEqual({ outcome: 'deleted' })

    // The positive control, through the SAME spy: a delete that is asked to
    // discard does call through, so the absence above is a decision this
    // function made rather than a spy that records nothing.
    const other = await api.createLocalReview({
      baseRef: CONTROL_BASE,
      headRef: HEAD_DELETE_CLEAN,
    })
    expect(
      await performLocalReviewDelete({
        api: spy.api,
        reviewId: other.id,
        discardOwnDraft: true,
      }),
    ).toEqual({ outcome: 'deleted' })

    expect(spy.discarded).toEqual([other.id])
  })

  test('a failure that is not the draft refusal is not swallowed', async () => {
    // Only the one refusal is turned into an outcome the dialog can act on.
    // Anything else — a review that is not there, a transport that did not
    // answer — has no remedy this screen can offer, so it propagates and is
    // reported as the failure it is rather than as a polite sentence.
    const spy = spyingApi()
    let code: string | null = null
    try {
      await performLocalReviewDelete({
        api: spy.api,
        reviewId: 1_000_000_999,
        discardOwnDraft: false,
      })
    } catch (error) {
      code = error instanceof ApiError ? error.code : 'not an ApiError'
    }
    expect(code).toBe('not_found')
  })
})

// ————————————————————————————————————————————————————————————————
// 7 — The post-delete refresh. Every entry keyed by the deleted review has to
//     go with it: the id is never minted again, so anything left behind
//     describes a review nothing can ever reach.
// ————————————————————————————————————————————————————————————————

describe('refreshAfterLocalReviewDelete', () => {
  test('takes the review out of both lists, and its snapshot and draft with it', async () => {
    const qc = newQueryClient()
    const review = await api.createLocalReview({
      baseRef: DELETE_BASE,
      headRef: HEAD_DELETE_CACHE,
    })
    const snapshot = await api.syncPull(review.id)
    await qc.fetchQuery({ queryKey: qk.pulls, queryFn: () => api.listPulls() })
    await qc.fetchQuery({ queryKey: qk.localReviews, queryFn: () => api.listLocalReviews() })
    qc.setQueryData(qk.snapshot(review.id), snapshot)
    qc.setQueryData(qk.draft(review.id), null)

    await api.deleteLocalReview(review.id)

    // The preconditions that make the assertions below sensitive: both caches
    // still describe a review that is gone, and this client holds no mounted
    // observer — the exact condition under which a plain invalidation
    // refetches nothing at all.
    expect(cachedPullNumbers(qc)).toContain(review.id)
    expect(qc.getQueryData(qk.snapshot(review.id))).toBeDefined()
    expect(qc.getQueryCache().find({ queryKey: qk.pulls })?.getObserversCount()).toBe(0)

    await refreshAfterLocalReviewDelete(qc, review.id)

    expect(cachedPullNumbers(qc)).not.toContain(review.id)
    expect(
      qc.getQueryData<LocalReviewSummary[]>(qk.localReviews)?.some((r) => r.id === review.id),
    ).toBe(false)
    expect(qc.getQueryData(qk.snapshot(review.id))).toBeUndefined()
    expect(qc.getQueryCache().find({ queryKey: qk.draft(review.id) })).toBeUndefined()
    qc.clear()
  })
})
