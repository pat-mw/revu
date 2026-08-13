/**
 * Semantics of the local-review engine — reviews of a branch pair that has no
 * pull request and never touches GitHub.
 *
 * These tests pin the behaviors every other implementation must reproduce:
 * the synthesized wire shapes validate unchanged, the sentinel user never
 * carries an email, minted ids stay inside their reserved bands, comment
 * bodies are stored verbatim (no identity stamp — with a positive control so
 * a broken matcher cannot pass vacuously), submitted reviews never enter the
 * snapshot's `mutable.reviews`, creation is idempotent per branch pair, and
 * deletion removes the record without recycling its id or destroying drafts.
 *
 * The mock store is one process-wide document shared across every test file,
 * so the suite resets it before and after itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Human, PendingComment, ReviewDraft, Snapshot, SubmitReviewInput } from '@revu/shared'
import {
  ApiError,
  LOCAL_ENTITY_ID_BASE,
  LOCAL_REVIEW_ID_BASE,
  prefixBody,
  validateLocalReviewSummary,
  vPullDetail,
} from '@revu/shared'
import { mockDev } from './devtools'
import { store } from './store'
import {
  createLocalReview,
  deleteLocalReview,
  getLocalReview,
  listLocalReviews,
  listLocalSubmittedReviews,
  localThreadId,
  submitLocalReview,
  syncLocalReview,
  synthesizeLocalUser,
} from './local'

beforeAll(() => {
  mockDev.reset()
})

afterAll(() => {
  mockDev.reset()
})

/** The ApiError code a call throws, or null when it does not throw. */
function thrownCode(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof ApiError ? e.code : `not an ApiError: ${String(e)}`
  }
}

function pending(body: string, line: number): PendingComment {
  const at = new Date().toISOString()
  return {
    key: `local-test-${line}`,
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

function draftFor(humanId: string, prNumber: number, snap: Snapshot): ReviewDraft {
  const at = new Date().toISOString()
  return {
    humanId,
    prNumber,
    headSha: snap.immutable.headSha,
    compareKey: snap.immutable.compareKey,
    body: 'Draft text that must survive everything except a confirmed submit.',
    event: 'COMMENT',
    comments: [],
    createdAt: at,
    updatedAt: at,
  }
}

describe('creation', () => {
  test('a created summary validates on the wire and carries the never-synced nulls', () => {
    const created = createLocalReview({ baseRef: 'main', headRef: 'feature/summary-shape' })

    expect(created.id).toBeGreaterThanOrEqual(LOCAL_REVIEW_ID_BASE)
    expect(created.repo).toBe('meridian-labs/atlas')
    expect(created.baseRef).toBe('refs/heads/main')
    expect(created.headRef).toBe('refs/heads/feature/summary-shape')
    // No title given: the head branch's short name stands in.
    expect(created.title).toBe('feature/summary-shape')
    expect(created.baseSha).toBeNull()
    expect(created.mergeBaseSha).toBeNull()
    expect(created.headSha).toBeNull()
    expect(created.lastSyncedAt).toBeNull()
    expect(created.dirty).toBe(false)
    expect(created.archivedPr).toBeNull()

    // The summary is exactly the wire type — a validator round-trip drops any
    // key the wire shape does not declare, so store-only fields leaking into
    // the summary would fail this strict equality.
    const wire = JSON.parse(JSON.stringify(created)) as unknown
    expect(validateLocalReviewSummary(wire)).toStrictEqual(wire as ReturnType<typeof validateLocalReviewSummary>)

    // The first sync fills the SHA and timestamp fields in.
    syncLocalReview(created.id)
    const synced = getLocalReview(created.id)
    expect(synced?.headSha).not.toBeNull()
    expect(synced?.mergeBaseSha).not.toBeNull()
    expect(synced?.baseSha).not.toBeNull()
    expect(synced?.lastSyncedAt).not.toBeNull()
  })

  test('creating the same (repo, baseRef, headRef) twice returns the existing review', () => {
    const first = createLocalReview({ baseRef: 'main', headRef: 'feature/duplicate' })
    const second = createLocalReview({ baseRef: 'main', headRef: 'feature/duplicate' })
    expect(second.id).toBe(first.id)

    // A bare branch name and its fully qualified spelling are the same ref, so
    // they must land on the same record rather than minting a sibling.
    const qualified = createLocalReview({
      baseRef: 'refs/heads/main',
      headRef: 'refs/heads/feature/duplicate',
    })
    expect(qualified.id).toBe(first.id)

    const matching = listLocalReviews().filter(
      (r) => r.headRef === 'refs/heads/feature/duplicate',
    )
    expect(matching).toHaveLength(1)
  })

  test('base == head and an option-shaped ref are rejected as unprocessable', () => {
    expect(thrownCode(() => createLocalReview({ baseRef: 'main', headRef: 'main' }))).toBe(
      'unprocessable',
    )
    // The two spellings of one ref are the same ref.
    expect(
      thrownCode(() => createLocalReview({ baseRef: 'refs/heads/main', headRef: 'main' })),
    ).toBe('unprocessable')
    // A name beginning with `-` reads as a git FLAG downstream — reject at the door.
    expect(
      thrownCode(() =>
        createLocalReview({ baseRef: '--upload-pack=/bin/sh', headRef: 'feature/x' }),
      ),
    ).toBe('unprocessable')
  })
})

describe('id minting', () => {
  test('every minted review id and entity id is a positive safe integer at or above its own band', () => {
    // A loop, not a sample: a counter that wraps, rebases, or drifts below its
    // band would pass any single-mint check.
    let previous = 0
    for (let i = 0; i < 500; i++) {
      const id = store.nextLocalReviewId()
      expect(Number.isSafeInteger(id)).toBe(true)
      expect(id).toBeGreaterThan(0)
      expect(id).toBeGreaterThanOrEqual(LOCAL_REVIEW_ID_BASE)
      expect(id).toBeGreaterThan(previous)
      previous = id
    }
    previous = 0
    for (let i = 0; i < 500; i++) {
      const id = store.nextLocalEntityId()
      expect(Number.isSafeInteger(id)).toBe(true)
      expect(id).toBeGreaterThan(0)
      expect(id).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)
      expect(id).toBeGreaterThan(previous)
      previous = id
    }
  })
})

describe('the synthesized snapshot', () => {
  test('a synthesized PullDetail satisfies vPullDetail unchanged', () => {
    const created = createLocalReview({ baseRef: 'main', headRef: 'feature/oracle' })
    const snap = syncLocalReview(created.id)

    const wire = JSON.parse(JSON.stringify(snap.mutable.pull)) as unknown
    // The validator reconstructs only declared keys and throws on any
    // mismatch, so "validates unchanged" is strict equality with its output.
    expect(vPullDetail(wire)).toStrictEqual(wire as ReturnType<typeof vPullDetail>)

    expect(snap.mutable.pull.number).toBe(created.id)
    expect(snap.mutable.pull.node_id).toBe(`local:${created.id}`)
    expect(snap.mutable.pull.state).toBe('open')
    expect(snap.prNumber).toBe(created.id)
    expect(snap.partial).toBeNull()
    // The snapshot is persisted under the local id like any other.
    expect(store.getSnapshot(created.id)?.immutable.compareKey).toBe(
      snap.immutable.compareKey,
    )
  })

  test('the sentinel user carries a display name and no email, ever', () => {
    for (const human of mockDev.listHumans()) {
      const user = synthesizeLocalUser(human.name)
      expect(JSON.stringify(user)).not.toContain('@')
      expect(user.login).toBe(human.name)
      expect(user.type).toBe('Bot')
      expect(user.avatar_url).toBe('')
      expect(user.html_url).toBe('')
    }
    const fromSnapshot = syncLocalReview(
      createLocalReview({ baseRef: 'main', headRef: 'feature/sentinel' }).id,
    ).mutable.pull.user
    expect(JSON.stringify(fromSnapshot)).not.toContain('@')
  })
})

describe('submit', () => {
  test('materializes verbatim threads with positive local ids, never stamps, and never touches mutable.reviews', () => {
    const humanId = mockDev.get().humanId
    const created = createLocalReview({ baseRef: 'main', headRef: 'feature/submit' })
    const snap = syncLocalReview(created.id)
    store.putDraft(draftFor(humanId, created.id, snap))

    // A stale head guard is a returned value, never a throw — and it leaves
    // the draft exactly where it was.
    const guard = submitLocalReview({
      prNumber: created.id,
      expectedHeadSha: 'not-the-current-head',
      event: 'COMMENT',
      body: 'x',
      comments: [],
    })
    expect(guard.status).toBe('head_moved')
    expect(store.getDraft(humanId, created.id)).not.toBeNull()

    const input: SubmitReviewInput = {
      prNumber: created.id,
      expectedHeadSha: snap.immutable.headSha,
      event: 'REQUEST_CHANGES',
      body: 'Overall: tighten the error handling before this merges.',
      comments: [
        pending('This guard clause reads inverted.', 12),
        pending('Name this constant after what it bounds.', 30),
      ],
    }
    const result = submitLocalReview(input)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    // The verdict stays meaningful locally — no self-review rule exists here.
    expect(result.review.state).toBe('CHANGES_REQUESTED')
    expect(Number.isSafeInteger(result.review.id)).toBe(true)
    expect(result.review.id).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)

    const after = store.getSnapshot(created.id)
    expect(after).not.toBeNull()
    if (!after) return

    // Submitted local reviews are read from the local record, and the
    // snapshot's reviews and issue comments stay empty forever.
    expect(after.mutable.reviews).toEqual([])
    expect(after.mutable.issueComments).toEqual([])
    expect(listLocalSubmittedReviews(created.id).map((r) => r.id)).toContain(result.review.id)

    // The threads materialized with positive entity-band comment ids, thread
    // ids in the local shape, verbatim bodies, and an email-free author.
    expect(after.mutable.threads).toHaveLength(2)
    for (const thread of after.mutable.threads) {
      expect(thread.comments).toHaveLength(1)
      const comment = thread.comments[0]
      expect(Number.isSafeInteger(comment.id)).toBe(true)
      expect(comment.id).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)
      expect(thread.id).toBe(localThreadId(created.id, comment.id))
      expect(thread.id.startsWith('local:')).toBe(true)
      expect(JSON.stringify(comment.user)).not.toContain('@')
      // Authorship is recorded as a key on the store side — never in the body.
      expect(after.mutable.commentAuthors?.[comment.id]).toBe(humanId)
    }
    const bodies = after.mutable.threads.map((t) => t.comments[0].body)
    expect(bodies).toContain('This guard clause reads inverted.')
    expect(bodies).toContain('Name this constant after what it bounds.')

    // No body anywhere on the local path carries the `**Name** (role)` stamp…
    const stamp = /\*\*[^*\n]+\*\* \([^)]+\)/
    for (const body of [result.review.body, ...bodies]) {
      expect(body).not.toMatch(stamp)
    }
    // …and the positive control: the SAME matcher does match real stamped
    // output, so a mistyped pattern cannot pass the absence checks vacuously.
    const human: Human = {
      id: 'h-control',
      name: 'Control Human',
      role: 'contractor',
      email: 'control@example.test',
    }
    expect(prefixBody(human, 'x')).toMatch(stamp)

    // Draft deletion is gated on confirmed submit success — and it happened.
    expect(store.getDraft(humanId, created.id)).toBeNull()

    // Nothing on the local path ever spends the shared GitHub rate bucket.
    expect(store.rateInfo().used).toBe(0)
  })
})

describe('deletion', () => {
  test('removes the record and its snapshot, keeps drafts, and never recycles the id', () => {
    const humanId = mockDev.get().humanId
    const created = createLocalReview({ baseRef: 'main', headRef: 'feature/doomed' })
    const snap = syncLocalReview(created.id)
    store.putDraft(draftFor(humanId, created.id, snap))

    deleteLocalReview(created.id)

    expect(getLocalReview(created.id)).toBeNull()
    expect(listLocalReviews().some((r) => r.id === created.id)).toBe(false)
    expect(store.getSnapshot(created.id)).toBeNull()
    // The draft is orphaned, never destroyed — deletion must not be the one
    // path that discards user-written text.
    expect(store.getDraft(humanId, created.id)).not.toBeNull()

    // Recreating the same branch pair mints a fresh id: the dead id's drafts,
    // viewed state, and client caches can never be inherited.
    const again = createLocalReview({ baseRef: 'main', headRef: 'feature/doomed' })
    expect(again.id).not.toBe(created.id)
    expect(again.id).toBeGreaterThan(created.id)

    // Deleting a review that does not exist is a typed not_found.
    expect(thrownCode(() => deleteLocalReview(created.id))).toBe('not_found')
  })
})
