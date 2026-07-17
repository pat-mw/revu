/**
 * Integration walk over the mock adapter and its fixtures, mirroring the
 * headless smoke script one assertion at a time.
 *
 * The mock store is stateful (localStorage-backed) and every scenario below
 * mutates it, so this suite is ORDER-DEPENDENT: a pull must be synced before it
 * is reconciled; submitting review 312 clears its draft so later reads differ;
 * the driving human is switched mid-walk; the failure mode is toggled to 'all'
 * and then restored. Bun runs `it()` blocks within a file sequentially in
 * source order, so the describe/it structure preserves the original ordering
 * exactly. A single shared `api` and a one-time `beforeAll` set-up back the
 * whole walk; do not reorder or parallelize.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { createMockApi } from '@/api/mock/adapter'
import { mockDev } from '@/api/mock/devtools'
import type { PullListItem, PullListResponse, ReviewDraft, ReviewThread, Snapshot } from '@revu/shared'
import { ApiError, parseCommentIdentity } from '@revu/shared'
const api = createMockApi()

beforeAll(() => {
  mockDev.setLatency('zero')
  mockDev.setFailureMode('none')
})

// Cross-scenario state threaded through the ordered walk, captured in the
// `it()` that first reads it and asserted against later. The mock store owns
// the truth; these are only the handles the walk carries forward.
let list: PullListResponse
let snap312: Snapshot | null
let draft312: ReviewDraft | null
let snap101: Snapshot
let partial401: Snapshot | null
let old389: Snapshot | null
let draft389: ReviewDraft | null
let snap410: Snapshot | null
let snap415: Snapshot | null
let unresolvedBefore415: number
let li415: PullListItem
let before312: number
let snap355: Snapshot | null
let threads347: ReviewThread[]
let target347: ReviewThread
let t347: ReviewThread

describe('session & list', () => {
  it('session is default human h-priya', async () => {
    const session = await api.getSession()
    expect(session.human.id).toBe('h-priya')
  })

  it('list has 10 pulls', async () => {
    list = await api.listPulls()
    expect(list.items).toHaveLength(10)
  })

  it('pull numbers complete', () => {
    const numbers = list.items.map((i) => i.pull.number).sort((a, b) => a - b)
    expect(numbers).toEqual([101, 204, 312, 347, 355, 362, 389, 401, 410, 415])
  })

  it('etag match → notModified', async () => {
    const again = await api.listPulls({ etag: list.etag })
    expect(again.notModified).toBe(true)
  })
})

describe('seeded state (312)', () => {
  it('312 seeded snapshot exists', async () => {
    snap312 = await api.getSnapshot(312)
    expect(snap312).not.toBeNull()
  })

  it('312 seeded draft has 1 pending comment', async () => {
    draft312 = await api.getDraft(312)
    expect(draft312?.comments.length).toBe(1)
  })

  it('312 seeded viewed has 2 files', async () => {
    const viewed312 = await api.getFileViewed(312)
    expect(Object.values(viewed312).filter((v) => v.viewed)).toHaveLength(2)
  })
})

describe('first sync (101)', () => {
  it('101 starts unsynced', async () => {
    expect(await api.getSnapshot(101)).toBeNull()
  })

  it('101 sync fetched blobs', async () => {
    snap101 = await api.syncPull(101)
    expect(snap101.syncStats?.blobsFetched ?? 0).toBeGreaterThan(0)
  })

  it('101 head blob readable', async () => {
    const headSha101 = snap101.immutable.blobIndex[snap101.immutable.files[0].filename]?.head
    expect(!!headSha101).toBe(true)
    expect((await api.getBlob(headSha101!)).content.length).toBeGreaterThan(0)
  })
})

describe('partial sync (401)', () => {
  it('401 first sync throws network ApiError', async () => {
    let partialThrew = false
    try {
      await api.syncPull(401)
    } catch (e) {
      partialThrew = e instanceof ApiError && e.code === 'network'
    }
    expect(partialThrew).toBe(true)
  })

  it('401 partial snapshot kept', async () => {
    partial401 = await api.getSnapshot(401)
    expect(partial401 !== null && partial401.partial !== null).toBe(true)
  })

  it('401 partial names missing blobs', () => {
    expect(partial401?.partial?.missingBlobShas.length ?? 0).toBeGreaterThan(0)
  })

  it('401 retry succeeds, no partial', async () => {
    const retry401 = await api.syncPull(401)
    expect(retry401.partial).toBeNull()
  })

  it('401 retry fetched exactly the missing blobs', async () => {
    // The retry is a fresh sync; assert against the partial's missing count
    // captured before the retry cleared it.
    const missingCount = partial401?.partial?.missingBlobShas.length
    const retry401 = await api.getSnapshot(401)
    // A second sync after the retry above would refetch nothing; the retry
    // itself fetched exactly what was lost. Re-derive by comparing the retry's
    // stats to the recorded missing count via a fresh sync of the same pull.
    expect(retry401?.syncStats?.blobsFetched).toBe(missingCount)
  })
})

describe('reconcile fixture (389)', () => {
  it('389 seeded snapshot behind remote', async () => {
    old389 = await api.getSnapshot(389)
    draft389 = await api.getDraft(389)
    expect(old389 !== null && draft389 !== null).toBe(true)
  })

  it('389 draft targets old head', () => {
    expect(draft389!.headSha).toBe(old389!.immutable.headSha)
  })

  it('389 list shows moved head', async () => {
    const li389 = (await api.listPulls()).items.find((i) => i.pull.number === 389)!
    expect(li389.pull.head.sha).not.toBe(old389!.immutable.headSha)
  })

  it('389 commit delta = 3', async () => {
    const li389 = (await api.listPulls()).items.find((i) => i.pull.number === 389)!
    expect(li389.broker.commitCount - old389!.immutable.commits.length).toBe(3)
  })

  it('389 reconcile → clean/drifted/lost', async () => {
    await api.syncPull(389)
    const report = await api.reconcileDraft(389)
    const kinds = report.results.map((r) => r.kind).sort()
    expect(kinds).toEqual(['clean', 'drifted', 'lost'])
  })

  it('389 drifted delta is +12', async () => {
    const report = await api.reconcileDraft(389)
    const drifted = report.results.find((r) => r.kind === 'drifted')
    expect(drifted?.kind === 'drifted' && drifted.delta === 12).toBe(true)
  })

  it('389 reconcile lists 3 new commits', async () => {
    const report = await api.reconcileDraft(389)
    expect(report.newCommits).toHaveLength(3)
  })
})

describe('base advanced (410)', () => {
  it('410 head unchanged', async () => {
    snap410 = await api.getSnapshot(410)
    const li410 = (await api.listPulls()).items.find((i) => i.pull.number === 410)!
    expect(li410.pull.head.sha).toBe(snap410!.immutable.headSha)
  })

  it('410 compareKey moved (base advanced)', async () => {
    const li410 = (await api.listPulls()).items.find((i) => i.pull.number === 410)!
    expect(li410.broker.compareKey).not.toBe(snap410!.immutable.compareKey)
  })

  it('410 re-sync rebuilt immutable', async () => {
    const li410 = (await api.listPulls()).items.find((i) => i.pull.number === 410)!
    const resync410 = await api.syncPull(410)
    expect(resync410.immutable.compareKey).toBe(li410.broker.compareKey)
  })

  it('410 gained gc-config in compare', async () => {
    const resync410 = await api.getSnapshot(410)
    expect(resync410!.immutable.files.some((f) => f.filename.includes('gc-config'))).toBe(true)
  })
})

describe('mutable drift (415)', () => {
  it('415 broker sees fewer unresolved than stale snapshot', async () => {
    snap415 = await api.getSnapshot(415)
    unresolvedBefore415 = snap415!.mutable.threads.filter((t) => !t.isResolved).length
    li415 = (await api.listPulls()).items.find((i) => i.pull.number === 415)!
    expect(li415.broker.unresolvedThreads).toBeLessThan(unresolvedBefore415)
  })

  it('415 re-sync reused every blob', async () => {
    const resync415 = await api.syncPull(415)
    expect(resync415.syncStats?.blobsFetched).toBe(0)
  })

  it('415 thread now resolved, same compareKey', async () => {
    const resync415 = await api.getSnapshot(415)
    const sameCompareKey = resync415!.immutable.compareKey === snap415!.immutable.compareKey
    const unresolvedMatches =
      resync415!.mutable.threads.filter((t) => !t.isResolved).length ===
      li415.broker.unresolvedThreads
    expect(sameCompareKey && unresolvedMatches).toBe(true)
  })
})

describe('submit paths (312)', () => {
  it('312 submit vs wrong head → head_moved', async () => {
    const moved = await api.submitReview({
      prNumber: 312,
      expectedHeadSha: 'not-the-real-head',
      event: 'COMMENT',
      body: '',
      comments: draft312!.comments,
    })
    expect(moved.status).toBe('head_moved')
  })

  it('312 APPROVE → forbidden (App-authored)', async () => {
    const forbidden = await api.submitReview({
      prNumber: 312,
      expectedHeadSha: snap312!.immutable.headSha,
      event: 'APPROVE',
      body: 'lgtm',
      comments: [],
    })
    expect(forbidden.status).toBe('forbidden')
  })

  it('312 COMMENT submit ok and creates a thread, clears draft', async () => {
    before312 = (await api.listReviewThreads(312)).length
    const ok312 = await api.submitReview({
      prNumber: 312,
      expectedHeadSha: snap312!.immutable.headSha,
      event: 'COMMENT',
      body: 'First pass done.',
      comments: draft312!.comments,
    })
    expect(ok312.status).toBe('ok')

    const after312 = await api.listReviewThreads(312)
    expect(after312).toHaveLength(before312 + 1)

    expect(await api.getDraft(312)).toBeNull()

    const newThread = after312[after312.length - 1]
    const parsed = parseCommentIdentity(newThread.comments[0])
    expect(parsed.identity.kind === 'human' && parsed.identity.name === 'Priya Raman').toBe(true)
  })
})

describe('approve on org PR (355)', () => {
  it('355 APPROVE succeeds (org-member PR)', async () => {
    await api.syncPull(355)
    snap355 = await api.getSnapshot(355)
    const ok355 = await api.submitReview({
      prNumber: 355,
      expectedHeadSha: snap355!.immutable.headSha,
      event: 'APPROVE',
      body: 'Runtime bump verified in the workspace image.',
      comments: [],
    })
    expect(ok355.status === 'ok' && ok355.review.state === 'APPROVED').toBe(true)
  })
})

describe('reply + reaction dedupe (347)', () => {
  it('347 has 4 unresolved threads', async () => {
    threads347 = await api.listReviewThreads(347)
    expect(threads347.filter((t) => !t.isResolved)).toHaveLength(4)
  })

  it('347 reply smuggles current human', async () => {
    target347 = threads347.find((t) => !t.isResolved)!
    const reply = await api.replyToThread(347, target347.id, 'Pushed a fix in the latest commit.')
    const replyParsed = parseCommentIdentity(reply)
    expect(replyParsed.identity.kind === 'human' && replyParsed.identity.name === 'Priya Raman').toBe(
      true,
    )
  })

  it('347 reply threads updated in snapshot', async () => {
    const updated = (await api.listReviewThreads(347)).find((t) => t.id === target347.id)!
    expect(updated.comments).toHaveLength(target347.comments.length + 1)
  })

  it('reaction dedupe: shared identity cannot double-react', async () => {
    // Branches on whether any 347 comment already carries a reaction. With one,
    // re-adding the same emoji returns the rollup unchanged (shared identity is
    // already counted). With none, two identical adds still leave the count at 1.
    const commentWithReaction = threads347
      .flatMap((t) => t.comments)
      .find((c) => c.reactions.total_count > 0)
    if (commentWithReaction) {
      const key = (
        ['+1', 'heart', 'laugh', 'hooray', 'confused', 'rocket', 'eyes', '-1'] as const
      ).find((k) => commentWithReaction.reactions[k] > 0)!
      const rollup = await api.addReaction(347, commentWithReaction.id, key)
      expect(rollup[key]).toBe(commentWithReaction.reactions[key])
    } else {
      const c = threads347[0].comments[0]
      const r1 = await api.addReaction(347, c.id, 'eyes')
      const r2 = await api.addReaction(347, c.id, 'eyes')
      expect(r1.eyes === 1 && r2.eyes === 1).toBe(true)
    }
  })
})

describe('per-human isolation', () => {
  it('draft isolation: alice sees no 389 draft', async () => {
    mockDev.setHuman('h-alice')
    expect(await api.getDraft(389)).toBeNull()
  })

  it('viewed isolation: alice sees no 312 viewed state', async () => {
    expect(Object.keys(await api.getFileViewed(312))).toHaveLength(0)
  })

  it('draft survives identity round-trip', async () => {
    mockDev.setHuman('h-priya')
    expect((await api.getDraft(389))?.comments.length).toBe(3)
  })
})

describe('resolve/unresolve', () => {
  it('resolve flips thread', async () => {
    t347 = (await api.listReviewThreads(347)).find((t) => !t.isResolved)!
    const resolved = await api.resolveThread(347, t347.id, true)
    expect(resolved.isResolved).toBe(true)
  })

  it('broker unresolved count follows remote truth', async () => {
    const li347 = (await api.listPulls()).items.find((i) => i.pull.number === 347)!
    expect(li347.broker.unresolvedThreads).toBe(3)
  })
})

describe('failure modes', () => {
  it('offline-first: cached snapshot readable with broker down', async () => {
    mockDev.setFailureMode('all')
    let cachedOk = false
    try {
      cachedOk = (await api.getSnapshot(312)) !== null
    } catch {
      cachedOk = false
    }
    expect(cachedOk).toBe(true)
  })

  it('failure mode: writes fail loudly', async () => {
    let writeFailed = false
    try {
      await api.replyToThread(347, t347.id, 'this must fail')
    } catch (e) {
      writeFailed = e instanceof ApiError
    }
    expect(writeFailed).toBe(true)
    mockDev.setFailureMode('none')
  })
})
