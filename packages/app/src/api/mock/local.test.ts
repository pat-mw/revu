/**
 * Semantics of the local-review engine — reviews of a branch pair that has no
 * pull request and never touches GitHub.
 *
 * These tests pin the behaviors every other implementation must reproduce:
 * the synthesized wire shapes validate unchanged, the sentinel user never
 * carries an email, minted ids stay inside their reserved bands, comment
 * bodies are stored verbatim (no identity stamp — with a positive control so
 * a broken matcher cannot pass vacuously), submitted reviews never enter the
 * snapshot's `mutable.reviews`, creation is idempotent per branch pair, and a
 * delete is refused outright while any human's draft on the review holds text
 * — once it goes it takes the empty drafts and viewed marks with it, and never
 * recycles its id.
 *
 * Some of them pin behavior that reads like an accident and is not, so nothing
 * downstream "corrects" it into a divergence: the reaction rollup is shared
 * per review rather than per person, and a submit with no stored snapshot is
 * refused rather than accepted into threads no read could return — keyed on
 * the snapshot itself, not on `lastSyncedAt`, because the load path can admit
 * a record where the two disagree. Every refusal assertion carries a positive
 * control alongside it, so a rejection that fired for any reason at all could
 * not stand in for the specified one.
 *
 * The last two blocks leave the engine behind and drive the API surface
 * itself, because a correct engine reached through a wrong adapter is still a
 * broken contract: first the four local-review methods, then every method that
 * takes a review id, on a local id and on a GitHub one. The second of those
 * pairs is what keeps the dispatch honest — a bypass that quietly served local
 * behavior to real pull requests would satisfy every local assertion on its
 * own.
 *
 * The mock store is one process-wide document shared across every test file,
 * so the suite resets it before and after itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { BranchRef, CommitInfo, FileBlob, Human, LocalReviewSummary, PendingComment, PullListResponse, ReviewDraft, ReviewThread, Snapshot, SubmitReviewInput } from '@revu/shared'
import {
  ApiError,
  LOCAL_ENTITY_ID_BASE,
  LOCAL_REVIEW_ID_BASE,
  isLocalReviewId,
  isValidRefName,
  prefixBody,
  validateBranchRef,
  validateLocalReviewSummary,
  validatePullListResponse,
  vPullDetail,
} from '@revu/shared'
import { createMockApi } from './adapter'
import { mockDev } from './devtools'
import { ID_BASE, migrateStoreDocument, store } from './store'
import {
  addLocalReaction,
  createLocalReview,
  deleteLocalReview,
  getLocalReview,
  listLocalPullRows,
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

/** The ApiError a call throws, or null when it does not throw or throws something else. */
function thrownError(fn: () => unknown): ApiError | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof ApiError ? e : null
  }
}

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

/**
 * The current head tip of a review, read from its list row — the one source
 * that answers before a first sync, because rows read the ref tips as they are
 * now rather than off a snapshot.
 */
function liveHeadShaOf(review: LocalReviewSummary): string {
  const row = listLocalPullRows().find((r) => r.detail.number === review.id)
  if (!row) throw new Error(`local review ${review.id} has no pull row`)
  return row.detail.head.sha
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

  test('a submit before the first sync is refused, and the same submit succeeds after it', () => {
    // The refusal is a precondition on the review, not a bug to route around:
    // with no snapshot there is nowhere to publish the threads a submit
    // materializes, so accepting it would record a verdict and comments that
    // no snapshot-backed read can ever return. Syncing first is the fix, and
    // the message has to say so.
    const created = createLocalReview({ baseRef: 'main', headRef: 'feature/submit-unsynced' })
    expect(store.getSnapshot(created.id)).toBeNull()

    const input: SubmitReviewInput = {
      prNumber: created.id,
      // The head guard cannot be what fires: this is the live tip, exactly
      // what a synced submit would carry.
      expectedHeadSha: liveHeadShaOf(created),
      event: 'COMMENT',
      body: 'Submitted before this review was ever synced.',
      comments: [pending('An inline comment with no snapshot behind it.', 12)],
    }
    expect(thrownCode(() => submitLocalReview(input))).toBe('unprocessable')

    // Refused above any write: the record is exactly as it was created, with
    // nothing half-applied for a later sync to publish.
    const record = store.getLocalReview(created.id)
    expect(record?.submitted).toEqual([])
    expect(record?.threads).toEqual([])
    expect(listLocalSubmittedReviews(created.id)).toEqual([])

    // The positive control, without which a blanket throw in the engine would
    // satisfy every assertion above: the SAME submit goes through once the
    // review has been synced.
    syncLocalReview(created.id)
    const result = submitLocalReview(input)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(store.getSnapshot(created.id)?.mutable.threads).toHaveLength(1)
    expect(listLocalSubmittedReviews(created.id).map((r) => r.id)).toEqual([result.review.id])
  })

  test('the refusal keys on the missing snapshot itself, not on lastSyncedAt', () => {
    // Two candidate guard keys exist — "is a snapshot stored?" and "is
    // `lastSyncedAt` null?" — and every runtime path keeps them in agreement,
    // because a sync writes both and a delete drops both. The load path is
    // where they can split: a persisted document is admitted on its top-level
    // fields alone, never cross-checking that a record claiming a past sync
    // still has a snapshot beside it. On that split record the keys give
    // OPPOSITE answers — the snapshot key refuses, a `lastSyncedAt` key would
    // accept the submit into threads no snapshot-backed read could ever
    // return. This pins the fail-safe answer, so no other implementation can
    // pick the other key and still pass.
    const created = createLocalReview({ baseRef: 'main', headRef: 'feature/split-pair' })
    const record = store.getLocalReview(created.id)
    expect(record).not.toBeNull()
    if (!record) return

    // A persisted document holding the record with `lastSyncedAt` set and NO
    // snapshot entry survives the load path with the split intact — neither
    // repaired nor refused.
    const syncedAt = new Date().toISOString()
    const migrated = migrateStoreDocument({
      v: 4,
      dev: { humanId: mockDev.get().humanId, latency: 'zero', failureMode: 'none' },
      drafts: {},
      viewed: {},
      preferences: {},
      snapshots: {},
      blobs: {},
      remoteMut: {},
      syncAttempts: {},
      rate: { remaining: 5000, reset: new Date(Date.now() + 3_600_000).toISOString() },
      counter: 0,
      localReviews: { [created.id]: { ...record, lastSyncedAt: syncedAt } },
      localCounters: { review: 0, entity: 0 },
    })
    expect(migrated).not.toBeNull()
    if (!migrated) return
    expect(migrated.localReviews[created.id].lastSyncedAt).toBe(syncedAt)
    expect(migrated.snapshots[created.id]).toBeUndefined()

    // Install exactly the record the load path emitted. The review here was
    // never synced, so the live store holds no snapshot for its id either —
    // live state is now precisely the split document's.
    store.putLocalReview(migrated.localReviews[created.id])
    expect(store.getSnapshot(created.id)).toBeNull()
    expect(store.getLocalReview(created.id)?.lastSyncedAt).toBe(syncedAt)

    const input: SubmitReviewInput = {
      prNumber: created.id,
      // The live tip, so the head guard cannot be what fires.
      expectedHeadSha: liveHeadShaOf(created),
      event: 'COMMENT',
      body: 'Submitted against a record whose snapshot is missing.',
      comments: [pending('An inline comment with no snapshot behind it.', 7)],
    }
    expect(thrownCode(() => submitLocalReview(input))).toBe('unprocessable')

    // Refused above every write, exactly as on a never-synced review.
    const after = store.getLocalReview(created.id)
    expect(after?.submitted).toEqual([])
    expect(after?.threads).toEqual([])

    // The positive control: syncing stores the snapshot — the one thing the
    // submit was missing — and the SAME submit goes through.
    syncLocalReview(created.id)
    const healed = submitLocalReview(input)
    expect(healed.status).toBe('ok')
    if (healed.status !== 'ok') return
    expect(store.getSnapshot(created.id)?.mutable.threads).toHaveLength(1)
  })
})

describe('reactions', () => {
  test('the rollup is shared per review: a second human repeating an emoji gets it back unchanged', () => {
    // Pinned deliberately. Reactions are shared-and-honest everywhere in this
    // product — no surface models who reacted — so a repeat is a no-op that
    // answers with the current rollup rather than an error, and the second
    // human's optimistic bump settles back to the shared truth. Simulating
    // per-person reactions on this one path is explicitly not wanted; this
    // test is here so a later reader cannot mistake the no-op for a bug.
    const firstHumanId = mockDev.get().humanId
    const created = createLocalReview({ baseRef: 'main', headRef: 'feature/reactions' })
    const snap = syncLocalReview(created.id)
    const submitted = submitLocalReview({
      prNumber: created.id,
      expectedHeadSha: snap.immutable.headSha,
      event: 'COMMENT',
      body: 'A comment worth reacting to.',
      comments: [pending('Worth a second opinion.', 12)],
    })
    expect(submitted.status).toBe('ok')

    const commentId = store.getLocalReview(created.id)?.threads[0]?.comments[0]?.id
    expect(commentId).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)
    if (commentId === undefined) return

    const first = addLocalReaction(created.id, commentId, 'heart')
    expect(first.heart).toBe(1)
    expect(first.total_count).toBe(1)

    const second = mockDev.listHumans().find((h) => h.id !== firstHumanId)
    expect(second).toBeDefined()
    if (!second) return

    mockDev.setHuman(second.id)
    try {
      // The same emoji from a different human: no throw, and the rollup comes
      // back exactly as it was — one heart, not two.
      const repeat = addLocalReaction(created.id, commentId, 'heart')
      expect(repeat.heart).toBe(1)
      expect(repeat.total_count).toBe(1)

      // A DIFFERENT emoji from that same second human does register, so the
      // no-op above is the shared rollup answering — not a second reviewer
      // being unable to react at all.
      const other = addLocalReaction(created.id, commentId, 'rocket')
      expect(other.rocket).toBe(1)
      expect(other.heart).toBe(1)
      expect(other.total_count).toBe(2)
    } finally {
      mockDev.setHuman(firstHumanId)
    }

    // The stored comment carries that one shared rollup, with no per-human
    // state beside it for anything to read.
    const stored = store.getLocalReview(created.id)?.threads[0]?.comments[0]?.reactions
    expect(stored?.heart).toBe(1)
    expect(stored?.rocket).toBe(1)
    expect(stored?.total_count).toBe(2)
  })
})

describe('deletion', () => {
  test('is refused whole while a draft holds text, and removes everything once it is discarded', () => {
    const humanId = mockDev.get().humanId
    const created = createLocalReview({ baseRef: 'main', headRef: 'feature/doomed' })
    const snap = syncLocalReview(created.id)
    const draft = draftFor(humanId, created.id, snap)
    store.putDraft(draft)
    store.setViewed(humanId, created.id, {
      'src/index.ts': { viewed: true, blobSha: null, at: new Date().toISOString() },
    })

    // The positive control for every "still there" below: all four pieces
    // demonstrably exist before the refusal, and the draft demonstrably holds
    // text — an empty one would be let through.
    expect(getLocalReview(created.id)).not.toBeNull()
    expect(store.getSnapshot(created.id)).not.toBeNull()
    expect(store.getDraft(humanId, created.id)?.body).toBe(draft.body)
    expect(draft.body).not.toBe('')
    expect(Object.keys(store.getViewed(humanId, created.id))).toHaveLength(1)

    // Refused as `unprocessable`: the review exists, nothing moved under the
    // caller, and the caller can put it in a state that honors the identical
    // request — which is what the message has to tell them.
    const refused = thrownError(() => deleteLocalReview(created.id))
    expect(refused?.code).toBe('unprocessable')
    expect(refused?.message).toMatch(/discard/i)
    // A precondition, not a partial delete: the record, the snapshot, the
    // draft and the viewed marks are all exactly where they were.
    expect(getLocalReview(created.id)).not.toBeNull()
    expect(listLocalReviews().some((r) => r.id === created.id)).toBe(true)
    expect(store.getSnapshot(created.id)).not.toBeNull()
    expect(store.getDraft(humanId, created.id)).toStrictEqual(draft)
    expect(Object.keys(store.getViewed(humanId, created.id))).toHaveLength(1)

    // A draft whose body is empty but which carries a pending comment holds
    // text just the same: either half on its own is enough to refuse.
    store.putDraft({ ...draft, body: '', comments: [pending('An inline note.', 12)] })
    expect(thrownCode(() => deleteLocalReview(created.id))).toBe('unprocessable')

    // The remedy the message names, followed exactly: discard the draft, then
    // the identical delete succeeds. A message naming a remedy is a promise,
    // and this is the line that tests the promise.
    store.deleteDraft(humanId, created.id)
    deleteLocalReview(created.id)

    expect(getLocalReview(created.id)).toBeNull()
    expect(listLocalReviews().some((r) => r.id === created.id)).toBe(false)
    expect(store.getSnapshot(created.id)).toBeNull()
    // The viewed marks went WITH the review. This line once asserted the
    // opposite — that per-human state was orphaned rather than removed. The
    // rule moved deliberately: a draft holding text now blocks the delete
    // outright, so the only per-human rows a delete can ever take are ones
    // holding nothing, and taking them beats leaving unlistable rows behind
    // under an id nothing will mint again.
    expect(store.getViewed(humanId, created.id)).toEqual({})

    // Recreating the same branch pair mints a fresh id: the dead id's client
    // caches can never be inherited.
    const again = createLocalReview({ baseRef: 'main', headRef: 'feature/doomed' })
    expect(again.id).not.toBe(created.id)
    expect(again.id).toBeGreaterThan(created.id)

    // Deleting a review that no longer exists is the same typed not_found a
    // review that never existed gets.
    expect(thrownCode(() => deleteLocalReview(created.id))).toBe('not_found')
  })

  test('and the refusal it answers with names no review id', () => {
    // The sentence travels to a screen verbatim — only this side knows what is
    // in the way — and a local review's id is a synthetic key minted so routes
    // and cache keys can stay plain numbers. It names nothing a reader could
    // look up, so it must not reach one.
    //
    // The remedy the message names is the positive control, in this body: it
    // proves a real refusal sentence was read, rather than an absence
    // satisfied by an empty message or by no refusal at all.
    const humanId = mockDev.get().humanId
    const created = createLocalReview({ baseRef: 'main', headRef: 'feature/unnamed-refusal' })
    const snap = syncLocalReview(created.id)
    store.putDraft(draftFor(humanId, created.id, snap))

    const refused = thrownError(() => deleteLocalReview(created.id))
    expect(refused?.message).toMatch(/discard/i)
    expect(refused?.message ?? '').not.toContain(String(created.id))
  })

  test('an empty draft — the one an editor creates on open — never blocks, and goes with the review', () => {
    const humanId = mockDev.get().humanId
    const created = createLocalReview({ baseRef: 'main', headRef: 'feature/opened-only' })
    const snap = syncLocalReview(created.id)
    store.putDraft({ ...draftFor(humanId, created.id, snap), body: '', comments: [] })
    // The control: a draft row really is there to be refused on, so the
    // success below is the empty draft being let through and not a review
    // nobody had touched.
    expect(store.getDraft(humanId, created.id)).not.toBeNull()

    deleteLocalReview(created.id)

    expect(getLocalReview(created.id)).toBeNull()
    // Removed, not orphaned: an empty draft destroys no text, and a row left
    // under a dead id would be unlistable forever.
    expect(store.getDraft(humanId, created.id)).toBeNull()
  })

  test("another human's text blocks the delete exactly as the caller's own would", () => {
    const firstHumanId = mockDev.get().humanId
    const second = mockDev.listHumans().find((h) => h.id !== firstHumanId)
    expect(second).toBeDefined()
    if (!second) return
    const created = createLocalReview({ baseRef: 'main', headRef: 'feature/shared-pair' })
    const snap = syncLocalReview(created.id)
    store.putDraft(draftFor(second.id, created.id, snap))
    // The caller holds nothing on this review; only the other reviewer does.
    expect(store.getDraft(firstHumanId, created.id)).toBeNull()

    // The check spans every human's draft, because the delete would take
    // every human's draft.
    expect(thrownCode(() => deleteLocalReview(created.id))).toBe('unprocessable')
    expect(store.getDraft(second.id, created.id)).not.toBeNull()

    // The control that the refusal was theirs: once their draft is discarded
    // the same delete goes through.
    store.deleteDraft(second.id, created.id)
    deleteLocalReview(created.id)
    expect(getLocalReview(created.id)).toBeNull()
  })
})

describe('the four local-review methods on the API surface', () => {
  const api = createMockApi()

  /** The ApiError code a rejected call carries, or null when it resolves. */
  async function rejectedCode(p: Promise<unknown>): Promise<string | null> {
    try {
      await p
      return null
    } catch (e) {
      return e instanceof ApiError ? e.code : `not an ApiError: ${String(e)}`
    }
  }

  /** The ApiError a rejected call carries, or null when it resolves or rejects with something else. */
  async function rejectedError(p: Promise<unknown>): Promise<ApiError | null> {
    try {
      await p
      return null
    } catch (e) {
      return e instanceof ApiError ? e : null
    }
  }

  test('listBranches offers both kinds, fully qualified, with exactly one default', async () => {
    const branches = await api.listBranches()
    expect(branches.length).toBeGreaterThan(0)

    for (const branch of branches) {
      // The validator reconstructs only declared keys and throws on any
      // mismatch, so "validates unchanged" is strict equality with its output
      // over the serialized form the wire would actually carry.
      const wire = JSON.parse(JSON.stringify(branch)) as unknown
      expect(validateBranchRef(wire)).toStrictEqual(wire as BranchRef)
      // A ref that is not fully qualified is ambiguous, and one that fails the
      // syntactic check would be rejected by the creation call it feeds.
      expect(branch.ref.startsWith('refs/')).toBe(true)
      expect(isValidRefName(branch.ref)).toBe(true)
      expect(branch.name).not.toBe('')
    }

    // A picker needs both sides of the remote boundary: a base is often only
    // tracked, never checked out.
    expect(branches.some((b) => b.kind === 'local')).toBe(true)
    expect(branches.some((b) => b.kind === 'remote')).toBe(true)
    // Exactly one default — the base preselection is a single answer, so
    // neither zero nor two is a usable listing.
    const defaults = branches.filter((b) => b.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].kind).toBe('local')
    expect(defaults[0].ref).toBe('refs/heads/main')

    // Distinct refs, so no two entries of a picker collapse onto one choice.
    expect(new Set(branches.map((b) => b.ref)).size).toBe(branches.length)
  })

  test('a created review is listed with its local-only annotations and survives the wire', async () => {
    const created = await api.createLocalReview({
      baseRef: 'main',
      headRef: 'feature/adapter-surface',
      title: 'Adapter surface',
    })
    expect(isLocalReviewId(created.id)).toBe(true)
    expect(created.title).toBe('Adapter surface')

    const listed = await api.listLocalReviews()
    const found = listed.find((r) => r.id === created.id)
    expect(found).toBeDefined()
    if (!found) return
    expect(found).toStrictEqual(created)

    // `dirty` and `archivedPr` are the two annotations that exist only on a
    // local review, and they must be present as KEYS on the serialized form:
    // a key whose value went `undefined` disappears in serialization, so a
    // value check alone would pass on a summary that never carries them.
    const wire = JSON.parse(JSON.stringify(found)) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(wire, 'dirty')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(wire, 'archivedPr')).toBe(true)
    expect(wire.dirty).toBe(false)
    expect(wire.archivedPr).toBeNull()
    expect(validateLocalReviewSummary(wire)).toStrictEqual(
      wire as unknown as LocalReviewSummary,
    )

    // Creation is idempotent through the adapter exactly as it is in the
    // engine: the same branch pair answers with the review already there.
    const again = await api.createLocalReview({
      baseRef: 'main',
      headRef: 'feature/adapter-surface',
    })
    expect(again.id).toBe(created.id)
    expect((await api.listLocalReviews()).filter((r) => r.id === created.id)).toHaveLength(1)
  })

  test('deleteLocalReview refuses while the draft holds text, and the remedy it names removes the whole record', async () => {
    const humanId = mockDev.get().humanId
    const created = await api.createLocalReview({
      baseRef: 'main',
      headRef: 'feature/adapter-delete',
    })
    // Synthesizing the snapshot is engine work; the deletion boundary being
    // asserted is what the API surface does to it.
    const snap = syncLocalReview(created.id)
    const draft = await api.saveDraft(draftFor(humanId, created.id, snap))
    expect(draft.body).not.toBe('')
    expect((await api.listLocalReviews()).some((r) => r.id === created.id)).toBe(true)

    // Refused through the adapter with the same typed answer the engine
    // gives, and the review is still listed, still synced, and its draft
    // still readable: the refusal is a precondition, not a partial delete.
    const refused = await rejectedError(api.deleteLocalReview(created.id))
    expect(refused?.code).toBe('unprocessable')
    expect(refused?.message).toMatch(/discard/i)
    expect((await api.listLocalReviews()).some((r) => r.id === created.id)).toBe(true)
    expect(store.getSnapshot(created.id)).not.toBeNull()
    expect((await api.getDraft(created.id))?.body).toBe(draft.body)

    // The remedy the message names, followed through the surface a client
    // would use: discard, then the identical call succeeds.
    await api.discardDraft(created.id)
    await api.deleteLocalReview(created.id)

    // The settled boundary is the FULL record: the review is gone from the
    // listing and its cached snapshot is gone with it — not merely hidden.
    expect((await api.listLocalReviews()).some((r) => r.id === created.id)).toBe(false)
    expect(getLocalReview(created.id)).toBeNull()
    expect(store.getSnapshot(created.id)).toBeNull()
    // This line once asserted the draft was orphaned rather than destroyed.
    // The rule moved deliberately: text now blocks the delete outright, so
    // nothing holding text can reach this point, and what a delete does take
    // — the empty per-human rows — it removes rather than strands under an id
    // that is never minted again.
    expect(store.getDraft(humanId, created.id)).toBeNull()

    expect(await rejectedCode(api.deleteLocalReview(created.id))).toBe('not_found')
    // An invalid branch pair is a typed rejection through the adapter too,
    // rather than a resolved value the caller would treat as a created review.
    expect(
      await rejectedCode(api.createLocalReview({ baseRef: 'main', headRef: 'main' })),
    ).toBe('unprocessable')
  })

  test('a draft write aimed at a review that is gone is refused, not stranded', async () => {
    // The race a delete cannot outrun. The editing surface saves on a debounce
    // with one retry behind it, so a save in flight when the review goes lands
    // AFTER it — and a store that took it would hold a draft under an id that
    // is never minted again: unlistable, unreachable and undiscardable for as
    // long as the store survives.
    //
    // The same save before the delete is the positive control, in this body: it
    // proves the write is one this surface performs, so the refusal afterwards
    // is about the review's absence rather than about a draft verb that never
    // works on a local id.
    const humanId = mockDev.get().humanId
    const created = await api.createLocalReview({
      baseRef: 'main',
      headRef: 'feature/adapter-late-save',
    })
    const snap = syncLocalReview(created.id)
    const late = draftFor(humanId, created.id, snap)
    expect((await api.saveDraft({ ...late, body: '', comments: [] })).prNumber).toBe(created.id)

    await api.discardDraft(created.id)
    await api.deleteLocalReview(created.id)

    expect(await rejectedCode(api.saveDraft(late))).toBe('not_found')
  })

  test('and so is a read or a discard aimed at one', async () => {
    // The read answers `not_found` rather than `null`, because `null` is the
    // answer for a review that exists and has no draft — a different fact, and
    // one a client acts on differently. The discard answers the same way for
    // the same reason: deleting an absent DRAFT stays a no-op, but an absent
    // REVIEW is not a thing this surface serves at all.
    const created = await api.createLocalReview({
      baseRef: 'main',
      headRef: 'feature/adapter-late-read',
    })
    // The control: both verbs answer normally while the review is there.
    expect(await api.getDraft(created.id)).toBeNull()
    await api.discardDraft(created.id)

    await api.deleteLocalReview(created.id)

    expect(await rejectedCode(api.getDraft(created.id))).toBe('not_found')
    expect(await rejectedCode(api.discardDraft(created.id))).toBe('not_found')
  })

  test('no local-review call spends the shared rate bucket', async () => {
    // The whole point of the local path: nothing it does reaches GitHub, so
    // charging the bucket would make the rate estimate the UI renders a lie.
    await api.listBranches()
    const created = await api.createLocalReview({
      baseRef: 'main',
      headRef: 'feature/adapter-rate',
    })
    await api.listLocalReviews()
    await api.deleteLocalReview(created.id)
    expect(store.rateInfo().used).toBe(0)
  })
})

// ————————————————————————————————————————————————————————————————
// Everything below drives GitHub-shaped fixture pulls as well as local ids,
// so it deliberately runs LAST in this file: those calls spend the simulated
// rate bucket, and the assertions above are entitled to a bucket no local call
// has ever touched.
// ————————————————————————————————————————————————————————————————

/** The `**Name** (role)` identity stamp the GitHub path applies and the local path must not. */
const STAMP = /\*\*[^*\n]+\*\* \([^)]+\)/

/** The ApiError code a rejected call carries, or null when it resolves. */
async function apiErrorCode(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (e) {
    return e instanceof ApiError ? e.code : `not an ApiError: ${String(e)}`
  }
}

describe('every id-taking method serves a local review id', () => {
  const api = createMockApi()
  let localId = 0
  let headSha = ''
  let humanId = ''
  let humanName = ''

  beforeAll(async () => {
    // The simulated latency profile is not what is under test here, and the
    // default one budgets seconds for a single sync burst.
    mockDev.setLatency('zero')
    humanId = mockDev.get().humanId
    humanName = mockDev.listHumans().find((h) => h.id === humanId)?.name ?? ''
    localId = (
      await api.createLocalReview({ baseRef: 'main', headRef: 'feature/dispatch' })
    ).id
  })

  test('syncPull resolves a local snapshot instead of rejecting the id', async () => {
    const snap = await api.syncPull(localId)
    headSha = snap.immutable.headSha

    expect(snap.prNumber).toBe(localId)
    expect(snap.mutable.pull.number).toBe(localId)
    // Nothing was requested of anything: the sync read local refs.
    expect(snap.syncStats?.requests).toBe(0)
    // The cached read finds it under the same key every PR snapshot uses —
    // one snapshot keyspace, keyed by review id, with no local variant.
    expect((await api.getSnapshot(localId))?.immutable.compareKey).toBe(
      snap.immutable.compareKey,
    )
  })

  test('listPulls carries the local review as an ordinary row, exactly once', async () => {
    const list = await api.listPulls()
    const rows = list.items.filter((i) => i.pull.number === localId)

    // Exactly one: a review reaching the list by two mechanisms would render
    // as two rows for one review.
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(isLocalReviewId(row.pull.number)).toBe(true)
    expect(row.pull.title).toBe('feature/dispatch')
    expect(row.pull.state).toBe('open')
    expect(JSON.stringify(row.pull.user)).not.toContain('@')
    // No CI can have reported on a branch that was never pushed, and absent is
    // how the list spells "nothing reported" — never a synthesized pass.
    expect(row.broker.checks).toBeUndefined()
    // No GitHub self-review rule applies where no GitHub identity opened
    // anything, and no App-driving human authored a pull request here.
    expect(row.broker.canApprove).toBe(true)
    expect(row.broker.authorHumanId).toBeNull()
    expect(row.broker.assignedReviewerHumanIds).toEqual([])
    expect(row.broker.compareKey).toBe(`${headSha}...${headSha}`)

    // The row survives the transport that would carry it: the response
    // validator reconstructs only declared keys and throws on any mismatch.
    const wire = JSON.parse(JSON.stringify(list)) as unknown
    expect(validatePullListResponse(wire)).toStrictEqual(wire as PullListResponse)
  })

  test('the draft verbs serve a local id through the one per-human draft keyspace', async () => {
    const snap = (await api.getSnapshot(localId)) as Snapshot
    const saved = await api.saveDraft(draftFor(humanId, localId, snap))
    expect(saved.prNumber).toBe(localId)
    expect((await api.getDraft(localId))?.body).toBe(saved.body)
    // Drafts are keyed `(humanId, prNumber)` and a local id is just another
    // prNumber — the store holds this one under exactly that key, with no
    // parallel local keyspace beside it.
    expect(store.getDraft(humanId, localId)?.body).toBe(saved.body)

    // Which means isolation needs no new mechanism: another human reading the
    // same local id sees nothing.
    const other = mockDev.listHumans().find((h) => h.id !== humanId)
    expect(other).toBeDefined()
    if (!other) return
    mockDev.setHuman(other.id)
    expect(await api.getDraft(localId)).toBeNull()
    mockDev.setHuman(humanId)
    expect((await api.getDraft(localId))?.body).toBe(saved.body)

    await api.discardDraft(localId)
    expect(await api.getDraft(localId)).toBeNull()
  })

  test('submitReview materializes local threads, keeps mutable.reviews empty, and spends nothing', async () => {
    const snap = (await api.getSnapshot(localId)) as Snapshot
    await api.saveDraft(draftFor(humanId, localId, snap))
    const spentBefore = store.rateInfo().used

    const result = await api.submitReview({
      prNumber: localId,
      expectedHeadSha: headSha,
      event: 'REQUEST_CHANGES',
      body: 'Two things before this is ready.',
      comments: [pending('This guard clause reads inverted.', 12)],
    } satisfies SubmitReviewInput)

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.review.id).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)
    expect(result.review.state).toBe('CHANGES_REQUESTED')
    // Verbatim: the stamp exists only because many humans share one GitHub
    // bot, and locally the store records the author instead.
    expect(result.review.body).toBe('Two things before this is ready.')
    expect(result.review.body).not.toMatch(STAMP)
    expect(JSON.stringify(result.review.user)).not.toContain('@')

    const threads = await api.listReviewThreads(localId)
    expect(threads).toHaveLength(1)
    expect(threads[0].comments[0].body).toBe('This guard clause reads inverted.')
    expect(threads[0].comments[0].body).not.toMatch(STAMP)
    // …and the positive control for both absence assertions: the same matcher
    // does match genuinely stamped output.
    const control: Human = {
      id: 'h-control',
      name: 'Control Human',
      role: 'contractor',
      email: 'control@example.test',
    }
    expect(prefixBody(control, 'x')).toMatch(STAMP)

    // The submitted verdict never enters the snapshot: that array stays empty
    // for the life of a local review, which is what keeps its conversation
    // surface threads-only.
    const after = await api.getSnapshot(localId)
    expect(after?.mutable.reviews).toEqual([])
    expect(after?.mutable.issueComments).toEqual([])

    expect(await api.getDraft(localId)).toBeNull()
    expect(store.rateInfo().used).toBe(spentBefore)
  })

  test('replyToThread appends a verbatim local comment to the thread', async () => {
    const [thread] = await api.listReviewThreads(localId)
    const root = thread.comments[0]
    const spentBefore = store.rateInfo().used

    const reply = await api.replyToThread(localId, thread.id, 'Reworded — take another look.')

    expect(reply.body).toBe('Reworded — take another look.')
    expect(reply.body).not.toMatch(STAMP)
    expect(reply.id).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)
    expect(reply.in_reply_to_id).toBe(root.id)
    expect(reply.path).toBe(thread.path)
    expect(JSON.stringify(reply.user)).not.toContain('@')

    const reread = (await api.listReviewThreads(localId)).find((t) => t.id === thread.id)
    expect(reread?.comments).toHaveLength(2)
    expect(reread?.comments[1].id).toBe(reply.id)
    // Authorship is a stored key, never body text.
    const snap = await api.getSnapshot(localId)
    expect(snap?.mutable.commentAuthors?.[reply.id]).toBe(humanId)
    expect(store.rateInfo().used).toBe(spentBefore)
  })

  test('resolveThread flips both ways and returns the whole normalized thread', async () => {
    const [thread] = await api.listReviewThreads(localId)
    const spentBefore = store.rateInfo().used

    const resolved = await api.resolveThread(localId, thread.id, true)
    expect(resolved.id).toBe(thread.id)
    expect(resolved.isResolved).toBe(true)
    // Attributed to the one local reviewer by display name — never an email,
    // and never an empty login.
    expect(resolved.resolvedBy?.login).toBe(humanName)
    expect(JSON.stringify(resolved.resolvedBy)).not.toContain('@')
    expect(
      (await api.listReviewThreads(localId)).find((t) => t.id === thread.id)?.isResolved,
    ).toBe(true)

    const reopened = await api.resolveThread(localId, thread.id, false)
    expect(reopened.isResolved).toBe(false)
    expect(reopened.resolvedBy).toBeNull()
    expect(store.rateInfo().used).toBe(spentBefore)
  })

  test('addReaction bumps a local rollup that names no github.com resource', async () => {
    const [thread] = await api.listReviewThreads(localId)
    const commentId = thread.comments[0].id
    const spentBefore = store.rateInfo().used

    const rollup = await api.addReaction(localId, commentId, 'heart')
    expect(rollup.heart).toBe(1)
    expect(rollup.total_count).toBe(1)
    expect(rollup.url).toBe('')

    const snap = await api.getSnapshot(localId)
    const cached = snap?.mutable.threads
      .flatMap((t) => t.comments)
      .find((c) => c.id === commentId)
    expect(cached?.reactions.heart).toBe(1)
    expect(store.rateInfo().used).toBe(spentBefore)
  })

  test('reconcileDraft classifies a local draft against the local snapshot', async () => {
    const snap = (await api.getSnapshot(localId)) as Snapshot
    await api.saveDraft({
      ...draftFor(humanId, localId, snap),
      comments: [pending('Still pending after the branch moved.', 12)],
    })

    const report = await api.reconcileDraft(localId)
    expect(report.prNumber).toBe(localId)
    expect(report.currentHeadSha).toBe(headSha)
    expect(report.draftHeadSha).toBe(headSha)
    expect(report.results).toHaveLength(1)

    await api.discardDraft(localId)
  })

  test('a rebase reports every commit as new, because the draft head is gone', async () => {
    // The case an author-date comparison cannot answer. A rebase rewrites
    // committer dates and PRESERVES author dates, so every rewritten commit
    // keeps a date older than the draft — and a filter for "authored after the
    // draft" therefore returns NOTHING, on precisely the rewrite that changed
    // the most. When the draft's head is absent from the compare entirely there
    // is no commit to slice after, so every commit in the range is new relative
    // to a head that no longer exists.
    const snap = (await api.getSnapshot(localId)) as Snapshot
    await api.saveDraft({
      ...draftFor(humanId, localId, snap),
      comments: [pending('Written before the rebase.', 12)],
    })
    const draft = (await api.getDraft(localId)) as ReviewDraft

    const rewritten: CommitInfo[] = ['X0', 'X1', 'X2'].map((sha, i) => ({
      sha,
      commit: {
        message: `rewritten ${sha}`,
        // Authored long before the draft was written, which is exactly what a
        // rebase preserves and what makes the old heuristic report zero.
        author: {
          name: 'Rebase Author',
          email: 'rebase@revu.invalid',
          date: `2020-01-0${i + 1}T00:00:00Z`,
        },
      },
      author: null,
      parents: [],
    }))
    store.putSnapshot({
      ...snap,
      immutable: { ...snap.immutable, commits: rewritten },
    })

    const report = await api.reconcileDraft(localId)
    expect(report.newCommits.map((c) => c.sha)).toEqual(['X0', 'X1', 'X2'])

    // The old heuristic, computed here and asserted to be strictly worse. This
    // one line is the regression guard: restoring the author-date fallback
    // makes it red, whereas the count assertion above could be satisfied by
    // changing the fixture.
    const byAuthorDate = rewritten.filter((c) => c.commit.author.date > draft.createdAt)
    expect(byAuthorDate.length).toBeLessThan(report.newCommits.length)

    store.putSnapshot(snap)
    await api.discardDraft(localId)
  })

  test('the viewed-state verbs key a local id like any other review', async () => {
    const state = await api.setFileViewed(localId, 'src/index.ts', true, 'blob-sha-local')
    expect(state['src/index.ts'].viewed).toBe(true)
    expect((await api.getFileViewed(localId))['src/index.ts'].viewed).toBe(true)
    expect(store.getViewed(humanId, localId)['src/index.ts'].viewed).toBe(true)
  })

  test('getBlob takes no review id, so one content-addressed store serves both paths', async () => {
    const blob: FileBlob = {
      sha: 'localdispatchblob0000000000000000000000',
      path: 'src/index.ts',
      content: 'const x = compute()\n',
      size: 20,
      binary: false,
    }
    store.putBlobs([blob])
    expect(await api.getBlob(blob.sha)).toEqual(blob)
    expect(await apiErrorCode(api.getBlob('sha-that-was-never-fetched'))).toBe('not_found')
  })

  test('an unknown local id is a typed not_found from the local engine, not a silent empty', async () => {
    const ghost = LOCAL_REVIEW_ID_BASE + 987_654
    expect(isLocalReviewId(ghost)).toBe(true)
    expect(await apiErrorCode(api.syncPull(ghost))).toBe('not_found')
    expect(await apiErrorCode(api.deleteLocalReview(ghost))).toBe('not_found')
    expect(await apiErrorCode(api.replyToThread(ghost, 'local:1:1', 'x'))).toBe('not_found')
    expect(await apiErrorCode(api.resolveThread(ghost, 'local:1:1', true))).toBe('not_found')
    expect(await apiErrorCode(api.addReaction(ghost, 1, 'heart'))).toBe('not_found')
    expect(
      await apiErrorCode(
        api.submitReview({
          prNumber: ghost,
          expectedHeadSha: headSha,
          event: 'COMMENT',
          body: 'x',
          comments: [],
        }),
      ),
    ).toBe('not_found')
  })

  test('submitting before the first sync is refused, and the same submit lands after it', async () => {
    // Reached through the API surface rather than the engine, because the
    // refusal has to survive the adapter: a submit on a never-synced review
    // would otherwise resolve `ok` while the threads it materialized stayed
    // unreadable, leaving a list row counting unresolved threads that nothing
    // could open. The refusal is the specified behavior, so a later reader
    // does not "repair" it back into a success.
    const fresh = await api.createLocalReview({
      baseRef: 'main',
      headRef: 'feature/submit-before-sync',
    })
    expect(await api.getSnapshot(fresh.id)).toBeNull()

    // The head sha a caller can name without syncing: list rows read the ref
    // tips as they are now, so the head guard is satisfied and the refusal is
    // the only thing that can fire.
    const row = (await api.listPulls()).items.find((i) => i.pull.number === fresh.id)
    expect(row).toBeDefined()
    if (!row) return

    const input: SubmitReviewInput = {
      prNumber: fresh.id,
      expectedHeadSha: row.pull.head.sha,
      event: 'COMMENT',
      body: 'Submitted before this review was ever synced.',
      comments: [pending('An inline comment with no snapshot behind it.', 12)],
    }
    expect(await apiErrorCode(api.submitReview(input))).toBe('unprocessable')

    // Nothing was written on the way to the refusal: no snapshot appeared, no
    // verdict was recorded, and the list row counts no thread nobody can open.
    expect(await api.getSnapshot(fresh.id)).toBeNull()
    expect(await api.listReviewThreads(fresh.id)).toEqual([])
    expect(listLocalSubmittedReviews(fresh.id)).toEqual([])
    const rowAfter = (await api.listPulls()).items.find((i) => i.pull.number === fresh.id)
    expect(rowAfter?.broker.unresolvedThreads).toBe(0)

    // The positive control: the refusal is a precondition, not a blanket
    // rejection — the identical submit succeeds once the review is synced,
    // and everything it materializes is immediately readable.
    await api.syncPull(fresh.id)
    const result = await api.submitReview(input)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.review.id).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)

    const threads = await api.listReviewThreads(fresh.id)
    expect(threads).toHaveLength(1)
    expect(threads[0].comments[0].body).toBe('An inline comment with no snapshot behind it.')
    expect(listLocalSubmittedReviews(fresh.id).map((r) => r.id)).toEqual([result.review.id])
    // The verdict stays on the record, as on every local review.
    expect((await api.getSnapshot(fresh.id))?.mutable.reviews).toEqual([])
  })
})

describe('a non-local id still takes the GitHub-shaped path, unchanged', () => {
  // Without this block a dispatch that degenerated into a blanket bypass —
  // serving local behavior to real pull requests — would satisfy every
  // assertion above. Each case names something only the GitHub path does.
  const api = createMockApi()
  const remotePr = 347
  let brokerLogin = ''
  let remoteThread: ReviewThread

  beforeAll(async () => {
    mockDev.setLatency('zero')
    brokerLogin = (await api.getSession()).brokerLogin
  })

  test('syncPull on a fixture pull still fetches a real compare and spends the bucket', async () => {
    const spentBefore = store.rateInfo().used
    const snap = await api.syncPull(remotePr)

    expect(snap.prNumber).toBe(remotePr)
    expect(snap.immutable.files.length).toBeGreaterThan(0)
    expect(snap.immutable.commits.length).toBeGreaterThan(0)
    expect(snap.syncStats?.requests).toBeGreaterThan(0)
    expect(store.rateInfo().used).toBeGreaterThan(spentBefore)
  })

  test('replyToThread on a fixture pull still stamps the body and posts as the shared bot', async () => {
    const threads = await api.listReviewThreads(remotePr)
    const target = threads.find((t) => !t.isResolved)
    expect(target).toBeDefined()
    if (!target) return
    remoteThread = target
    const spentBefore = store.rateInfo().used

    const reply = await api.replyToThread(remotePr, target.id, 'Pushed a fix.')

    // The stamp is the sharpest possible proof the GitHub path ran: it is the
    // one thing the local path is forbidden to do.
    expect(reply.body).toMatch(STAMP)
    expect(reply.body).not.toBe('Pushed a fix.')
    expect(reply.user.login).toBe(brokerLogin)
    // A GitHub-path id comes from the mock's own band, never a local one.
    expect(reply.id).toBeGreaterThanOrEqual(ID_BASE)
    expect(reply.id).toBeLessThan(LOCAL_REVIEW_ID_BASE)
    expect(reply.html_url).toContain('github.com')
    expect(store.rateInfo().used).toBeGreaterThan(spentBefore)
  })

  test('resolveThread on a fixture pull still attributes to the bot login', async () => {
    const resolved = await api.resolveThread(remotePr, remoteThread.id, true)
    expect(resolved.isResolved).toBe(true)
    expect(resolved.resolvedBy?.login).toBe(brokerLogin)
    await api.resolveThread(remotePr, remoteThread.id, false)
  })

  test('addReaction on a fixture comment still returns the GitHub-shaped rollup', async () => {
    const commentId = remoteThread.comments[0].id
    const spentBefore = store.rateInfo().used

    const rollup = await api.addReaction(remotePr, commentId, 'rocket')
    // The fixture rollups name a real github.com resource; local ones cannot.
    expect(rollup.url).toContain('github.com')
    expect(store.rateInfo().used).toBeGreaterThan(spentBefore)
  })

  test('submitReview on a fixture pull still stamps AND appends to mutable.reviews', async () => {
    const snap = (await api.getSnapshot(remotePr)) as Snapshot
    const reviewsBefore = snap.mutable.reviews.length
    const spentBefore = store.rateInfo().used

    const result = await api.submitReview({
      prNumber: remotePr,
      expectedHeadSha: snap.immutable.headSha,
      event: 'COMMENT',
      body: 'First pass done.',
      comments: [],
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.review.body).toMatch(STAMP)
    expect(result.review.user.login).toBe(brokerLogin)
    expect(result.review.id).toBeGreaterThanOrEqual(ID_BASE)
    expect(result.review.id).toBeLessThan(LOCAL_REVIEW_ID_BASE)

    // The divergence that makes the two paths distinguishable at the store:
    // a GitHub submit lands in the snapshot's reviews, a local one never does.
    const after = (await api.getSnapshot(remotePr)) as Snapshot
    expect(after.mutable.reviews).toHaveLength(reviewsBefore + 1)
    expect(store.rateInfo().used).toBeGreaterThan(spentBefore)
  })

  test('listPulls still carries every fixture pull, from the fixture source', async () => {
    const list = await api.listPulls()
    const remoteNumbers = list.items
      .map((i) => i.pull.number)
      .filter((n) => !isLocalReviewId(n))
      .sort((a, b) => a - b)
    expect(remoteNumbers).toEqual([101, 204, 312, 347, 355, 362, 389, 401, 410, 415])
  })

  test('an id below the local band that no fixture claims is still not_found', async () => {
    const ghost = 999_999
    expect(isLocalReviewId(ghost)).toBe(false)
    expect(await apiErrorCode(api.syncPull(ghost))).toBe('not_found')
    expect(await apiErrorCode(api.replyToThread(ghost, 'PRRT_x', 'x'))).toBe('not_found')
    expect(await apiErrorCode(api.resolveThread(ghost, 'PRRT_x', true))).toBe('not_found')
    expect(await apiErrorCode(api.addReaction(ghost, 1, 'heart'))).toBe('not_found')
    expect(
      await apiErrorCode(
        api.submitReview({
          prNumber: ghost,
          expectedHeadSha: 'x',
          event: 'COMMENT',
          body: 'x',
          comments: [],
        }),
      ),
    ).toBe('not_found')
  })
})
