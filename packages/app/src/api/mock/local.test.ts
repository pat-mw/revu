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
import type { BranchRef, FileBlob, Human, LocalReviewSummary, PendingComment, PullListResponse, ReviewDraft, ReviewThread, Snapshot, SubmitReviewInput } from '@revu/shared'
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
import { ID_BASE, store } from './store'
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

  test('deleteLocalReview removes the whole record and answers not_found for an unknown id', async () => {
    const humanId = mockDev.get().humanId
    const created = await api.createLocalReview({
      baseRef: 'main',
      headRef: 'feature/adapter-delete',
    })
    // Synthesizing the snapshot is engine work; the deletion boundary being
    // asserted is what the API surface does to it.
    const snap = syncLocalReview(created.id)
    store.putDraft(draftFor(humanId, created.id, snap))
    expect((await api.listLocalReviews()).some((r) => r.id === created.id)).toBe(true)

    await api.deleteLocalReview(created.id)

    // The settled boundary is the FULL record: the review is gone from the
    // listing and its cached snapshot is gone with it — not merely hidden.
    expect((await api.listLocalReviews()).some((r) => r.id === created.id)).toBe(false)
    expect(getLocalReview(created.id)).toBeNull()
    expect(store.getSnapshot(created.id)).toBeNull()
    // The other half of that boundary: per-human text is orphaned, never
    // destroyed, and the id is never minted again so nothing inherits it.
    expect(store.getDraft(humanId, created.id)).not.toBeNull()

    expect(await rejectedCode(api.deleteLocalReview(created.id))).toBe('not_found')
    // An invalid branch pair is a typed rejection through the adapter too,
    // rather than a resolved value the caller would treat as a created review.
    expect(
      await rejectedCode(api.createLocalReview({ baseRef: 'main', headRef: 'main' })),
    ).toBe('unprocessable')
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
