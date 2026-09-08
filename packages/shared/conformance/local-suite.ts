/**
 * Contract-conformance for the whole review loop over a branch pair that has
 * no pull request behind it — create, sync, draft, submit, reply, resolve,
 * react, restart — expressed once and run against ANY adapter that serves such
 * reviews, so the in-process mock, the daemon over HTTP and the direct engine
 * are held to one bar from one source of truth.
 *
 * What the contract fixes, and this block pins:
 *
 * - A local review's id comes from the reserved review band, and creation is
 *   idempotent per branch pair: the same pair twice is one review, not two.
 * - A review that has never been synced reads back as `null`, never as a
 *   thrown `not_found` — "nothing cached yet" is an ordinary answer, and a
 *   rejection here would send the UI down an error path for a normal state.
 * - A synced snapshot carries `partial` as a PRESENT key valued `null`, its
 *   `compareKey` is exactly `<merge base>...<head>`, and the cached copy every
 *   later read is served from carries the same key.
 * - The empty compare is legal. A workspace with no git objects behind the
 *   pair produces merge base == head, no files, no blobs and no commits; one
 *   over a real repository produces the diff. Which of the two a runner has is
 *   a property of its FIXTURE, so it is declared through `compare` — but every
 *   head blob the index does name must be readable and non-empty either way.
 * - A moved head is a RETURNED `head_moved` value and never a rejection, and
 *   it leaves the reviewer's draft exactly where it was.
 * - A submit materializes each pending comment into a thread on the snapshot,
 *   with ids from the reserved entity band (positive, because negatives belong
 *   to the UI's optimistic synthetics) and bodies stored VERBATIM. Nothing here
 *   is stamped with an author prefix: that stamp exists only because many
 *   humans share one GitHub account, and locally the author is recorded beside
 *   the comment instead of smuggled into the text.
 * - Submitted verdicts live outside the snapshot: `mutable.reviews` and
 *   `mutable.issueComments` stay empty, so the conversation surface of a local
 *   review is threads-only.
 * - Replies, resolutions and reactions all answer with the complete value the
 *   client swaps its optimistic entry for, and the snapshot agrees afterwards.
 * - Everything written survives the implementation being torn down and brought
 *   back: the draft, the listing, and the snapshot's compare key.
 *
 * Three things deliberately stay with the runner. Which branch pair to review
 * and where a comment can anchor are properties of the implementation's
 * repository. So is what that pair's compare holds, which is why `compare` is
 * declared rather than inferred — a suite that guessed would either fail an
 * honest empty compare or accept a diff that silently went missing.
 *
 * Threads are read off `snapshot.mutable.threads` and never through a
 * thread-listing method, so an engine that publishes threads only through the
 * snapshot is held to these assertions unchanged.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import {
  ApiError,
  LOCAL_ENTITY_ID_BASE,
  LOCAL_REVIEW_ID_BASE,
  blobContentToLines,
  isLocalReviewId,
} from '../src/index.ts'
import type { LocalReviewSummary, ReactionKey, ReviewThread, RevuApi } from '../src/index.ts'
import { draftOn, pendingAt, resolve } from './local-common.ts'
import type {
  Answered,
  Lazy,
  LocalReviewAnchor,
  LocalReviewPair,
  MaybePromise,
} from './local-common.ts'

/**
 * The slice of the contract this block drives, spelled so that an in-process
 * engine whose reads answer synchronously is held to it as readily as a
 * transport that answers over the wire — every call here is awaited, so the
 * shape of the answer is not part of what is being conformed to.
 *
 * A thread-listing method is deliberately absent: threads are read off the
 * snapshot's mutable half, which every implementation has.
 */
export type LocalReviewApi = {
  [K in
    | 'createLocalReview'
    | 'listLocalReviews'
    | 'syncPull'
    | 'getSnapshot'
    | 'getBlob'
    | 'getDraft'
    | 'saveDraft'
    | 'submitReview'
    | 'replyToThread'
    | 'resolveThread'
    | 'addReaction']: Answered<RevuApi[K]>
}

/**
 * What the runner's branch pair actually diffs to: `changes` for a pair with
 * commits and files between its two sides, `empty` for the legal compare a
 * workspace with no git objects behind the pair produces (merge base == head,
 * nothing changed). A property of the fixture, never of the contract.
 */
export type LocalCompareShape = 'empty' | 'changes'

export interface LocalReviewConformanceConfig {
  /** Human-readable transport name, used only in the top-level describe label. */
  label: string
  /** Build a fresh adapter bound to the implementation under test. */
  makeApi: () => MaybePromise<LocalReviewApi>
  /**
   * The human the adapter's session keys drafts under. Every draft this block
   * saves carries it, because an adapter is entitled to store a draft under
   * the id the body names as well as to re-key it to the session — and a draft
   * written under any other id would be one the session could never read back.
   */
  humanId: Lazy<string>
  /** The branch pair every review here is created of. */
  pair: Lazy<LocalReviewPair>
  /** Where a comment can anchor on that pair. */
  anchor: Lazy<LocalReviewAnchor>
  /** What that pair's compare holds — the runner's fixture, declared. */
  compare: Lazy<LocalCompareShape>
  /**
   * Tear the implementation down and bring it back, returning the adapter to
   * use afterward. Everything written before the call must be readable through
   * the returned handle.
   */
  restart: () => MaybePromise<LocalReviewApi>
}

/** What one call did, so "resolved" can be asserted rather than merely not crashed. */
type Settled<T> = { threw: false; value: T } | { threw: true; error: unknown }

/**
 * Await a call without letting a rejection abort the test, so "resolved rather
 * than thrown" becomes an assertion on an observed outcome instead of the
 * absence of a crash. Takes the call rather than its promise so an adapter that
 * throws synchronously is captured the same way as one that rejects.
 */
async function settle<T>(call: () => MaybePromise<T>): Promise<Settled<T>> {
  try {
    return { threw: false, value: await call() }
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

/** Whether an object carries a key of its own, rather than merely reading undefined for it. */
function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key)
}

/** The comment-key namespace this block's pending comments are minted under. */
const KEY_PREFIX = 'local-review-conformance'

/** A head SHA no ref can be at, so the head guard must fire against it. */
const STALE_HEAD_SHA = 'not-the-real-head'

const DRAFT_BODY = 'One blocking question and a naming nit.'
const COMMENT_BODY = 'This guard clause reads inverted — the early return is the happy path.'
const REPLY_BODY = 'Rewrote it the other way round; take another look.'
const DURABLE_BODY = 'Unsubmitted text that must still be here after a restart.'

/**
 * The author stamp a body must NOT carry: `**Name** (role) ` at the very start.
 * It is prepended only where many humans write through one shared GitHub
 * account; a local review has exactly one author, recorded beside the comment,
 * so a stamp here would render as literal text in the body.
 */
const STAMP = /^\*\*[^*]+\*\* \(/

/**
 * Register the local-review conformance block for one adapter. Call it from a
 * `*.test.ts` runner where the adapter is reachable; the runner owns any
 * process-wide setup (a mock store reset, a daemon spawn, a fixture repository)
 * in its own hooks.
 */
export function runLocalReviewConformanceSuite(config: LocalReviewConformanceConfig): void {
  const { label } = config

  describe(`local review conformance — ${label}`, () => {
    let api: LocalReviewApi
    let humanId: string
    let pair: LocalReviewPair
    let anchor: LocalReviewAnchor
    let compare: LocalCompareShape
    /** The one review the whole walk runs against. */
    let review: LocalReviewSummary
    /** The head the draft and the submit are written against. */
    let head: { headSha: string; compareKey: string }
    /** The threads the review carried before the submit, so "gained one" is a delta. */
    let threadIdsBeforeSubmit: string[] = []
    /** The thread the submit materialized. */
    let threadId = ''

    /** The review's threads, read off the snapshot rather than a listing method. */
    async function threadsOf(id: number): Promise<ReviewThread[]> {
      const snap = await api.getSnapshot(id)
      return snap?.mutable.threads ?? []
    }

    beforeAll(async () => {
      api = await config.makeApi()
      humanId = await resolve(config.humanId)
      pair = await resolve(config.pair)
      anchor = await resolve(config.anchor)
      compare = await resolve(config.compare)
    })

    describe('a branch pair becomes exactly one review, in the reserved id band', () => {
      it('creating a review of the pair mints an id in the local review band and lists it', async () => {
        review = await api.createLocalReview({ ...pair, title: 'Local review conformance' })

        expect(isLocalReviewId(review.id)).toBe(true)
        expect(review.id).toBeGreaterThanOrEqual(LOCAL_REVIEW_ID_BASE)
        expect((await api.listLocalReviews()).map((r) => r.id)).toContain(review.id)
      })

      it('creating the identical pair again answers the same review, never a second one', async () => {
        const again = await api.createLocalReview({ ...pair, title: 'Local review conformance' })

        expect(again.id).toBe(review.id)
        expect((await api.listLocalReviews()).filter((r) => r.id === review.id)).toHaveLength(1)
      })
    })

    describe('a review with nothing synced yet', () => {
      it('getSnapshot before the first sync RESOLVES null — it is not a thrown not_found', async () => {
        const settled = await settle(() => api.getSnapshot(review.id))

        // Asserted as an observed outcome so a regression to a typed rejection
        // names itself here rather than reading as an unrelated crash.
        expect(outcomeOf(settled)).toBe('resolved')
        if (settled.threw) return
        expect(settled.value).toBeNull()
      })
    })

    describe('the first sync writes a complete, self-consistent snapshot', () => {
      it('sync resolves a snapshot carrying partial as a present key valued null', async () => {
        const snap = await api.syncPull(review.id)
        head = { headSha: snap.immutable.headSha, compareKey: snap.immutable.compareKey }

        expect(snap.prNumber).toBe(review.id)
        // The key half is what matters: a key whose value went `undefined`
        // vanishes in serialization, so a `=== null` check alone would pass on
        // a snapshot that never carries the key at all.
        expect(hasOwn(snap, 'partial')).toBe(true)
        expect(snap.partial).toBeNull()
        // The diff is keyed by the three-dot compare, never by head alone.
        expect(snap.immutable.compareKey).toBe(
          `${snap.immutable.mergeBaseSha}...${snap.immutable.headSha}`,
        )
      })

      it('the cached snapshot every later read comes off carries the same compare key', async () => {
        const cached = await api.getSnapshot(review.id)

        expect(cached).not.toBeNull()
        expect(cached?.prNumber).toBe(review.id)
        expect(cached?.immutable.compareKey).toBe(head.compareKey)
      })
    })

    describe('the compare the runner declared is the compare the snapshot holds', () => {
      it('the immutable half matches the declared compare shape', async () => {
        const snap = await api.getSnapshot(review.id)
        expect(snap).not.toBeNull()
        if (!snap) return
        const { immutable } = snap

        if (compare === 'changes') {
          expect(immutable.files.length).toBeGreaterThan(0)
          expect(immutable.files.map((f) => f.filename)).toContain(anchor.path)
          const headSha = immutable.blobIndex[anchor.path]?.head ?? null
          expect(typeof headSha).toBe('string')
          if (typeof headSha !== 'string') return
          const blob = await api.getBlob(headSha)
          expect(blob.binary).toBe(false)
          expect(blob.content.length).toBeGreaterThan(0)
          // The anchor names a real line of the head blob, so a comment placed
          // there is placed on the text the runner says is there.
          const lines = blobContentToLines(blob.content)
          expect((lines[anchor.line - 1] ?? '').trim()).toBe(anchor.lineText.trim())
          expect(immutable.mergeBaseSha).not.toBe(immutable.headSha)
          expect(immutable.commits.length).toBeGreaterThan(0)
        } else {
          // The legal empty compare: head has no commits ahead of base, so
          // there is nothing to diff and nothing to fetch. Asserted as deep
          // equality rather than emptiness so a half-built half is caught too.
          expect(immutable.files).toEqual([])
          expect(immutable.blobIndex).toEqual({})
          expect(immutable.commits).toEqual([])
          expect(immutable.mergeBaseSha).toBe(immutable.headSha)
        }
      })

      it('every head blob the index names is readable from the store and non-empty', async () => {
        const snap = await api.getSnapshot(review.id)
        expect(snap).not.toBeNull()
        if (!snap) return

        const heads: string[] = []
        for (const entry of Object.values(snap.immutable.blobIndex)) {
          if (entry.head !== null) heads.push(entry.head)
        }
        for (const sha of heads) {
          const blob = await api.getBlob(sha)
          // A text blob carries its bytes as `content`. A binary blob is
          // stored COLLAPSED — `binary: true`, the true byte `size`, and an
          // empty `content` — so "readable and non-empty" is a claim about the
          // object's size there, not about text it deliberately does not carry.
          const readable = blob.binary
            ? blob.size > 0 && blob.content === ''
            : blob.content.length > 0
          expect([sha, blob.binary, readable]).toEqual([sha, blob.binary, true])
        }
        // The loop's own control: it ran over something exactly when the
        // runner declared a compare that carries files, so a silently emptied
        // blob index cannot make this pass by iterating nothing.
        expect(heads.length > 0).toBe(compare === 'changes')
      })
    })

    describe('a moved head is a returned value, never a rejection', () => {
      it('a submit against a head SHA that cannot match RESOLVES with status head_moved', async () => {
        expect(STALE_HEAD_SHA).not.toBe(head.headSha)
        const saved = await api.saveDraft(
          draftOn(humanId, review, head, {
            body: DRAFT_BODY,
            comments: [pendingAt(anchor, COMMENT_BODY, KEY_PREFIX)],
          }),
        )
        expect(saved.comments).toHaveLength(1)

        const settled = await settle(() =>
          api.submitReview({
            prNumber: review.id,
            expectedHeadSha: STALE_HEAD_SHA,
            event: 'COMMENT',
            body: DRAFT_BODY,
            comments: saved.comments,
          }),
        )

        // A moved head is a 200-level answer the UI routes through reconcile.
        // Any throw at all fails here, whatever its code.
        expect(outcomeOf(settled)).toBe('resolved')
        if (settled.threw) return
        expect(settled.value.status).toBe('head_moved')
      })

      it('the head guard left the reviewer text exactly where it was', async () => {
        const draft = await api.getDraft(review.id)

        expect(draft?.body).toBe(DRAFT_BODY)
        expect(draft?.comments).toHaveLength(1)
        expect(draft?.comments[0]?.body).toBe(COMMENT_BODY)
      })
    })

    describe('a submit materializes the draft into the snapshot', () => {
      it('a submit against the true head is accepted, minting a review id in the entity band', async () => {
        const draft = await api.getDraft(review.id)
        expect(draft).not.toBeNull()
        if (!draft) return
        threadIdsBeforeSubmit = (await threadsOf(review.id)).map((t) => t.id)

        const result = await api.submitReview({
          prNumber: review.id,
          expectedHeadSha: head.headSha,
          event: 'COMMENT',
          body: draft.body,
          comments: draft.comments,
        })

        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return
        expect(result.review.id).toBeGreaterThan(0)
        expect(result.review.id).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)
        // A confirmed submit is the only thing besides the reviewer's own
        // discard that takes a draft away.
        expect(await api.getDraft(review.id)).toBeNull()
      })

      it('the snapshot gained exactly one thread, anchored where the pending comment was', async () => {
        const threads = await threadsOf(review.id)
        const gained = threads.filter((t) => !threadIdsBeforeSubmit.includes(t.id))

        expect(gained).toHaveLength(1)
        const thread = gained[0]
        if (!thread) return
        threadId = thread.id
        expect(thread.path).toBe(anchor.path)
        expect(thread.line).toBe(anchor.line)
        expect(thread.isResolved).toBe(false)
        expect(thread.comments.length).toBeGreaterThan(0)
        for (const comment of thread.comments) {
          expect([comment.id, comment.id > 0 && comment.id >= LOCAL_ENTITY_ID_BASE]).toEqual([
            comment.id,
            true,
          ])
        }
      })

      it('the materialized body is the reviewer text verbatim, with no author stamp in front', async () => {
        const thread = (await threadsOf(review.id)).find((t) => t.id === threadId)
        const body = thread?.comments[0]?.body ?? null

        expect(body).toBe(COMMENT_BODY)
        expect(body ?? '').not.toMatch(STAMP)
      })

      it('the verdict lives outside the snapshot: reviews and issue comments stay empty', async () => {
        const snap = await api.getSnapshot(review.id)

        expect(snap).not.toBeNull()
        expect(snap?.mutable.reviews).toEqual([])
        expect(snap?.mutable.issueComments).toEqual([])
      })
    })

    describe('a reply lands on the thread whole', () => {
      it('replyToThread answers a complete comment and the thread grew by exactly one', async () => {
        const before = (await threadsOf(review.id)).find((t) => t.id === threadId)
        expect(before?.comments).toHaveLength(1)
        const root = before?.comments[0]
        expect(root).toBeDefined()
        if (!root) return

        const reply = await api.replyToThread(review.id, threadId, REPLY_BODY)

        expect(reply.id).toBeGreaterThan(0)
        expect(reply.id).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)
        // A NEW id, never one the thread already held: the client re-keys its
        // author map by comment id, and a duplicate would orphan that entry.
        expect(reply.id).not.toBe(root.id)
        expect(reply.body).toBe(REPLY_BODY)
        expect(reply.path).toBe(anchor.path)
        expect(reply.line).toBe(anchor.line)
        // The shape the app copies back into the thread: who wrote it, when,
        // and which comment it answers.
        expect(reply.user.login.length).toBeGreaterThan(0)
        expect(reply.created_at.length).toBeGreaterThan(0)
        expect(reply.in_reply_to_id).toBe(root.id)

        const after = (await threadsOf(review.id)).find((t) => t.id === threadId)
        expect(after?.comments).toHaveLength(2)
        expect(after?.comments.at(-1)?.id).toBe(reply.id)
        // Every id on the thread is distinct from every other one on it.
        const ids = after?.comments.map((c) => c.id) ?? []
        expect(new Set(ids).size).toBe(ids.length)
      })
    })

    describe('a resolution is recorded and readable', () => {
      it('resolveThread answers the resolved thread, names who did it, and the snapshot agrees', async () => {
        const resolved = await api.resolveThread(review.id, threadId, true)

        expect(resolved.id).toBe(threadId)
        expect(resolved.isResolved).toBe(true)
        // Someone is named, because a resolution nobody owns cannot be
        // rendered or argued with.
        expect((resolved.resolvedBy?.login ?? '').length).toBeGreaterThan(0)
        // The app copies `isOutdated` back off this answer; an absent key
        // would land as `undefined` where a boolean is rendered.
        expect(typeof resolved.isOutdated).toBe('boolean')

        const stored = (await threadsOf(review.id)).find((t) => t.id === threadId)
        expect(stored?.isResolved).toBe(true)
        expect((stored?.resolvedBy?.login ?? '').length).toBeGreaterThan(0)
        expect(typeof stored?.isOutdated).toBe('boolean')
      })
    })

    describe('a reaction bumps exactly its own key and the total', () => {
      it('addReaction answers a rollup one greater than the value the snapshot held, and the snapshot agrees', async () => {
        const thread = (await threadsOf(review.id)).find((t) => t.id === threadId)
        const comment = thread?.comments[0]
        expect(comment).toBeDefined()
        if (!comment) return
        const key: ReactionKey = 'heart'
        const before = comment.reactions[key]
        const beforeTotal = comment.reactions.total_count

        const rollup = await api.addReaction(review.id, comment.id, key)

        expect(rollup[key]).toBe(before + 1)
        expect(rollup.total_count).toBe(beforeTotal + 1)

        // The rollup the call answered is the rollup the snapshot now holds,
        // so the read that follows the optimistic update lands on the same
        // numbers rather than reverting to the old ones.
        const stored = (await threadsOf(review.id))
          .find((t) => t.id === threadId)
          ?.comments.find((c) => c.id === comment.id)
        expect(stored?.reactions).toEqual(rollup)
      })
    })

    describe('nothing a local review stores is stamped with an author prefix', () => {
      it('every comment body the review holds is the text that was sent, unprefixed', async () => {
        const bodies = (await threadsOf(review.id)).flatMap((t) => t.comments.map((c) => c.body))

        // The control: there ARE bodies to inspect, so a pass is evidence
        // about stored text rather than about an empty review.
        expect(bodies.length).toBeGreaterThan(0)
        for (const body of bodies) {
          expect([body, STAMP.test(body)]).toEqual([body, false])
        }
      })
    })

    describe('what was written before a restart is what the next handle reads', () => {
      it('a draft, the listing and the compare key all survive the implementation restarting', async () => {
        const saved = await api.saveDraft(
          draftOn(humanId, review, head, { body: DURABLE_BODY, comments: [] }),
        )
        expect(saved.body).toBe(DURABLE_BODY)

        api = await config.restart()

        const reloaded = await api.getDraft(review.id)
        expect(reloaded?.body).toBe(DURABLE_BODY)
        expect((await api.listLocalReviews()).map((r) => r.id)).toContain(review.id)
        expect((await api.getSnapshot(review.id))?.immutable.compareKey).toBe(head.compareKey)
      })
    })
  })
}
