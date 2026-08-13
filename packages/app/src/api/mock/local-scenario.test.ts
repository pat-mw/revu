/**
 * The whole review loop driven through the public API against one local review
 * id — create → sync → draft an inline comment → submit → reply → resolve —
 * with the three frozen transport semantics asserted on that id specifically.
 *
 * The mock's behavior IS the contract every other transport reproduces, so
 * these three are pinned here on the local path rather than inferred from the
 * GitHub-shaped one:
 *
 * 1. `submitReview` against a stale `expectedHeadSha` answers `head_moved` as a
 *    RESOLVED value and never throws — a moved head routes the reviewer through
 *    reconcile, it is not an error, and the draft survives it untouched.
 * 2. `getSnapshot` on a created-but-never-synced review resolves `null`, never a
 *    thrown `not_found` — "nothing cached yet" is an ordinary answer.
 * 3. A synced snapshot carries `partial` as a PRESENT own key valued `null` —
 *    never omitted, never `undefined` — so the wire validator still accepts it.
 *    The key half is what matters: a key whose value went `undefined` vanishes
 *    in serialization, so a `=== null` check alone would pass on a snapshot
 *    that never carries the key at all. Both halves are asserted, on the
 *    freshly synced value AND on the cached copy every later read comes off.
 *
 * The whole walk runs with `globalThis.fetch` replaced by a throwing tripwire,
 * restored afterwards: a local review is served entirely from this workspace,
 * so one network call anywhere on the path is a defect. The tripwire carries a
 * positive control, because "nothing called the stub" is worthless evidence
 * when the stub was never installed — an unarmed tripwire and a clean walk look
 * identical from the assertion's side.
 *
 * The absence assertions are backed the same way: a settle helper that could
 * never report a rejection would make semantics 1 and 2 vacuous, and a
 * present-key check that accepts an absent key would make semantic 3 vacuous,
 * so each is exercised against a deliberately broken subject in-file.
 *
 * The mock store is one process-wide document shared across every test file, so
 * this suite resets it before and after itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PendingComment, ReviewDraft, Snapshot } from '@revu/shared'
import { ApiError, ValidationError, isLocalReviewId, validateSnapshot } from '@revu/shared'
import { createMockApi } from './adapter'
import { mockDev } from './devtools'

// ————————————————————————————————————————————————————————————————
// The network tripwire
// ————————————————————————————————————————————————————————————————

const realFetch = globalThis.fetch

/** Every URL the walk attempted to reach. Any entry at all is a failure. */
const attemptedRequests: string[] = []

/**
 * Replace `fetch` with a stub that records the attempt and throws
 * SYNCHRONOUSLY — a rejected promise could be swallowed by a caller's own
 * error handling and surface as a plausible-looking empty result, whereas a
 * synchronous throw propagates out of whatever called it.
 */
function armFetchTripwire(): void {
  globalThis.fetch = ((input: string | URL | Request): never => {
    attemptedRequests.push(String(input))
    throw new Error(
      `a local review reached the network: ${String(input)} — nothing on this path may leave the workspace`,
    )
  }) as unknown as typeof fetch
}

// ————————————————————————————————————————————————————————————————
// Resolved-vs-thrown, made explicit
// ————————————————————————————————————————————————————————————————

type Settled<T> = { threw: false; value: T } | { threw: true; error: unknown }

/**
 * Await a call without letting a rejection abort the test, so "resolved rather
 * than thrown" becomes an assertion on an observed outcome instead of the
 * absence of a crash.
 */
async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { threw: false, value: await promise }
  } catch (error) {
    return { threw: true, error }
  }
}

/** `'resolved'`, or a description of the throw — so a failure names its cause. */
function outcomeOf(settled: Settled<unknown>): string {
  if (!settled.threw) return 'resolved'
  const { error } = settled
  return error instanceof ApiError
    ? `threw ApiError(${error.code}): ${error.message}`
    : `threw ${String(error)}`
}

function hasOwn(value: unknown, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

// ————————————————————————————————————————————————————————————————
// Walk inputs
// ————————————————————————————————————————————————————————————————

const HEAD_REF = 'feature/local-scenario-walk'
const DRAFT_BODY = 'One blocking question and a naming nit.'
const COMMENT_BODY = 'This guard clause reads inverted — the early return is the happy path.'
const REPLY_BODY = 'Rewrote it the other way round; take another look.'

/** A SHA no ref in this workspace can be at, so the head guard must fire. */
const STALE_HEAD_SHA = '0'.repeat(40)

function pending(): PendingComment {
  const at = new Date().toISOString()
  return {
    key: 'local-scenario-walk-1',
    path: 'src/index.ts',
    side: 'RIGHT',
    start_side: null,
    line: 12,
    start_line: null,
    body: COMMENT_BODY,
    createdAt: at,
    updatedAt: at,
    anchor: { lineText: 'const x = compute()', contextBefore: [], contextAfter: [] },
  }
}

const api = createMockApi()

beforeAll(() => {
  // Armed before the store is touched: the reset and the fixture seed are part
  // of the walk's no-network claim, not a preamble exempt from it.
  armFetchTripwire()
  mockDev.reset()
  // The simulated latency profile is not what is under test, and the default
  // budgets seconds for a single sync burst.
  mockDev.setLatency('zero')
})

afterAll(() => {
  globalThis.fetch = realFetch
  mockDev.reset()
})

describe('the local review walk', () => {
  let localId = 0
  let humanId = ''
  let headSha = ''
  let threadId = ''

  test('create mints a review id in the local band, with nothing synced yet', async () => {
    humanId = mockDev.get().humanId
    const created = await api.createLocalReview({
      baseRef: 'main',
      headRef: HEAD_REF,
      title: 'Local scenario walk',
    })
    localId = created.id

    expect(isLocalReviewId(localId)).toBe(true)
    expect(created.headRef).toBe(`refs/heads/${HEAD_REF}`)
    expect(created.lastSyncedAt).toBeNull()
    expect(created.headSha).toBeNull()
  })

  test('getSnapshot before the first sync RESOLVES null — it is not a thrown not_found', async () => {
    const settled = await settle(api.getSnapshot(localId))

    // Asserted as an observed outcome so a regression to a typed rejection
    // names itself in the diff rather than reading as an unrelated crash.
    expect(outcomeOf(settled)).toBe('resolved')
    if (settled.threw) return
    expect(settled.value).toBeNull()
  })

  test('sync resolves a snapshot whose `partial` is a present key valued null', async () => {
    const snap = await api.syncPull(localId)
    headSha = snap.immutable.headSha

    expect(snap.prNumber).toBe(localId)
    expect(hasOwn(snap, 'partial')).toBe(true)
    expect(snap.partial).toBeNull()

    // The round trip that actually matters: an `undefined` value disappears
    // from the serialized form, and the validator's shape declares `partial`
    // required, so a missing key fails here rather than silently on the wire.
    const wire = JSON.parse(JSON.stringify(snap)) as unknown
    expect(hasOwn(wire, 'partial')).toBe(true)
    expect(validateSnapshot(wire)).toStrictEqual(wire as Snapshot)

    // The same two properties on the CACHED copy, which is what every later
    // read is served from — the snapshot crossed a persistence boundary since
    // the value above was built.
    const cached = await api.getSnapshot(localId)
    expect(cached).not.toBeNull()
    if (!cached) return
    expect(hasOwn(cached, 'partial')).toBe(true)
    expect(cached.partial).toBeNull()
    const cachedWire = JSON.parse(JSON.stringify(cached)) as unknown
    expect(hasOwn(cachedWire, 'partial')).toBe(true)
    expect(validateSnapshot(cachedWire)).toStrictEqual(cachedWire as Snapshot)
  })

  test('a draft with one inline comment saves under the local id', async () => {
    const snap = (await api.getSnapshot(localId)) as Snapshot
    const at = new Date().toISOString()
    const draft: ReviewDraft = {
      humanId,
      prNumber: localId,
      headSha: snap.immutable.headSha,
      compareKey: snap.immutable.compareKey,
      body: DRAFT_BODY,
      event: 'COMMENT',
      comments: [pending()],
      createdAt: at,
      updatedAt: at,
    }

    const saved = await api.saveDraft(draft)
    expect(saved.prNumber).toBe(localId)

    const reread = await api.getDraft(localId)
    expect(reread?.body).toBe(DRAFT_BODY)
    expect(reread?.comments).toHaveLength(1)
    expect(reread?.comments[0].body).toBe(COMMENT_BODY)
  })

  test('submitReview with a stale expectedHeadSha RESOLVES head_moved, and keeps the draft', async () => {
    expect(STALE_HEAD_SHA).not.toBe(headSha)

    const settled = await settle(
      api.submitReview({
        prNumber: localId,
        expectedHeadSha: STALE_HEAD_SHA,
        event: 'COMMENT',
        body: DRAFT_BODY,
        comments: [pending()],
      }),
    )

    // A moved head is a 200-level answer the UI routes through reconcile. Any
    // throw at all fails here, whatever its code.
    expect(outcomeOf(settled)).toBe('resolved')
    if (settled.threw) return
    const result = settled.value
    expect(result.status).toBe('head_moved')
    if (result.status !== 'head_moved') return
    expect(result.currentHeadSha).toBe(headSha)
    expect(Number.isInteger(result.newCommits)).toBe(true)

    // The other half of the guard: the reviewer's text is exactly where it was.
    const draft = await api.getDraft(localId)
    expect(draft?.body).toBe(DRAFT_BODY)
    expect(draft?.comments).toHaveLength(1)
  })

  test('submit materializes the inline comment as a thread and clears the draft', async () => {
    const draft = await api.getDraft(localId)
    expect(draft).not.toBeNull()
    if (!draft) return

    const result = await api.submitReview({
      prNumber: localId,
      expectedHeadSha: headSha,
      event: 'COMMENT',
      body: draft.body,
      comments: draft.comments,
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.review.state).toBe('COMMENTED')
    expect(result.review.body).toBe(DRAFT_BODY)

    const threads = await api.listReviewThreads(localId)
    expect(threads).toHaveLength(1)
    threadId = threads[0].id
    expect(threads[0].comments).toHaveLength(1)
    expect(threads[0].comments[0].body).toBe(COMMENT_BODY)
    expect(threads[0].isResolved).toBe(false)

    // Deletion is gated on a confirmed submit, and this one was confirmed.
    expect(await api.getDraft(localId)).toBeNull()
  })

  test('reply appends to the materialized thread', async () => {
    const before = (await api.listReviewThreads(localId)).find((t) => t.id === threadId)
    const root = before?.comments[0]
    expect(root).toBeDefined()
    if (!root) return

    const reply = await api.replyToThread(localId, threadId, REPLY_BODY)
    expect(reply.body).toBe(REPLY_BODY)
    expect(reply.in_reply_to_id).toBe(root.id)

    const after = (await api.listReviewThreads(localId)).find((t) => t.id === threadId)
    expect(after?.comments).toHaveLength(2)
    expect(after?.comments[1].id).toBe(reply.id)
  })

  test('resolve closes the thread, and the cached read agrees', async () => {
    const resolved = await api.resolveThread(localId, threadId, true)
    expect(resolved.id).toBe(threadId)
    expect(resolved.isResolved).toBe(true)

    const reread = (await api.listReviewThreads(localId)).find((t) => t.id === threadId)
    expect(reread?.isResolved).toBe(true)

    // The walk closes where a review does: a resolved thread on a snapshot the
    // whole loop produced without a pull request existing anywhere.
    const snap = await api.getSnapshot(localId)
    expect(snap?.mutable.threads).toHaveLength(1)
    expect(snap?.mutable.threads[0].isResolved).toBe(true)
  })
})

describe('the controls that keep the absence assertions honest', () => {
  test('the walk attempted no network call — and the tripwire it relies on really throws', () => {
    // Order matters: the walk's evidence is read BEFORE the control fires, so
    // the control's own call cannot be mistaken for a call the walk made.
    expect(attemptedRequests).toEqual([])

    const probe ='https://api.github.com/repos/meridian-labs/atlas/pulls'
    expect(() => globalThis.fetch(probe)).toThrow(/reached the network/)
    // The stub is installed and reachable, so the empty list above is evidence
    // of a walk that stayed local rather than of a tripwire nobody armed.
    expect(attemptedRequests).toEqual([probe])
  })

  test('the settle helper reports a rejection rather than swallowing it', async () => {
    // Without this, `outcomeOf(settled)` could be permanently `'resolved'` and
    // both "never throws" assertions would hold no matter what the API did.
    const settled = await settle(
      Promise.reject(new ApiError('not_found', 'nothing here')),
    )
    expect(settled.threw).toBe(true)
    expect(outcomeOf(settled)).toBe('threw ApiError(not_found): nothing here')
  })

  test('an absent `partial` key fails the present-key check and the validator', async () => {
    // The same two assertions the synced snapshot passes, against a snapshot
    // whose `partial` went `undefined`: the key disappears in serialization,
    // which is exactly the regression a `=== null` check cannot see.
    const created = await api.createLocalReview({
      baseRef: 'main',
      headRef: 'feature/local-scenario-control',
    })
    const snap = await api.syncPull(created.id)
    const broken = JSON.parse(JSON.stringify({ ...snap, partial: undefined })) as unknown

    expect(hasOwn(broken, 'partial')).toBe(false)
    expect(() => validateSnapshot(broken)).toThrow(ValidationError)
  })
})
