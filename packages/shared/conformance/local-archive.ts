/**
 * Contract-conformance for ARCHIVE ON PULL-REQUEST APPEARANCE, expressed once
 * and run against ANY adapter that serves local reviews — the in-process mock,
 * the daemon over HTTP, and the direct engine in-process — so a change to what
 * a sync means for a superseded review cannot land on one of them alone.
 *
 * A local review names a branch PAIR inside one repository. The moment an open
 * pull request covers that same pair, the review is no longer where feedback
 * belongs: the sync that finds it is the review's LAST real sync, and from then
 * on the review is read-only against that pull request's number. Nothing is
 * copied anywhere, and nothing un-archives.
 *
 * What the contract fixes, and this block pins:
 *
 * - Before a pull request covers the pair the review is live: `archivedPr` is
 *   null, its row in the review list reads `open`, and the list's ETag is
 *   stable across two reads.
 * - The sync that finds the pull request stores a snapshot that ALREADY reads
 *   `closed`. Asserted off a read of the stored snapshot as well as off the
 *   returned value, because a returned value that never reached storage would
 *   satisfy the returned half alone.
 * - The listing then carries the pull request's number, the row reads `closed`,
 *   and the list ETag has MOVED — a client holding the old one must be served
 *   the change rather than a 304 forever.
 * - From then on the review is frozen: a later sync answers byte-identical
 *   bytes, the compare key stands, `lastSyncedAt` is not re-stamped, and the
 *   list ETag does NOT churn — an archive is one event, not a heartbeat.
 * - All four write verbs refuse, and refuse BEFORE they touch anything. The
 *   submit answers a 200-level `forbidden` VALUE; the other three throw a
 *   `forbidden` `ApiError`. All four carry the one shared sentence, and each
 *   test serializes the review's whole readable state before the call and
 *   requires it byte-identical after.
 * - The refusal comes ahead of the LOOKUP, not merely ahead of the mutation.
 *   Reply, resolve and react are aimed at a thread and a comment the review
 *   does not hold, so a verb that resolved its target first would answer
 *   `not_found`; `forbidden` is the assertion that the archive is decided first.
 * - Reads and drafts stay open. Text a human typed is never refused: the draft
 *   written while the review was live is still readable, a new one still saves,
 *   viewed marks still move, and the snapshot still answers.
 * - All of it survives the implementation being torn down and brought back, and
 *   archival is sticky: a further sync afterwards is still frozen and still
 *   carries the same number.
 *
 * Two things deliberately stay with the runner.
 *
 * WHICH PAIR A PULL REQUEST WILL COVER, and how to make it appear, are
 * properties of the implementation's world — a fixture pull request on one
 * side, a listing seam on another — so they arrive through `superseded`. The
 * pair must be one no other block reviews: creation is idempotent per pair, and
 * a shared pair would hand this walk a review another suite had already synced.
 *
 * THE CONDITIONAL LIST READ arrives as a hook rather than as a method on the
 * mapped api type, because the surfaces genuinely spell its argument
 * differently — the client contract takes an options bag (`{ etag }`) and the
 * in-process engine takes a bare ETag — so a block that drove one of them off
 * the mapped type could not be typed against the other at all.
 *
 * A PULL REQUEST CLOSED AFTER DETECTION is deliberately not driven here: the
 * contract carries no verb that closes a pull request, so the shared surface
 * cannot reach that state. It is pinned per transport, beside each
 * implementation, where the pull request source can be moved by hand.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { ApiError, archivedReviewRefusal } from '../src/index.ts'
import type { LocalReviewSummary, PullListResponse, RevuApi } from '../src/index.ts'
import { draftOn, rejection, resolve } from './local-common.ts'
import type { Answered, Lazy, LocalReviewPair, MaybePromise } from './local-common.ts'

/**
 * The slice of the contract this block drives, spelled so that an in-process
 * engine whose reads answer synchronously is held to it as readily as a
 * transport that answers over the wire — every call here is awaited, so the
 * shape of the answer is not part of what is being conformed to.
 *
 * `listPulls` is absent on purpose and reaches the block through the config's
 * hook instead; see this module's header for why.
 */
export type LocalArchiveApi = {
  [K in
    | 'createLocalReview'
    | 'listLocalReviews'
    | 'syncPull'
    | 'getSnapshot'
    | 'getDraft'
    | 'saveDraft'
    | 'getFileViewed'
    | 'setFileViewed'
    | 'submitReview'
    | 'replyToThread'
    | 'resolveThread'
    | 'addReaction']: Answered<RevuApi[K]>
}

/** The branch pair a pull request will cover, and how to make it appear. */
export interface SupersededPair {
  /** A pair a pull request will cover; distinct from every other suite's pair. */
  pair: LocalReviewPair
  /** The number of the pull request that will appear for it. */
  prNumber: number
  /** Make that pull request appear (open) for the pair. A no-op where it already exists. */
  appear: () => MaybePromise<void>
}

export interface LocalArchiveConformanceConfig {
  /** Human-readable transport name, used only in the top-level describe label. */
  label: string
  /** Build a fresh adapter bound to the implementation under test. */
  makeApi: () => MaybePromise<LocalArchiveApi>
  /**
   * The human the adapter's session keys drafts under. Every draft this block
   * saves carries it, because an adapter is entitled to store a draft under
   * the id the body names as well as to re-key it to the session — and a draft
   * written under any other id would be one the session could never read back.
   */
  humanId: Lazy<string>
  /** The pair a pull request covers, and the number it covers it with. */
  superseded: Lazy<SupersededPair>
  /**
   * The review list, read conditionally against an ETag the caller already
   * holds — `null` for an unconditional read. The runner closes over whichever
   * handle is current, so a restart is transparent to this block.
   */
  listPulls: (etag: string | null) => MaybePromise<PullListResponse>
  /**
   * Tear the implementation down and bring it back, returning the adapter to
   * use afterward. Everything written before the call must be readable through
   * the returned handle.
   */
  restart: () => MaybePromise<LocalArchiveApi>
}

/** Text written while the review was still live; an archive must never take it. */
const LIVE_DRAFT = 'Text an archive must keep.'

/** Text written AFTER the archive, proving the draft surface is still open. */
const EDITED_DRAFT = 'Text typed after the archive landed, which still saves.'

/** A path the viewed marks are moved on. Nothing requires it to be in the compare. */
const VIEWED_PATH = 'src/index.ts'

/**
 * A thread id shaped like a local one but naming no thread on this review, and
 * a comment id naming no comment. Both exist so the refusal can be shown to
 * come BEFORE the lookup: a verb that resolved its target first would answer
 * `not_found` for these, and `forbidden` is what says the archive decided.
 */
const MISSING_THREAD_SUFFIX = ':no-such-thread'
const MISSING_COMMENT_ID = 987_654_321

/** An ETag no list can have served, for the control on a conditional read. */
const IMPOSSIBLE_ETAG = 'W/"an-etag-no-list-has-ever-served"'

/** One archived review, with the number it stands against and the sentence it refuses with. */
interface ArchivedRow {
  summary: LocalReviewSummary
  archivedPr: number
  refusal: string
}

/**
 * Register the archive-on-pull-request conformance block for one adapter. Call
 * it from a `*.test.ts` runner where the adapter is reachable; the runner owns
 * any process-wide setup (a mock store reset, a daemon spawn, a fixture
 * repository) in its own hooks.
 */
export function runLocalReviewArchiveConformance(config: LocalArchiveConformanceConfig): void {
  const { label } = config

  describe(`archive on pull-request appearance — ${label}`, () => {
    let api: LocalArchiveApi
    let humanId: string
    let superseded: SupersededPair
    /** The one review the whole walk runs against. */
    let review: LocalReviewSummary
    /** The list ETag while the review was still live. */
    let liveEtag = ''
    /** The list ETag once the review had been archived. */
    let archivedEtag = ''
    /** The snapshot the archiving sync left behind, as bytes. */
    let frozenBytes = ''

    /** The review's own row in the list, or null when the list does not carry it. */
    function rowOf(list: PullListResponse): { state: 'open' | 'closed' } | null {
      const item = list.items.find((entry) => entry.pull.number === review.id)
      return item === undefined ? null : { state: item.pull.state }
    }

    /** The review's listing entry, or a failure naming what was missing. */
    async function summaryOf(): Promise<LocalReviewSummary> {
      const found = (await api.listLocalReviews()).find((entry) => entry.id === review.id)
      if (found === undefined) throw new Error(`local review ${review.id} is not listed`)
      return found
    }

    /**
     * The review as an ARCHIVED row, with the refusal every write verb must
     * answer with — built from the row's own number and refs through the
     * shared sentence, never paraphrased, so the block and the implementations
     * cannot drift into two different refusals.
     */
    async function archivedRow(): Promise<ArchivedRow> {
      const summary = await summaryOf()
      if (summary.archivedPr === null) {
        throw new Error(`local review ${review.id} is not archived`)
      }
      return {
        summary,
        archivedPr: summary.archivedPr,
        refusal: archivedReviewRefusal({
          archivedPr: summary.archivedPr,
          baseRef: summary.baseRef,
          headRef: summary.headRef,
        }),
      }
    }

    /**
     * Everything the review reads back as, serialized for a byte comparison:
     * the snapshot, the listing row, the draft and the viewed marks. A verb
     * that refuses only after mutating moves one of the four.
     */
    async function stateOf(): Promise<string> {
      return JSON.stringify({
        snapshot: await api.getSnapshot(review.id),
        summary: await summaryOf(),
        draft: await api.getDraft(review.id),
        viewed: await api.getFileViewed(review.id),
      })
    }

    beforeAll(async () => {
      api = await config.makeApi()
      humanId = await resolve(config.humanId)
      superseded = await resolve(config.superseded)
    })

    describe('a live review, before a pull request covers its pair', () => {
      test('the review is created live, listed live, and its row in the list reads open', async () => {
        review = await api.createLocalReview({
          ...superseded.pair,
          title: 'Archive conformance',
        })
        expect(review.archivedPr).toBeNull()

        // The control for both nulls: the listing and the list both FIND this
        // review, so "no archive number" is a reading of the review rather
        // than of a lookup that matched nothing.
        const summary = await summaryOf()
        expect(summary.id).toBe(review.id)
        expect(summary.archivedPr).toBeNull()

        const list = await config.listPulls(null)
        expect(list.notModified).toBe(false)
        expect(rowOf(list)).toEqual({ state: 'open' })
        liveEtag = list.etag
        expect(liveEtag.length).toBeGreaterThan(0)
      })

      test('a second read against that ETag is a 304, and the ETag it echoes is the same one', async () => {
        const conditional = await config.listPulls(liveEtag)

        expect(conditional.notModified).toBe(true)
        expect(conditional.etag).toBe(liveEtag)
      })

      test('a draft written while the review is live is saved and reads back', async () => {
        // Written BEFORE the first sync, and therefore against an empty head:
        // no implementation resolves ref tips at creation time, and on a pair a
        // pull request already covers the first sync is the one that archives,
        // so there is no synced head to write against that is not already an
        // archived one.
        expect(review.headSha).toBeNull()
        const saved = await api.saveDraft(
          draftOn(
            humanId,
            review,
            { headSha: '', compareKey: '' },
            { body: LIVE_DRAFT, comments: [] },
          ),
        )
        expect(saved.body).toBe(LIVE_DRAFT)
        expect((await api.getDraft(review.id))?.body).toBe(LIVE_DRAFT)
      })
    })

    describe('the sync that finds the pull request archives the review', () => {
      test('the snapshot the sync stored already reads closed, and the read agrees with what it returned', async () => {
        await superseded.appear()

        const returned = await api.syncPull(review.id)
        expect(returned.mutable.pull.state).toBe('closed')

        // The other half of the agreement, read back through the contract: a
        // returned value that never reached storage satisfies the line above
        // and fails here.
        const stored = await api.getSnapshot(review.id)
        expect(stored).not.toBeNull()
        expect(stored?.mutable.pull.state).toBe('closed')
        expect(JSON.stringify(stored)).toBe(JSON.stringify(returned))
      })

      test('the listing now carries the pull request number', async () => {
        expect((await summaryOf()).archivedPr).toBe(superseded.prNumber)
      })

      test('the list ETag moved, and the row is still listed — closed, not gone', async () => {
        const list = await config.listPulls(liveEtag)

        // Not a 304: a client holding the pre-archive ETag has to be shown the
        // change rather than replaying a list that no longer describes reality.
        expect(list.notModified).toBe(false)
        archivedEtag = list.etag
        expect(archivedEtag).not.toBe(liveEtag)
        // Archived is read-only, never invisible: the list is the row source
        // every review is resolved out of, and a review missing from it renders
        // as one this installation does not have.
        expect(rowOf(list)).toEqual({ state: 'closed' })
      })
    })

    describe('an archived review is frozen at that sync', () => {
      test('a later sync answers the identical bytes and re-stamps nothing', async () => {
        const before = await api.getSnapshot(review.id)
        expect(before).not.toBeNull()
        // The control for every "unchanged" below: there is a real snapshot
        // carrying a real compare key, and a real timestamp on the row, so the
        // comparisons are between values that exist rather than between nulls.
        expect((before?.immutable.compareKey ?? '').length).toBeGreaterThan(0)
        const syncedAt = (await summaryOf()).lastSyncedAt
        expect(syncedAt).not.toBeNull()
        frozenBytes = JSON.stringify(before)

        const frozen = await api.syncPull(review.id)

        expect(JSON.stringify(frozen)).toBe(frozenBytes)
        expect(JSON.stringify(await api.getSnapshot(review.id))).toBe(frozenBytes)
        expect((await api.getSnapshot(review.id))?.immutable.compareKey).toBe(
          before?.immutable.compareKey,
        )
        expect((await summaryOf()).lastSyncedAt).toBe(syncedAt)
      })

      test('the frozen sync did not churn the list ETag', async () => {
        const conditional = await config.listPulls(archivedEtag)
        expect(conditional.notModified).toBe(true)

        // The control: the same call with an ETag nothing served is answered in
        // FULL, and the ETag it serves is still the archived one — so the 304
        // above is a match on a live value rather than a hook that answers
        // "unchanged" to everything.
        const unconditional = await config.listPulls(IMPOSSIBLE_ETAG)
        expect(unconditional.notModified).toBe(false)
        expect(unconditional.etag).toBe(archivedEtag)
      })
    })

    describe('the four write verbs refuse, before touching anything', () => {
      test('submitReview answers a forbidden VALUE naming the pull request, and mutates nothing', async () => {
        const { refusal } = await archivedRow()
        const before = await stateOf()
        // The control for the byte comparison: the serialized state really
        // carries this review and the text on it, so "identical" is a claim
        // about state rather than about two empty strings.
        expect(before).toContain(String(review.id))
        expect(before).toContain(LIVE_DRAFT)

        const result = await api.submitReview({
          prNumber: review.id,
          expectedHeadSha: (await api.getSnapshot(review.id))?.immutable.headSha ?? '',
          event: 'APPROVE',
          body: 'A verdict that must not land.',
          comments: [],
        })

        // A 200-level value, exactly as a moved head is: the caller renders the
        // reason beside an editor whose draft is still intact.
        expect(result).toEqual({ status: 'forbidden', reason: refusal })
        expect(await stateOf()).toBe(before)
      })

      test('replyToThread throws forbidden — ahead of the thread lookup — and mutates nothing', async () => {
        const { refusal } = await archivedRow()
        const before = await stateOf()
        expect(before).toContain(String(review.id))

        // The thread named here is one the review does not hold. A verb that
        // looked its target up first would answer `not_found`; `forbidden` is
        // the assertion that the archive is decided ahead of the lookup, and
        // therefore ahead of anything the lookup could have led to.
        const thrown = await rejection(() =>
          api.replyToThread(review.id, `local:${review.id}${MISSING_THREAD_SUFFIX}`, 'No.'),
        )

        expect(thrown).toBeInstanceOf(ApiError)
        expect(thrown?.code).toBe('forbidden')
        expect(thrown?.message).toBe(refusal)
        expect(await stateOf()).toBe(before)
      })

      test('resolveThread throws forbidden — ahead of the thread lookup — and mutates nothing', async () => {
        const { refusal } = await archivedRow()
        const before = await stateOf()
        expect(before).toContain(String(review.id))

        const thrown = await rejection(() =>
          api.resolveThread(review.id, `local:${review.id}${MISSING_THREAD_SUFFIX}`, true),
        )

        expect(thrown).toBeInstanceOf(ApiError)
        expect(thrown?.code).toBe('forbidden')
        expect(thrown?.message).toBe(refusal)
        expect(await stateOf()).toBe(before)
      })

      test('addReaction throws forbidden — ahead of the comment lookup — and mutates nothing', async () => {
        const { refusal } = await archivedRow()
        const before = await stateOf()
        expect(before).toContain(String(review.id))

        const thrown = await rejection(() =>
          api.addReaction(review.id, MISSING_COMMENT_ID, 'rocket'),
        )

        expect(thrown).toBeInstanceOf(ApiError)
        expect(thrown?.code).toBe('forbidden')
        expect(thrown?.message).toBe(refusal)
        expect(await stateOf()).toBe(before)
      })
    })

    describe('reads and drafts stay open on an archived review', () => {
      test('the draft written while the review was live is still readable, and an edit still saves', async () => {
        expect((await api.getDraft(review.id))?.body).toBe(LIVE_DRAFT)

        const saved = await api.saveDraft(
          draftOn(
            humanId,
            review,
            { headSha: '', compareKey: '' },
            { body: EDITED_DRAFT, comments: [] },
          ),
        )
        expect(saved.body).toBe(EDITED_DRAFT)
        expect((await api.getDraft(review.id))?.body).toBe(EDITED_DRAFT)
      })

      test('viewed marks still move, and the snapshot still answers', async () => {
        const viewed = await api.setFileViewed(review.id, VIEWED_PATH, true, null)
        expect(viewed[VIEWED_PATH]?.viewed).toBe(true)
        expect(await api.getFileViewed(review.id)).toEqual(viewed)

        expect(await api.getSnapshot(review.id)).not.toBeNull()
      })
    })

    describe('the archive survives the implementation restarting', () => {
      test('the next handle reads the same number, the same closed row, and the same frozen snapshot', async () => {
        api = await config.restart()

        expect((await summaryOf()).archivedPr).toBe(superseded.prNumber)
        expect(rowOf(await config.listPulls(null))).toEqual({ state: 'closed' })
        expect(JSON.stringify(await api.getSnapshot(review.id))).toBe(frozenBytes)
      })

      test('a submit through the new handle is still refused, in the same words', async () => {
        const { refusal } = await archivedRow()

        const result = await api.submitReview({
          prNumber: review.id,
          expectedHeadSha: (await api.getSnapshot(review.id))?.immutable.headSha ?? '',
          event: 'COMMENT',
          body: 'A verdict that must not land after a restart either.',
          comments: [],
        })

        expect(result).toEqual({ status: 'forbidden', reason: refusal })
      })
    })

    describe('archiving is sticky', () => {
      test('a further sync is still frozen and still stands against the same pull request', async () => {
        // The shared contract carries no verb that closes a pull request, so
        // "a pull request closed later does not un-archive" cannot be driven
        // from here; it is pinned per transport, beside each implementation,
        // where the pull request source can be moved by hand. What IS reachable
        // here is that repetition changes nothing: the number does not move and
        // the snapshot does not thaw.
        const frozen = await api.syncPull(review.id)

        expect(JSON.stringify(frozen)).toBe(frozenBytes)
        expect((await summaryOf()).archivedPr).toBe(superseded.prNumber)
        expect(rowOf(await config.listPulls(null))).toEqual({ state: 'closed' })
      })
    })
  })
}
