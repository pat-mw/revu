/**
 * Contract-conformance for `deleteLocalReview`, expressed once and run against
 * ANY adapter — the in-process mock, the daemon over HTTP, and the direct
 * engine in-process — so the delete's semantics are held to one bar from one
 * source of truth rather than to three suites that happen to agree today.
 *
 * What the contract fixes, and this block pins:
 *
 * - A delete is REFUSED, as `unprocessable`, while any human's draft on the
 *   review holds text — a pending comment, or a body with anything in it. The
 *   route carries no flag to force it, so the refusal is the whole answer, and
 *   the message must name the remedy: discard the draft, then delete.
 * - The refusal is a precondition, never a partial delete. Everything the
 *   review holds — its listing, its snapshot, the thread a submit materialized,
 *   its viewed marks, the draft itself — is exactly where it was afterwards.
 * - The remedy works: discarding the draft and repeating the identical call
 *   succeeds, and the review is then gone from the listing.
 * - An id that carries no review — one just deleted, or one never created —
 *   answers the SAME typed `not_found`, with the same message shape, so the
 *   answer cannot confirm that an id exists somewhere this caller cannot see.
 * - The empty draft an editor creates the moment a review is opened does not
 *   block the delete, and goes with the review rather than being stranded
 *   under an id that is never minted again.
 * - A deleted id is never minted again: re-creating the same branch pair
 *   answers a strictly greater id.
 *
 * Two things deliberately stay with the runner. Which branch pair to review
 * and where a comment can anchor are properties of the implementation's
 * repository, so they arrive through config. And what the implementation's
 * STORAGE holds for a review is reached through an optional hook: the suite
 * never reads an adapter's internals, but a runner that can count rows off a
 * second handle hands that count in, and the suite then asserts the refusal
 * moved not one of them and the success left none. A runner with no second
 * handle omits the hook and keeps every contract-level assertion.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { ApiError } from '../src/index.ts'
import type { LocalReviewSummary, ReviewDraft, RevuApi } from '../src/index.ts'
import { draftOn, pendingAt, rejection, resolve } from './local-common.ts'
import type {
  Answered,
  Lazy,
  LocalReviewAnchor,
  LocalReviewPair,
  MaybePromise,
} from './local-common.ts'

export type { Lazy }

/** Where a submitted comment on the runner's branch pair can anchor. */
export type LocalDeleteAnchor = LocalReviewAnchor

/**
 * A count of what the implementation's storage holds for one review, keyed
 * however the runner names its tables. Opaque to the suite: it is compared
 * against itself across the refusal, required to be all positive before it,
 * and required to be all zero after the success.
 */
export type LocalReviewRowCounts = Record<string, number>

/** A branch pair the implementation can create a review of, as the client would spell it. */
export type LocalDeletePair = LocalReviewPair

/**
 * The slice of the contract this block drives, spelled so that an in-process
 * engine whose reads answer synchronously is held to it as readily as a
 * transport that answers over the wire — every call here is awaited, so the
 * shape of the answer is not part of what is being conformed to.
 */
export type LocalDeleteApi = {
  [K in
    | 'createLocalReview'
    | 'listLocalReviews'
    | 'deleteLocalReview'
    | 'syncPull'
    | 'getSnapshot'
    | 'getDraft'
    | 'saveDraft'
    | 'discardDraft'
    | 'getFileViewed'
    | 'setFileViewed'
    | 'submitReview']: Answered<RevuApi[K]>
}

export interface LocalDeleteConformanceConfig {
  /** Human-readable transport name, used only in the top-level describe label. */
  label: string
  /** Build a fresh adapter bound to the implementation under test. */
  makeApi: () => MaybePromise<LocalDeleteApi>
  /**
   * The human the adapter's session keys drafts under. Every draft this block
   * saves carries it, because an adapter is entitled to store a draft under
   * the id the body names as well as to re-key it to the session — and a draft
   * written under any other id would be one the session's own discard could
   * never reach.
   */
  humanId: Lazy<string>
  /** The branch pair every review here is created of. */
  pair: Lazy<LocalDeletePair>
  /** Where a comment can anchor on that pair. */
  anchor: Lazy<LocalDeleteAnchor>
  /**
   * The rows the implementation's storage holds for one review, read off a
   * handle the adapter does not own. Optional: an HTTP runner has no such
   * handle and keeps every other assertion.
   */
  rowsOf?: (reviewId: number) => MaybePromise<LocalReviewRowCounts>
}

/** The comment-key namespace this block's pending comments are minted under. */
const KEY_PREFIX = 'local-delete-conformance'

/** The one message shape both absent-id cases must share, with the id itself erased. */
function messageShape(err: ApiError | null, reviewId: number): string | null {
  return err === null ? null : err.message.split(String(reviewId)).join('<id>')
}

/**
 * Register the delete conformance block for one adapter. Call it from a
 * `*.test.ts` runner where the adapter is reachable; the runner owns any
 * process-wide setup (a mock store reset, a daemon spawn, a fixture repository)
 * in its own hooks.
 */
export function runLocalReviewDeleteConformance(config: LocalDeleteConformanceConfig): void {
  const { label } = config

  describe(`deleteLocalReview conformance — ${label}`, () => {
    let api: LocalDeleteApi
    let humanId: string
    let pair: LocalDeletePair
    let anchor: LocalDeleteAnchor
    let review: LocalReviewSummary
    let head: { headSha: string; compareKey: string }
    /** The draft with text the review is refused on. */
    let textDraft: ReviewDraft
    /** What storage held before the refusal, when the runner can say. */
    let rowsBefore: LocalReviewRowCounts | null = null

    beforeAll(async () => {
      api = await config.makeApi()
      humanId = await resolve(config.humanId)
      pair = await resolve(config.pair)
      anchor = await resolve(config.anchor)
    })

    describe('a review holding text is refused whole', () => {
      it('a synced, reviewed, viewed review with a draft holding text is refused as unprocessable', async () => {
        review = await api.createLocalReview({
          ...pair,
          title: 'Delete conformance',
        })
        const snap = await api.syncPull(review.id)
        head = { headSha: snap.immutable.headSha, compareKey: snap.immutable.compareKey }

        // A submitted comment, so the review carries a materialized thread and
        // a verdict — rows a delete has to leave alone when it refuses, and a
        // submit is the only contract-level way to create them.
        const submitted = await api.submitReview({
          prNumber: review.id,
          expectedHeadSha: head.headSha,
          event: 'COMMENT',
          body: 'A verdict recorded before the delete is attempted.',
          comments: [pendingAt(anchor, 'A thread that must survive a refused delete.', KEY_PREFIX)],
        })
        expect(submitted.status).toBe('ok')
        await api.setFileViewed(review.id, anchor.path, true, null)

        // The draft that refuses the delete: a body with text and no comment.
        textDraft = await api.saveDraft(
          draftOn(humanId, review, head, {
            body: 'Unsubmitted text that a delete must never destroy.',
            comments: [],
          }),
        )
        expect(textDraft.body.length).toBeGreaterThan(0)

        // Every "still there" below has its positive control here, read back
        // through the contract: the review is listed, its snapshot carries the
        // submitted thread, the viewed mark is set, and the draft is readable.
        expect((await api.listLocalReviews()).map((r) => r.id)).toContain(review.id)
        const before = await api.getSnapshot(review.id)
        expect(before?.mutable.threads).toHaveLength(1)
        expect((await api.getFileViewed(review.id))[anchor.path]?.viewed).toBe(true)
        expect((await api.getDraft(review.id))?.body).toBe(textDraft.body)
        if (config.rowsOf) {
          rowsBefore = await config.rowsOf(review.id)
          // The storage witness is live: every count it reports is positive,
          // so the "moved nothing" below is a claim about rows that existed.
          expect(Object.keys(rowsBefore).length).toBeGreaterThan(0)
          for (const [table, count] of Object.entries(rowsBefore)) {
            expect([table, count > 0]).toEqual([table, true])
          }
        }

        const refused = await rejection(() => api.deleteLocalReview(review.id))
        expect(refused).toBeInstanceOf(ApiError)
        expect(refused?.code).toBe('unprocessable')
        // The message names the remedy. What it names is tested below by
        // following it; here it is only required to say it.
        expect(refused?.message).toMatch(/discard/i)
      })

      it('the refusal was a precondition: everything the review held is exactly where it was', async () => {
        expect((await api.listLocalReviews()).map((r) => r.id)).toContain(review.id)
        const snap = await api.getSnapshot(review.id)
        expect(snap).not.toBeNull()
        expect(snap?.immutable.compareKey).toBe(head.compareKey)
        expect(snap?.mutable.threads).toHaveLength(1)
        expect((await api.getFileViewed(review.id))[anchor.path]?.viewed).toBe(true)
        const draft = await api.getDraft(review.id)
        expect(draft?.body).toBe(textDraft.body)
        expect(draft?.comments).toEqual([])
        if (config.rowsOf) {
          expect(await config.rowsOf(review.id)).toEqual(rowsBefore)
        }
      })

      it('a draft whose body is empty but which carries a pending comment is refused just the same', async () => {
        await api.saveDraft(
          draftOn(humanId, review, head, {
            body: '',
            comments: [pendingAt(anchor, 'An anchored note with nothing in the body.', KEY_PREFIX)],
          }),
        )
        const refused = await rejection(() => api.deleteLocalReview(review.id))
        expect(refused?.code).toBe('unprocessable')
        expect((await api.listLocalReviews()).map((r) => r.id)).toContain(review.id)
        expect((await api.getDraft(review.id))?.comments).toHaveLength(1)
      })
    })

    describe('the remedy the message names works', () => {
      it('discarding the draft and repeating the identical call succeeds', async () => {
        await api.discardDraft(review.id)
        expect(await api.getDraft(review.id)).toBeNull()

        await api.deleteLocalReview(review.id)

        expect((await api.listLocalReviews()).map((r) => r.id)).not.toContain(review.id)
        if (config.rowsOf) {
          // Nothing keyed to the review survives it — the viewed mark, the
          // thread and the verdict included. A row left behind under an id
          // that is never minted again is unlistable forever.
          const rowsAfter = await config.rowsOf(review.id)
          expect(Object.keys(rowsAfter).sort()).toEqual(Object.keys(rowsBefore ?? {}).sort())
          for (const [table, count] of Object.entries(rowsAfter)) {
            expect([table, count]).toEqual([table, 0])
          }
        }
      })
    })

    describe('an id that carries no review', () => {
      it('a repeated delete and a never-created id answer the same not_found, with the same message shape', async () => {
        const repeated = await rejection(() => api.deleteLocalReview(review.id))
        expect(repeated).toBeInstanceOf(ApiError)
        expect(repeated?.code).toBe('not_found')

        // Deep inside the same reserved band as every real local id, so the
        // answer is about the review's absence and not about the id's shape.
        const neverCreated = review.id + 987_654
        const never = await rejection(() => api.deleteLocalReview(neverCreated))
        expect(never).toBeInstanceOf(ApiError)
        expect(never?.code).toBe('not_found')

        // The two messages differ by the id alone. Anything else — a word for
        // "already deleted" against one for "unknown" — would confirm to the
        // caller that a review once existed under the first id.
        expect(messageShape(never, neverCreated)).toBe(messageShape(repeated, review.id))
        expect(messageShape(never, neverCreated)).toContain('<id>')
      })
    })

    describe('an empty draft never blocks, and a deleted id is never reused', () => {
      it('re-creating the pair mints a greater id, and an editor-empty draft goes with the review', async () => {
        const again = await api.createLocalReview(pair)
        expect(again.id).toBeGreaterThan(review.id)

        const snap = await api.syncPull(again.id)
        // The shape an editor writes on its own the moment a review is opened:
        // no comment, an empty body. Counting it as text would make every
        // review a human had merely looked at undeletable.
        await api.saveDraft(
          draftOn(
            humanId,
            again,
            { headSha: snap.immutable.headSha, compareKey: snap.immutable.compareKey },
            { body: '', comments: [] },
          ),
        )
        await api.setFileViewed(again.id, anchor.path, true, null)
        // The control: there IS a draft row and a viewed row to be refused on.
        expect(await api.getDraft(again.id)).not.toBeNull()
        expect((await api.getFileViewed(again.id))[anchor.path]?.viewed).toBe(true)
        let rows: LocalReviewRowCounts | null = null
        if (config.rowsOf) {
          rows = await config.rowsOf(again.id)
          expect(Object.values(rows).some((count) => count > 0)).toBe(true)
        }

        await api.deleteLocalReview(again.id)

        expect((await api.listLocalReviews()).map((r) => r.id)).not.toContain(again.id)
        if (config.rowsOf) {
          const after = await config.rowsOf(again.id)
          expect(Object.keys(after).sort()).toEqual(Object.keys(rows ?? {}).sort())
          for (const [table, count] of Object.entries(after)) {
            expect([table, count]).toEqual([table, 0])
          }
        }
      })
    })
  })
}
