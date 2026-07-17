/**
 * Mock-specific integration walk over the adapter and its fixtures.
 *
 * The transport invariants shared with every adapter — baseline sync shape, the
 * two-half cache keying (base-advanced / mutable-drift), `head_moved`-as-a-value,
 * partial-sync resume, reconcile classification, and draft survival across a
 * restart — live once in `@revu/shared/conformance` and are driven against this
 * mock by `./conformance.test.ts`. This file keeps only what is specific to the
 * mock: the seeded broker state, the submit ok/forbidden/approve paths, the
 * identity-smuggling reply + reaction-dedupe behaviour, per-human isolation,
 * resolve/unresolve, and the failure modes. Between them, every assertion the
 * headless smoke script makes is covered, with no invariant duplicated here.
 *
 * The mock store is stateful (localStorage-backed) and every scenario below
 * mutates it, so this suite is ORDER-DEPENDENT: submitting review 312 clears its
 * draft so later reads differ; the driving human is switched mid-walk; the
 * failure mode is toggled to 'all' and then restored. Bun runs `it()` blocks
 * within a file sequentially in source order, so the describe/it structure
 * preserves the ordering exactly. A single shared `api` and a one-time
 * `beforeAll` set-up back the whole walk; do not reorder or parallelize.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { createMockApi } from '@/api/mock/adapter'
import { mockDev } from '@/api/mock/devtools'
import { fixtureDB } from '@/fixtures'
import type { PullListResponse, ReviewDraft, ReviewThread, Snapshot } from '@revu/shared'
import { ApiError, parseCommentIdentity } from '@revu/shared'
const api = createMockApi()

beforeAll(() => {
  // Start from a pristine seed: `bun test` shares one localStorage-backed store
  // across every file in the process, so another file's mock mutations (or a
  // debounced flush of them) could otherwise leak in and derail this ordered
  // walk. Resetting here makes the walk depend only on the fixtures.
  mockDev.reset()
  mockDev.setLatency('zero')
  mockDev.setFailureMode('none')
})

// Cross-scenario state threaded through the ordered walk, captured in the
// `it()` that first reads it and asserted against later. The mock store owns
// the truth; these are only the handles the walk carries forward.
let list: PullListResponse
let snap312: Snapshot | null
let draft312: ReviewDraft | null
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

describe('digit-in-username fixture regression (415)', () => {
  it('415 seeded reply from a digit-in-username contractor parses to a human', async () => {
    // A contractor whose display name is a Coder username carrying a digit
    // (`alice2`) authored a reply through the broker. Its smuggled prefix must
    // resolve back to that human, not collapse to the bare bot — the digit
    // charset regression this fixture guards.
    const snap = await api.getSnapshot(415)
    const { brokerLogin } = await api.getSession()
    const brokerComment = snap!.mutable.threads
      .flatMap((t) => t.comments)
      .find((c) => c.user.login === brokerLogin && c.body.includes('alice2'))
    expect(brokerComment).toBeDefined()
    const parsed = parseCommentIdentity(brokerComment!, brokerLogin)
    expect(parsed.identity.kind === 'human' && parsed.identity.name === 'alice2').toBe(true)
  })
})

describe('submit paths (312)', () => {
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
    const { brokerLogin } = await api.getSession()
    const parsed = parseCommentIdentity(newThread.comments[0], brokerLogin)
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

  it('347 sync output carries a commentAuthors entry for every broker-authored comment', async () => {
    // The write log rides the snapshot's mutable half. Every comment the broker
    // bot authored (smuggled human prefix, not an org member) must appear in
    // commentAuthors, and each mapped value must be a real human id — so
    // own-comment detection has ground truth for exactly those comments.
    const snap347 = (await api.getSnapshot(347))!
    const { brokerLogin } = await api.getSession()
    const authors = snap347.mutable.commentAuthors ?? {}
    const humanIds = new Set(fixtureDB.humans.map((h) => h.id))

    const brokerComments = snap347.mutable.threads
      .flatMap((t) => t.comments)
      .filter((c) => parseCommentIdentity(c, brokerLogin).identity.kind === 'human')

    expect(brokerComments.length).toBeGreaterThan(0)
    for (const c of brokerComments) {
      expect(authors[c.id]).toBeDefined()
      expect(humanIds.has(authors[c.id])).toBe(true)
    }
    // And an org-member (non-broker) comment is NOT in the write log.
    const orgComment = snap347.mutable.threads
      .flatMap((t) => t.comments)
      .find((c) => parseCommentIdentity(c, brokerLogin).identity.kind === 'github')
    if (orgComment) expect(authors[orgComment.id]).toBeUndefined()
  })

  it('347 reply smuggles current human', async () => {
    target347 = threads347.find((t) => !t.isResolved)!
    const reply = await api.replyToThread(347, target347.id, 'Pushed a fix in the latest commit.')
    const { brokerLogin } = await api.getSession()
    const replyParsed = parseCommentIdentity(reply, brokerLogin)
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
    expect((await api.getDraft(389))?.comments.length).toBe(4)
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

describe('per-human preferences', () => {
  it('defaults to unified diff layout', async () => {
    mockDev.setHuman('h-priya')
    expect((await api.getPreferences()).diffMode).toBe('unified')
  })

  it('a set persists and reads back', async () => {
    const saved = await api.setPreferences({ diffMode: 'split' })
    expect(saved.diffMode).toBe('split')
    expect((await api.getPreferences()).diffMode).toBe('split')
  })

  it('is per-human: another human still sees the default', async () => {
    mockDev.setHuman('h-alice')
    expect((await api.getPreferences()).diffMode).toBe('unified')
    mockDev.setHuman('h-priya')
    expect((await api.getPreferences()).diffMode).toBe('split')
  })

  it('reads offline: the preference is broker-side cache, not a remote read', async () => {
    mockDev.setFailureMode('all')
    expect((await api.getPreferences()).diffMode).toBe('split')
    mockDev.setFailureMode('none')
  })
})
