/**
 * The local write port's shape, and what a local write verb may never do.
 *
 * `makeLocalDeps()` is the one typed dependency factory the local write tests
 * construct their dependencies through, and keeping it the only constructor of
 * one in this package is what turns the key-set assertion below into a standing
 * pin rather than a snapshot of the day it was written: the port cannot quietly
 * grow a GitHub client, a body-stamping/journalling decorator or a subprocess
 * runner.
 *
 * Three routes in and one out, each caught by a different half of the pin. A
 * REQUIRED member the factory does not set fails to COMPILE here. A member the
 * factory does set changes the KEY SET. A member removed from the port and from
 * the factory together compiles cleanly and is caught only by the key set, which
 * is why that assertion is written out as a literal rather than derived.
 *
 * The route none of those sees is an OPTIONAL member never set by the factory:
 * `Object.keys` reads the FACTORY and not the type, and the compiler holds the
 * factory only to the port's required members. That one is closed by the
 * written-out member list below, which the compiler compares against the
 * interface's own key union — the only way an assertion can see a member the
 * runtime never materializes. What remains is a coordinated edit of the member
 * list, the factory and the key-set literal in one change, which is a deliberate
 * move of the port rather than an accident.
 *
 * The store half of the port is the shared in-memory harness rather than a fake
 * written here, so a member the port grows has exactly one implementation to
 * appear in. That harness carries its own obligations — reads hand out copies,
 * and its failure injection really fires — and those are asserted in the last
 * describe of this file, because every persistence assertion any local write
 * case makes is only as good as they are.
 *
 * These tests construct NO GitHub client of any kind, not even a throwing one
 * of the sort the GitHub write tests spread in to prove nothing unexpected was
 * reached. The port has nowhere to put one, so the absence is the assertion.
 *
 * EVERY VERB'S BEHAVIOUR IS NOW WRITTEN, and the machinery that tracked which
 * ones were not has been removed rather than left standing over an empty list.
 * While verbs were landing one at a time this file kept two disjoint lists of
 * them and looped a refusal case over the unwritten one; with that list empty
 * the loop would run zero cases, and a describe that runs no cases is reported
 * as green rather than as missing — the exact shape of a suite that looks like
 * it is asserting something and is not.
 *
 * What replaces it is a claim about behaviour rather than a list of names. The
 * verb list is still compared against the module's exports, so a verb added
 * later cannot slip past unlisted, and the list is driven against a review that
 * has never been synced with every verb required to fail with a TYPED contract
 * failure. A verb whose body could not answer in full would have to throw
 * something — and a bare throw is not an `ApiError`, so it fails that case
 * rather than being quietly tolerated by a loop nobody noticed was empty.
 */
import { describe, expect, test } from 'bun:test'
import type {
  CommitInfo,
  GhUser,
  PendingComment,
  ReactionKey,
  ReactionRollup,
  ReviewComment,
  ReviewDraft,
  ReviewSummary,
  ReviewThread,
  Session,
  Snapshot,
  SubmitReviewInput,
} from '@revu/shared'
import { ApiError, LOCAL_ENTITY_ID_BASE, LOCAL_REVIEW_ID_BASE, prefixBody } from '@revu/shared'
import type {
  FakeLocalStore,
  FakeLocalStoreOptions,
  LocalStoreMethod,
} from './local-write-fakes'
import {
  SEEDED_AUTHOR,
  countingEntityIds,
  createFakeLocalStore,
  fixedHead,
  localSnapshot,
  localThread,
  zeroedReactions,
} from './local-write-fakes'
import type { LocalWriteDeps } from './local-writes'
import * as localWrites from './local-writes'

/** The local review every case here addresses. */
const LOCAL_ID = LOCAL_REVIEW_ID_BASE + 1

/** A thread id in the shape a local review mints: one URL path segment, no slash. */
const THREAD_ID = `local:${LOCAL_ID}:${LOCAL_ENTITY_ID_BASE}`

const HEAD_SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
const FIXED_NOW = '2026-01-02T03:04:05.000Z'

const SESSION: Session = {
  human: {
    id: 'dana.reeve@example.test',
    name: 'Dana Reeve',
    role: 'contractor',
    email: 'dana.reeve@example.test',
  },
  // Empty in every non-broker deployment: there is no shared bot account here,
  // which is the same reason local comment bodies are never stamped.
  brokerLogin: '',
  workspace: 'local',
}

const SEEDED_DRAFT: ReviewDraft = {
  humanId: SESSION.human.id,
  prNumber: LOCAL_ID,
  headSha: HEAD_SHA,
  compareKey: `${BASE_SHA}...${HEAD_SHA}`,
  body: 'One question on the retry loop, otherwise this reads well.',
  event: 'COMMENT',
  comments: [],
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
}

/**
 * One entry of a stored compare's commit list. Only its length is ever read
 * here — the moved-head answer sizes itself against it — so the fields carry
 * whatever a well-formed commit carries and nothing asserts on them.
 */
const commit = (sha: string): CommitInfo => ({
  sha,
  commit: {
    message: `Seeded commit ${sha.slice(0, 7)}`,
    author: { name: 'Dana Reeve', email: 'dana.reeve@example.test', date: FIXED_NOW },
  },
  author: null,
  parents: [],
})

const SUBMIT_INPUT: SubmitReviewInput = {
  prNumber: LOCAL_ID,
  expectedHeadSha: HEAD_SHA,
  event: 'COMMENT',
  body: SEEDED_DRAFT.body,
  comments: [],
}

/**
 * Every member name the port DECLARES, written out as values so an assertion can
 * reach them. A key union is erased at runtime, so this list — compared by the
 * compiler against the interface's own keys — is the only thing that can notice
 * an OPTIONAL member arriving on the port, which the factory would not have to
 * set and no runtime read could see.
 */
const PORT_MEMBERS = [
  'deleteLocalDraft',
  'getLocalDraft',
  'getLocalSnapshot',
  'nextEntityId',
  'now',
  'putLocalReviewSummary',
  'putLocalSnapshot',
  'putLocalThread',
  'resolveHead',
  'session',
] as const

/**
 * `true` when two types are mutually assignable, `never` otherwise — so
 * assigning `true` to it is a compile error in every other case. The tuple
 * wrappers stop the check distributing over a union, which would let a missing
 * member pass.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

/**
 * The in-memory store every case here reads and writes through, seeded with the
 * one draft the draft-survival cases inspect.
 *
 * No snapshot is seeded by default, so `getLocalSnapshot` answers `null` — the
 * honest state of a local review that has not been synced, and the state every
 * case outside the aliasing cases below starts from. A case that needs stored
 * state passes its own seed.
 */
function makeLocalStore(options: FakeLocalStoreOptions = {}): FakeLocalStore {
  return createFakeLocalStore({ drafts: [SEEDED_DRAFT], ...options })
}

/**
 * A dependency set carrying every member of the port, with `now` set explicitly
 * so timestamps are deterministic and the key set is exact.
 *
 * The store half is the shared in-memory harness, delegated to member by member
 * rather than spread in. Spreading would carry the harness's read-backs — which
 * are not port members and must never become any — onto the port and change the
 * key set the assertions below pin. Naming each member also keeps the
 * compile-time half of that pin: a required member the port grows has to be
 * written here before this factory type-checks.
 */
function makeLocalDeps(store: FakeLocalStore = makeLocalStore()): LocalWriteDeps {
  return {
    getLocalSnapshot: (localId) => store.getLocalSnapshot(localId),
    putLocalSnapshot: (snapshot) => {
      store.putLocalSnapshot(snapshot)
    },
    putLocalThread: (localId, thread) => {
      store.putLocalThread(localId, thread)
    },
    putLocalReviewSummary: (localId, review) => {
      store.putLocalReviewSummary(localId, review)
    },
    getLocalDraft: (humanId, localId) => store.getLocalDraft(humanId, localId),
    deleteLocalDraft: (humanId, localId) => {
      store.deleteLocalDraft(humanId, localId)
    },
    session: SESSION,
    resolveHead: fixedHead(HEAD_SHA, 3),
    nextEntityId: countingEntityIds(),
    now: () => FIXED_NOW,
  }
}

/**
 * Every verb, paired with a call that supplies its own arguments. Written out
 * per verb rather than derived from the module's exports, because each verb
 * takes a different argument list and a derived list could only call them
 * reflectively — which would stop being a test of the real signatures.
 *
 * Every call here is made against the default dependencies, whose store holds a
 * draft and NO snapshot — a local review that has never been synced. None of the
 * four can succeed against that state, which is what lets the whole table be
 * driven by the draft-survival case below whatever a verb's behaviour is.
 */
const VERB_CALLS: readonly (readonly [string, (deps: LocalWriteDeps) => Promise<unknown>])[] = [
  ['submitLocalReview', (deps) => localWrites.submitLocalReview(deps, SUBMIT_INPUT)],
  [
    'replyToLocalThread',
    (deps) => localWrites.replyToLocalThread(deps, LOCAL_ID, THREAD_ID, 'Agreed, will fix.'),
  ],
  [
    'resolveLocalThread',
    (deps) => localWrites.resolveLocalThread(deps, LOCAL_ID, THREAD_ID, true),
  ],
  [
    'addLocalReaction',
    (deps) => localWrites.addLocalReaction(deps, LOCAL_ID, LOCAL_ENTITY_ID_BASE + 1, '+1'),
  ],
]

/**
 * Every verb whose behaviour is written — which is now all of them.
 *
 * Kept as a written-out list rather than dropped, because it is the thing an
 * export-coverage assertion can compare the module against: a verb added later
 * has to appear here, and appearing here is a claim that it answers rather than
 * refuses. The claim is not left as a name, though. The typed-failure case
 * below drives the whole call table and requires each verb to fail with a
 * contract error, which a verb that merely threw could not satisfy — so the
 * list states which verbs are claimed implemented and that case is what proves
 * the claim.
 */
const IMPLEMENTED_VERBS: readonly string[] = [
  'addLocalReaction',
  'replyToLocalThread',
  'resolveLocalThread',
  'submitLocalReview',
]

/**
 * Dependencies that record every document handed to storage before passing it
 * on, for the claims a read-back through this store cannot see.
 *
 * This store keeps threads as rows keyed by id and upserts them, so a snapshot
 * envelope written with the untouched threads DROPPED still reads back complete
 * — the rows for the dropped threads were simply never revisited. It is
 * faithful to the real one in that, where the envelope write and the thread
 * write are separate statements, so every claim about a REMOVAL or a
 * REPLACEMENT has to be made against what was written rather than against what
 * reads back afterwards.
 */
function capturing(store: FakeLocalStore): {
  deps: LocalWriteDeps
  rows: ReviewThread[]
  envelopes: Snapshot[]
} {
  const rows: ReviewThread[] = []
  const envelopes: Snapshot[] = []
  const base = makeLocalDeps(store)
  return {
    rows,
    envelopes,
    deps: {
      ...base,
      putLocalThread: (localId, thread) => {
        rows.push(structuredClone(thread))
        base.putLocalThread(localId, thread)
      },
      putLocalSnapshot: (snapshot) => {
        envelopes.push(structuredClone(snapshot))
        base.putLocalSnapshot(snapshot)
      },
    },
  }
}

describe('the local write port carries exactly the members it was designed with', () => {
  test('the factory constructs every member of the port and nothing else', () => {
    // Written out as a literal rather than derived from the interface, which is
    // erased at runtime and could not be read here anyway: a member added to
    // the port and set by the factory has to be added to this list too.
    expect(Object.keys(makeLocalDeps()).sort()).toEqual([
      'deleteLocalDraft',
      'getLocalDraft',
      'getLocalSnapshot',
      'nextEntityId',
      'now',
      'putLocalReviewSummary',
      'putLocalSnapshot',
      'putLocalThread',
      'resolveHead',
      'session',
    ])
  })

  test('the port declares exactly the members this file lists, optional ones included', () => {
    // The compiler does this one. `exact` only types as `true` while the port's
    // key union and the list above are mutually assignable, so a member added to
    // the interface — required OR optional — fails here until it is listed.
    const exact: MutuallyAssignable<keyof LocalWriteDeps, (typeof PORT_MEMBERS)[number]> = true
    expect(exact).toBe(true)
    // And the listed names must all be materialized by the factory, which is
    // what turns "declared" into "constructed": an optional member declared and
    // never set is caught by the pair, though neither half sees it alone.
    expect([...PORT_MEMBERS]).toEqual(Object.keys(makeLocalDeps()).sort())
  })

  test('the port has no member that could reach a GitHub client', () => {
    // Stated as a positive membership test rather than only as a total count,
    // so a member renamed into one of these names fails here and not just in
    // the count above.
    const keys = Object.keys(makeLocalDeps())
    expect(keys).not.toContain('github')
  })

  test('the port has no member that could stamp or journal a write', () => {
    // One absence per test on purpose: two absence assertions in one body let
    // the runner abort at the first, leaving the second never falsifiable.
    const keys = Object.keys(makeLocalDeps())
    expect(keys).not.toContain('writeDecorator')
  })

  test('the port has no member that could spawn a subprocess', () => {
    const keys = Object.keys(makeLocalDeps())
    expect(keys).not.toContain('runner')
  })

  test('the module exports exactly the four verbs, every one of them a function', () => {
    expect(Object.keys(localWrites).sort()).toEqual([
      'addLocalReaction',
      'replyToLocalThread',
      'resolveLocalThread',
      'submitLocalReview',
    ])
    // A value export is swept by nothing else here — a constant added beside
    // the verbs would satisfy the name list above while carrying data no
    // assertion reads.
    const notFunctions = Object.entries(localWrites)
      .filter(([, value]) => typeof value !== 'function')
      .map(([name]) => name)
    expect(notFunctions).toEqual([])
  })

  test('the verb list this file drives covers every exported verb', () => {
    // Without this, a verb could be added to the module and never called by any
    // case below, and the coverage gap would look like a green suite.
    expect(VERB_CALLS.map(([verb]) => verb).sort()).toEqual(Object.keys(localWrites).sort())
  })

  test('every exported verb is claimed implemented, and none is left unclassified', () => {
    // The list has to cover the export list exactly, in both directions. A verb
    // added to the module and left off the list would be driven by the call
    // table above and claimed by nothing; a name on the list that no longer
    // names an export would let the claim outlive the verb it was about.
    expect([...IMPLEMENTED_VERBS].sort()).toEqual(Object.keys(localWrites).sort())
  })
})

describe('no verb answers for a local review that has never been synced', () => {
  test('every verb fails with a typed contract failure rather than a value or a bare throw', async () => {
    // Collected and compared in one shot rather than asserted inside the loop:
    // an assertion per iteration stops at the first failure, so a verb that
    // started answering would hide every verb after it in the table.
    //
    // The failure is required to be TYPED, and that is the standing proof that
    // every verb's behaviour is written. A verb with nothing to answer has only
    // one honest move left — refuse — and a refusal is a bare internal throw,
    // not a contract failure a transport can map to a status. So a verb that
    // stopped answering could not reach green by throwing: it would have to
    // claim a contract code it has no right to.
    const outcomes = await Promise.all(
      VERB_CALLS.map(async ([verb, call]) => {
        const failure = await call(makeLocalDeps()).then(
          () => null,
          (error: unknown) => error,
        )
        return [verb, failure instanceof ApiError] as const
      }),
    )
    expect(outcomes).toEqual(VERB_CALLS.map(([verb]) => [verb, true] as const))
  })

  test('submitting one names the missing snapshot and the fix, and keeps the draft', async () => {
    // The submit half of the case above, stated for the one verb whose failure
    // here is a product answer rather than an unwritten body: the threads a
    // submit creates are carried by the snapshot, so with no snapshot there is
    // nowhere for them to land and nothing to compare the quoted head against.
    const deps = makeLocalDeps()
    const before = deps.getLocalDraft(SESSION.human.id, LOCAL_ID)
    expect(before).not.toBeNull()
    const failure = await localWrites.submitLocalReview(deps, SUBMIT_INPUT).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).code).toBe('unprocessable')
    expect((failure as ApiError).message).toContain('sync it')
    const after = deps.getLocalDraft(SESSION.human.id, LOCAL_ID)
    // Byte-identical, not merely present: a draft silently rewritten by a
    // failed write loses the reviewer's text just as thoroughly as a deleted
    // one, and only the serialized comparison catches that.
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  test('every verb leaves the draft byte-identical when it fails', async () => {
    // The whole table, not one verb: a draft is the reviewer's unsent text, and
    // no verb that could not do its work may cost them any of it. Collected
    // before comparing so a verb that started rewriting the draft is named
    // rather than aborting the run before the verbs after it are exercised.
    const outcomes = await Promise.all(
      VERB_CALLS.map(async ([verb, call]) => {
        const deps = makeLocalDeps()
        const before = deps.getLocalDraft(SESSION.human.id, LOCAL_ID)
        await call(deps).then(
          () => null,
          () => null,
        )
        const after = deps.getLocalDraft(SESSION.human.id, LOCAL_ID)
        // Byte-identical, not merely present: a draft silently rewritten by a
        // failed write loses the reviewer's text just as thoroughly as a
        // deleted one, and only the serialized comparison catches that.
        return [verb, before !== null, JSON.stringify(after) === JSON.stringify(before)] as const
      }),
    )
    expect(outcomes).toEqual(VERB_CALLS.map(([verb]) => [verb, true, true] as const))
  })
})

/**
 * Submitting a local review: what it materializes, what it must never write, and
 * what it does to the reviewer's draft on each of its outcomes.
 *
 * The three failures this suite is built around are the three that cost the
 * reviewer something real. A submit that answers success while storing nothing
 * is the worst of them — the client reads success as permission to clear the
 * draft and to re-read the review expecting the new threads, so the text is
 * deleted and nothing appears in its place — which is why every case here reads
 * the state back through the store rather than believing the returned value. A
 * submit that stamps the author's name into a body puts an identity into text
 * that is meant to be carried as a key beside it. And a submit that appends its
 * summary to the snapshot's submitted-review list falsifies the emptiness
 * several read surfaces are built on.
 *
 * Two of those are assertions about something NOT being present, and an absence
 * that is satisfied by today's fixtures regardless of the code is a recorded
 * green that measures nothing. Each is therefore paired with a control that
 * fires on the value the defect would produce — the real stamped body the
 * broker's stamper builds, and a user carrying the reviewer's address — so the
 * pattern doing the banning is known to discriminate rather than assumed to.
 */
describe('submitting a local review materializes it before it touches the draft', () => {
  const PATH_ONE = 'src/retry.ts'
  const PATH_TWO = 'src/queue.ts'
  const MOVED_SHA = 'c'.repeat(40)
  const SUMMARY_BODY = 'Two things worth another look before this goes anywhere.'
  const FIRST_BODY = 'This retries on a 4xx too, which will never succeed.'
  const SECOND_BODY = 'The queue drains on shutdown but nothing awaits the drain.'

  /** The prior state a review that already carries a thread starts from. */
  const PRIOR_THREAD_ID = `local:${LOCAL_ID}:${LOCAL_ENTITY_ID_BASE - 1}`
  const PRIOR_COMMENT_ID = LOCAL_ENTITY_ID_BASE - 1
  const PRIOR_AUTHOR_ID = 'wren.abbot@example.test'

  const pending = (seed: {
    key: string
    path: string
    line: number
    body: string
    startLine?: number | null
    side?: 'LEFT' | 'RIGHT'
    startSide?: 'LEFT' | 'RIGHT' | null
  }): PendingComment => ({
    key: seed.key,
    path: seed.path,
    side: seed.side ?? 'RIGHT',
    start_side: seed.startSide ?? null,
    line: seed.line,
    start_line: seed.startLine ?? null,
    body: seed.body,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    anchor: { lineText: `line ${seed.line}`, contextBefore: [], contextAfter: [] },
  })

  /**
   * Two pending comments differing in every anchoring field a materialized
   * thread carries, so a verb that copied one comment's anchor onto both, or
   * defaulted a field instead of reading it, cannot pass.
   */
  const TWO_COMMENTS: readonly PendingComment[] = [
    pending({ key: 'one', path: PATH_ONE, line: 12, body: FIRST_BODY }),
    pending({
      key: 'two',
      path: PATH_TWO,
      line: 40,
      startLine: 37,
      side: 'LEFT',
      startSide: 'LEFT',
      body: SECOND_BODY,
    }),
  ]

  const submitInput = (over: Partial<SubmitReviewInput> = {}): SubmitReviewInput => ({
    prNumber: LOCAL_ID,
    expectedHeadSha: HEAD_SHA,
    event: 'COMMENT',
    body: SUMMARY_BODY,
    comments: [...TWO_COMMENTS],
    ...over,
  })

  /** A synced local review with no threads yet: the state a first submit starts from. */
  const syncedSnapshot = (): Snapshot =>
    localSnapshot({
      localId: LOCAL_ID,
      headSha: HEAD_SHA,
      at: FIXED_NOW,
      mergeBaseSha: BASE_SHA,
      paths: [PATH_ONE, PATH_TWO],
    })

  const syncedStore = (options: FakeLocalStoreOptions = {}): FakeLocalStore =>
    makeLocalStore({ snapshots: [syncedSnapshot()], ...options })

  /** A synced review that already carries one thread, written by somebody else. */
  const withPriorThread = (): FakeLocalStore =>
    makeLocalStore({
      snapshots: [
        localSnapshot({
          localId: LOCAL_ID,
          headSha: HEAD_SHA,
          at: FIXED_NOW,
          mergeBaseSha: BASE_SHA,
          paths: [PATH_ONE, PATH_TWO],
          threads: [{ id: PRIOR_THREAD_ID, path: PATH_ONE, comments: [{ id: PRIOR_COMMENT_ID }] }],
          commentAuthors: { [PRIOR_COMMENT_ID]: PRIOR_AUTHOR_ID },
        }),
      ],
    })

  /** The stored snapshot, or a loud failure — a null read would make every case below vacuous. */
  const stored = (store: FakeLocalStore): Snapshot => {
    const held = store.getLocalSnapshot(LOCAL_ID)
    if (held === null) throw new Error('no snapshot is stored for the local review under test')
    return held
  }

  /** Every comment of every thread the stored snapshot carries, thread order preserved. */
  const storedComments = (store: FakeLocalStore): ReviewComment[] =>
    stored(store).mutable.threads.flatMap((thread) => thread.comments)

  const submitOk = async (
    deps: LocalWriteDeps,
    input: SubmitReviewInput = submitInput(),
  ): Promise<ReviewSummary> => {
    const result = await localWrites.submitLocalReview(deps, input)
    if (result.status !== 'ok') {
      throw new Error(`the submit answered '${result.status}' where 'ok' was required`)
    }
    return result.review
  }

  const draft = (deps: LocalWriteDeps): ReviewDraft | null =>
    deps.getLocalDraft(SESSION.human.id, LOCAL_ID)

  describe('what a successful submit materializes', () => {
    test('two pending comments become two threads the NEXT snapshot read already carries', async () => {
      const store = syncedStore()
      await submitOk(makeLocalDeps(store))
      // Read back through the store, which hands out clones, so this is the
      // persisted state and not the object the write was built from.
      const threads = stored(store).mutable.threads
      expect(threads).toHaveLength(2)
      expect(threads.map((thread) => thread.comments.length)).toEqual([1, 1])
      expect(threads.flatMap((thread) => thread.comments.map((c) => c.body))).toEqual([
        FIRST_BODY,
        SECOND_BODY,
      ])
    })

    test('every created id is positive, inside the local band, and distinct', async () => {
      const store = syncedStore()
      const review = await submitOk(makeLocalDeps(store))
      const commentIds = storedComments(store).map((comment) => comment.id)
      // Pinned first: every clause below is vacuously true over an empty list.
      expect(commentIds).toHaveLength(2)
      const minted = [review.id, ...commentIds]
      expect(new Set(minted).size).toBe(minted.length)
      expect(minted.filter((id) => id <= 0)).toEqual([])
      expect(minted.filter((id) => id < LOCAL_ENTITY_ID_BASE)).toEqual([])
      expect(minted.filter((id) => !Number.isSafeInteger(id))).toEqual([])
    })

    test('each thread is named for the review it belongs to and its own root comment', async () => {
      const store = syncedStore()
      await submitOk(makeLocalDeps(store))
      const threads = stored(store).mutable.threads
      expect(threads).toHaveLength(2)
      // Derived from the ids actually minted rather than written out, so the
      // case pins the COMPOSITION and not one run's allocator sequence.
      expect(threads.map((thread) => thread.id)).toEqual(
        threads.map((thread) => `local:${LOCAL_ID}:${thread.comments[0]?.id}`),
      )
      // A thread id travels as one URL path segment; a separator inside one
      // turns a path into a longer path that matches no route.
      expect(threads.filter((thread) => thread.id.includes('/'))).toEqual([])
    })

    test('each thread carries its own pending comment’s anchor, not a shared default', async () => {
      const store = syncedStore()
      await submitOk(makeLocalDeps(store))
      const threads = stored(store).mutable.threads
      const anchors = threads.map((thread) => ({
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        startLine: thread.startLine,
        originalStartLine: thread.originalStartLine,
        diffSide: thread.diffSide,
        startDiffSide: thread.startDiffSide,
        subjectType: thread.subjectType,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        resolvedBy: thread.resolvedBy,
      }))
      expect(anchors).toEqual([
        {
          path: PATH_ONE,
          line: 12,
          originalLine: 12,
          startLine: null,
          originalStartLine: null,
          diffSide: 'RIGHT',
          startDiffSide: null,
          subjectType: 'LINE',
          isResolved: false,
          isOutdated: false,
          resolvedBy: null,
        },
        {
          path: PATH_TWO,
          line: 40,
          originalLine: 40,
          startLine: 37,
          originalStartLine: 37,
          diffSide: 'LEFT',
          startDiffSide: 'LEFT',
          subjectType: 'LINE',
          isResolved: false,
          isOutdated: false,
          resolvedBy: null,
        },
      ])
    })

    test('each comment is bound to the review that created it and to the guarded head', async () => {
      const store = syncedStore()
      const review = await submitOk(makeLocalDeps(store))
      const comments = storedComments(store)
      expect(comments).toHaveLength(2)
      expect(comments.map((comment) => comment.pull_request_review_id)).toEqual([
        review.id,
        review.id,
      ])
      expect(comments.map((comment) => comment.commit_id)).toEqual([HEAD_SHA, HEAD_SHA])
      expect(comments.map((comment) => comment.original_commit_id)).toEqual([HEAD_SHA, HEAD_SHA])
      expect(review.commit_id).toBe(HEAD_SHA)
    })

    test('each comment is complete, field by field, and points at no remote resource', async () => {
      // Written out whole rather than field-sampled. A comment is handed to the
      // client as-is and every field it carries is read somewhere, so a field
      // left at a plausible-looking default — a side, a subject type, a hunk
      // that does not name the line it belongs to — is a rendering defect this
      // sampling would otherwise have to anticipate one field at a time. Only
      // the two minted names are read back off the value; everything else is
      // stated.
      const store = syncedStore()
      const review = await submitOk(makeLocalDeps(store))
      const comments = storedComments(store)
      const [first, second] = comments
      if (first === undefined || second === undefined) {
        throw new Error('the submit did not materialize two comments to compare')
      }
      const author = {
        login: SESSION.human.name,
        id: 0,
        node_id: 'local:user',
        avatar_url: '',
        html_url: '',
        type: 'Bot' as const,
      }
      const noReactions = {
        url: '',
        total_count: 0,
        '+1': 0,
        '-1': 0,
        laugh: 0,
        hooray: 0,
        confused: 0,
        heart: 0,
        rocket: 0,
        eyes: 0,
      }
      expect(comments).toEqual([
        {
          id: first.id,
          node_id: `local:comment:${first.id}`,
          pull_request_review_id: review.id,
          path: PATH_ONE,
          diff_hunk: '@@ -12,1 +12,1 @@',
          commit_id: HEAD_SHA,
          original_commit_id: HEAD_SHA,
          line: 12,
          original_line: 12,
          start_line: null,
          original_start_line: null,
          side: 'RIGHT',
          start_side: null,
          subject_type: 'line',
          user: author,
          body: FIRST_BODY,
          created_at: FIXED_NOW,
          updated_at: FIXED_NOW,
          reactions: noReactions,
          html_url: '',
        },
        {
          id: second.id,
          node_id: `local:comment:${second.id}`,
          pull_request_review_id: review.id,
          path: PATH_TWO,
          diff_hunk: '@@ -40,1 +40,1 @@',
          commit_id: HEAD_SHA,
          original_commit_id: HEAD_SHA,
          line: 40,
          original_line: 40,
          start_line: 37,
          original_start_line: 37,
          side: 'LEFT',
          start_side: 'LEFT',
          subject_type: 'line',
          user: author,
          body: SECOND_BODY,
          created_at: FIXED_NOW,
          updated_at: FIXED_NOW,
          reactions: noReactions,
          html_url: '',
        },
      ])
      expect(first.node_id).not.toBe(second.node_id)
    })

    test('the summary records the verdict, and every verdict is allowed', async () => {
      const verdicts: readonly SubmitReviewInput['event'][] = [
        'COMMENT',
        'APPROVE',
        'REQUEST_CHANGES',
      ]
      const states = await Promise.all(
        verdicts.map(async (event) => {
          const review = await submitOk(
            makeLocalDeps(syncedStore()),
            submitInput({ event, comments: [] }),
          )
          return review.state
        }),
      )
      // Asked as one comparison so an event that started being refused shows up
      // as a named difference rather than aborting the case at the first one.
      expect(states).toEqual(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED'])
    })

    test('a submit onto a review that already has threads keeps the ones already there', async () => {
      const store = withPriorThread()
      await submitOk(makeLocalDeps(store))
      const threads = stored(store).mutable.threads
      expect(threads).toHaveLength(3)
      expect(threads[0]?.id).toBe(PRIOR_THREAD_ID)
      // The prior authorship entry survives too: a map replaced rather than
      // merged would orphan every comment written before this submit.
      expect(stored(store).mutable.commentAuthors?.[PRIOR_COMMENT_ID]).toBe(PRIOR_AUTHOR_ID)
    })

    test('the snapshot handed to storage carries the prior threads as well as the new ones', async () => {
      // Asserted on the envelope the sink WRITES rather than on the one a later
      // read returns, and the difference was measured: this store keeps threads
      // as rows keyed by id and upserts them, so an envelope written with the
      // prior threads dropped still reads back complete — the row for the
      // dropped thread was simply never touched. Every assertion phrased as
      // "read it back afterwards" is blind to that, and on a store that treats
      // a snapshot write as the whole truth it is silent data loss.
      const store = withPriorThread()
      const written: Snapshot[] = []
      const deps: LocalWriteDeps = {
        ...makeLocalDeps(store),
        putLocalSnapshot: (snapshot) => {
          written.push(structuredClone(snapshot))
          store.putLocalSnapshot(snapshot)
        },
      }
      await submitOk(deps)
      expect(written).toHaveLength(1)
      const envelope = written[0]
      if (envelope === undefined) throw new Error('no snapshot was handed to storage')
      expect(envelope.mutable.threads.map((thread) => thread.id.startsWith('local:'))).toEqual([
        true,
        true,
        true,
      ])
      expect(envelope.mutable.threads[0]?.id).toBe(PRIOR_THREAD_ID)
      expect(envelope.mutable.threads).toHaveLength(3)
      expect(envelope.mutable.commentAuthors?.[PRIOR_COMMENT_ID]).toBe(PRIOR_AUTHOR_ID)
    })

    test('the draft is gone once the submit has confirmed', async () => {
      const deps = makeLocalDeps(syncedStore())
      expect(draft(deps)).not.toBeNull()
      await submitOk(deps)
      expect(draft(deps)).toBeNull()
    })
  })

  describe('authorship is recorded as a key beside every comment', () => {
    test('every created comment id maps to the writing human, not merely the first', async () => {
      const store = syncedStore()
      await submitOk(makeLocalDeps(store))
      const ids = storedComments(store).map((comment) => comment.id)
      expect(ids).toHaveLength(2)
      const authors = stored(store).mutable.commentAuthors ?? {}
      // Mapped over the ids rather than sampled: a map carrying only the first
      // id yields `undefined` in the second slot and this comparison names it.
      expect(ids.map((id) => authors[id])).toEqual([SESSION.human.id, SESSION.human.id])
    })

    test('nothing else is attributed, and the key is the human id rather than a display name', async () => {
      const store = syncedStore()
      await submitOk(makeLocalDeps(store))
      const ids = storedComments(store).map((comment) => comment.id)
      const authors = stored(store).mutable.commentAuthors ?? {}
      expect(Object.keys(authors).map(Number).sort()).toEqual([...ids].sort((a, b) => a - b))
      // The map's values are the one place the address legitimately appears —
      // the contract states they are never rendered into a body — so this is
      // the positive half of the "no address in a body" cases below.
      expect(Object.values(authors)).toEqual([SESSION.human.id, SESSION.human.id])
      expect(SESSION.human.id).not.toBe(SESSION.human.name)
    })
  })

  describe('no body is stamped with the author’s name', () => {
    const STAMPED = /^\*\*.+\*\*/

    test('the stamp pattern matches a really stamped body and not an unstamped one', () => {
      // The control. Built with the same function the mediated write path
      // stamps with, so the pattern is measured against the exact text the
      // defect would produce rather than against a hand-written imitation.
      expect(prefixBody(SESSION.human, FIRST_BODY)).toContain(SESSION.human.name)
      expect(STAMPED.test(prefixBody(SESSION.human, FIRST_BODY))).toBe(true)
      expect(STAMPED.test(FIRST_BODY)).toBe(false)
    })

    test('no materialized body carries a stamp', async () => {
      const store = syncedStore()
      const review = await submitOk(makeLocalDeps(store))
      const bodies = [review.body, ...storedComments(store).map((comment) => comment.body)]
      expect(bodies).toHaveLength(3)
      expect(bodies.filter((body) => STAMPED.test(body))).toEqual([])
    })

    test('every body is stored exactly as it was written', async () => {
      // The positive half, and the stronger statement: an absence assertion
      // alone is satisfied by any rewriting that happens not to look like a
      // stamp, while this one fails on a body altered in any way at all.
      const store = syncedStore()
      const review = await submitOk(makeLocalDeps(store))
      expect(review.body).toBe(SUMMARY_BODY)
      expect(storedComments(store).map((comment) => comment.body)).toEqual([
        FIRST_BODY,
        SECOND_BODY,
      ])
    })
  })

  describe('the synthesized author carries a name and nothing else', () => {
    const users = async (): Promise<GhUser[]> => {
      const store = syncedStore()
      const review = await submitOk(makeLocalDeps(store))
      return [review.user, ...storedComments(store).map((comment) => comment.user)]
    }

    test('an address in a user is exactly what this check would catch', () => {
      // The control. The reviewer's own key IS an address, so a sink that put
      // it anywhere in the author would be caught — which is what makes the
      // absence below a measurement rather than a coincidence of fixtures.
      expect(SESSION.human.id).toContain('@')
      expect(JSON.stringify({ ...SEEDED_AUTHOR, login: SESSION.human.id })).toContain('@')
      expect(JSON.stringify(SEEDED_AUTHOR)).not.toContain('@')
    })

    test('no created author serializes to anything containing an address', async () => {
      const serialized = (await users()).map((user) => JSON.stringify(user))
      expect(serialized).toHaveLength(3)
      expect(serialized.filter((json) => json.includes('@'))).toEqual([])
    })

    test('the reviewer’s address reaches the authorship map and nothing else', async () => {
      // Wider than the author check above and not implied by it: this sweeps
      // every document the submit created, so an address reaching a body, a
      // minted name or a hunk fails here even though the author itself is
      // clean. The authorship map is asserted to carry it, which is both the
      // control — proving the address really is in the state being swept, so
      // the absences elsewhere are measurements and not a fixture accident —
      // and the positive statement of where it is allowed to be: a key, whose
      // values the contract states are never rendered as text.
      const store = syncedStore()
      const review = await submitOk(makeLocalDeps(store))
      const created = JSON.stringify({ review, threads: stored(store).mutable.threads })
      expect(JSON.stringify(stored(store).mutable.commentAuthors)).toContain(SESSION.human.id)
      expect(created).not.toContain(SESSION.human.id)
    })

    test('nothing the submit created carries an address of any kind, hunk headers aside', async () => {
      // The categorical form of the case above — it catches an address that is
      // not this session's — and its own case rather than a second assertion in
      // that one: two absence assertions in one body let the runner abort at
      // the first, leaving the second never proven able to fail.
      //
      // Hunk headers are excluded BY NAME, and that exclusion is a measured
      // necessity rather than a convenience: a unified-diff header is spelled
      // with the same character an address is, so a sweep including them can
      // never be green and would have to be deleted rather than fixed. Every
      // other field stays in scope, and the address-specific sweep above keeps
      // covering the hunks themselves.
      const store = syncedStore()
      const review = await submitOk(makeLocalDeps(store))
      const withoutHunks = JSON.stringify(
        { review, threads: stored(store).mutable.threads },
        (key, value: unknown) => (key === 'diff_hunk' ? undefined : value),
      )
      expect(withoutHunks).not.toContain('@')
    })

    test('the hunk exclusion above is narrow enough to leave an address visible', () => {
      // The control for that exclusion. Dropping a field from a sweep is how a
      // sweep quietly stops covering anything, so what is dropped is shown to
      // be exactly the header and not the document around it.
      const swept = JSON.stringify(
        { diff_hunk: '@@ -1,1 +1,1 @@', body: 'reach me at nobody@example.test' },
        (key, value: unknown) => (key === 'diff_hunk' ? undefined : value),
      )
      expect(swept).not.toContain('@@')
      expect(swept).toContain('@')
    })

    test('every created author is the same synthesized value, field by field', async () => {
      // The positive half. Without it, "contains no address" is satisfied by a
      // fabricated account with a plausible login and a real profile URL, and
      // the seeded fixture author is deliberately unlike this one so a case
      // reading seeded state instead of created state cannot pass either.
      const distinct = (await users()).map((user) => JSON.stringify(user))
      expect(new Set(distinct).size).toBe(1)
      expect((await users())[0]).toEqual({
        login: SESSION.human.name,
        id: 0,
        node_id: 'local:user',
        avatar_url: '',
        html_url: '',
        type: 'Bot',
      })
      expect(SESSION.human.name).not.toBe(SEEDED_AUTHOR.login)
    })
  })

  describe('a submitted review never enters the snapshot’s timelines', () => {
    test('the persisted snapshot’s submitted-review list is still empty', async () => {
      const store = syncedStore()
      await submitOk(makeLocalDeps(store))
      expect(stored(store).mutable.reviews).toEqual([])
    })

    test('the persisted snapshot’s conversation comment list is still empty', async () => {
      // Its own case rather than a second assertion in the one above: the two
      // fail for different reasons and a shared body would let the first abort
      // before the second ever ran.
      const store = syncedStore()
      await submitOk(makeLocalDeps(store))
      expect(stored(store).mutable.issueComments).toEqual([])
    })

    test('the summary is readable from the store it was written to', async () => {
      // The other half of the pin: emptiness alone would also be satisfied by a
      // submit that recorded the summary nowhere at all.
      const store = syncedStore()
      const review = await submitOk(makeLocalDeps(store))
      const persisted = store.listLocalSubmittedReviews(LOCAL_ID)
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toEqual(review)
    })
  })

  describe('a head that has moved is answered, not thrown, and costs nothing', () => {
    test('the mismatch returns the branch’s current head as a value', async () => {
      const deps = makeLocalDeps(syncedStore())
      const result = await localWrites.submitLocalReview(
        deps,
        submitInput({ expectedHeadSha: MOVED_SHA }),
      )
      expect(result.status).toBe('head_moved')
      if (result.status !== 'head_moved') throw new Error('unreachable: status already asserted')
      expect(result.currentHeadSha).toBe(HEAD_SHA)
    })

    test('the draft is byte-identical afterwards', async () => {
      const deps = makeLocalDeps(syncedStore())
      const before = draft(deps)
      expect(before).not.toBeNull()
      await localWrites.submitLocalReview(deps, submitInput({ expectedHeadSha: MOVED_SHA }))
      expect(JSON.stringify(draft(deps))).toBe(JSON.stringify(before))
    })

    test('nothing is materialized', async () => {
      const store = syncedStore()
      await localWrites.submitLocalReview(
        makeLocalDeps(store),
        submitInput({ expectedHeadSha: MOVED_SHA }),
      )
      expect(store.listLocalThreads(LOCAL_ID)).toEqual([])
      expect(store.listLocalSubmittedReviews(LOCAL_ID)).toEqual([])
      expect(stored(store).mutable.threads).toEqual([])
    })

    test('the new-commit count is the resolved count against the stored one', async () => {
      // The seeded compare carries no commits and the resolver reports three,
      // so a count reported as a constant — zero or otherwise — fails here.
      const deps = makeLocalDeps(syncedStore())
      const result = await localWrites.submitLocalReview(
        deps,
        submitInput({ expectedHeadSha: MOVED_SHA }),
      )
      if (result.status !== 'head_moved') throw new Error('the submit did not report a moved head')
      expect(result.newCommits).toBe(3)
    })

    test('a branch reporting fewer commits than the compare holds reports none, never a negative', async () => {
      const shorter = syncedSnapshot()
      shorter.immutable.commits = [commit('1'.repeat(40)), commit('2'.repeat(40))]
      const store = makeLocalStore({ snapshots: [shorter] })
      const deps: LocalWriteDeps = { ...makeLocalDeps(store), resolveHead: fixedHead(HEAD_SHA, 1) }
      const result = await localWrites.submitLocalReview(
        deps,
        submitInput({ expectedHeadSha: MOVED_SHA }),
      )
      if (result.status !== 'head_moved') throw new Error('the submit did not report a moved head')
      expect(result.newCommits).toBe(0)
    })
  })

  describe('a storage failure keeps the draft, whichever write fails', () => {
    const STATE_WRITES: readonly LocalStoreMethod[] = [
      'putLocalThread',
      'putLocalReviewSummary',
      'putLocalSnapshot',
    ]

    for (const method of STATE_WRITES) {
      test(`a submit whose ${method} fails leaves the draft byte-identical`, async () => {
        const deps = makeLocalDeps(syncedStore({ throwOn: method }))
        const before = draft(deps)
        expect(before).not.toBeNull()
        await expect(localWrites.submitLocalReview(deps, submitInput())).rejects.toThrow(method)
        const after = draft(deps)
        expect(after).not.toBeNull()
        expect(JSON.stringify(after)).toBe(JSON.stringify(before))
      })
    }

    test('a draft deletion that fails after the review landed is reported as a storage failure', async () => {
      // The one window the ordering cannot close, asserted rather than left to
      // be discovered: the review really did land, so the answer has to say so
      // — and has to warn, because nothing here re-checks for an already
      // created review and a resubmit would materialize the comments twice.
      const store = syncedStore({ throwOn: 'deleteLocalDraft' })
      const failure = await localWrites.submitLocalReview(makeLocalDeps(store), submitInput()).then(
        () => null,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(ApiError)
      expect((failure as ApiError).code).toBe('persist_failed')
      expect(store.listLocalSubmittedReviews(LOCAL_ID)).toHaveLength(1)
      expect(store.listLocalThreads(LOCAL_ID)).toHaveLength(2)
    })
  })
})

/**
 * Answering one thread of a local review: appending a reply to it, and flipping
 * its resolution.
 *
 * Both verbs hand back a document the client copies fields STRAIGHT OUT OF into
 * its cached state, so both are asserted as whole values rather than field by
 * field. The difference is not stylistic. A resolve that rebuilds its answer
 * from parts loses whatever the rebuild does not know to fill in, and the field
 * that loses hardest is `isOutdated`: nothing here can compute it — it says
 * whether the diff has moved out from under the thread, which only a snapshot
 * built against the current head can decide — so a rebuild defaults it to false,
 * an outdated thread silently becomes current in the cache, and no error is
 * raised anywhere. A comparison against the stored thread with only the intended
 * fields changed catches that, and catches the same defect in every other field
 * at the same time; three field assertions catch only the three fields somebody
 * thought of.
 *
 * TWO CLAIMS HERE ARE ABOUT WHAT WAS WRITTEN, AND A READ-BACK CANNOT SEE THEM.
 * This store keeps threads as rows keyed by id and upserts them, so a snapshot
 * envelope written with the untouched threads DROPPED still reads back complete
 * — the rows for the dropped threads were simply never revisited. The store is
 * faithful to the real one in that, where the envelope write and the thread
 * write are separate statements, so this is a property to assert around rather
 * than a gap to close: the two cases that claim the untouched threads survive
 * capture the envelope handed to storage instead of reading state back.
 *
 * The reply cases are anchored on a thread whose own anchor DISAGREES with its
 * root comment's — a shape a real review reaches the moment a thread goes
 * outdated. Every field of a reply is derived from one of three sources, and on
 * a thread whose comments agree with it two of those three are indistinguishable;
 * on this one each field has exactly one source that could have produced it.
 */
describe('answering a thread of a local review', () => {
  const REPLY_PATH = 'src/retry.ts'
  const OUTDATED_PATH = 'src/queue.ts'
  const RANGED_PATH = 'src/backoff.ts'
  const SIBLING_PATH = 'src/pool.ts'
  const EMPTY_PATH = 'src/pump.ts'
  const THREAD_ANCHOR_PATH = 'src/thread-anchor.ts'
  const COMMENT_ANCHOR_PATH = 'src/comment-anchor.ts'

  /**
   * Seeded ids sit far above the allocator's first answer on purpose: the
   * counting allocator starts AT the band's base, so a seed placed there would
   * collide with the very first id a reply mints and the cases below could not
   * tell an appended comment from one that was already stored.
   */
  const ROOT_ID = LOCAL_ENTITY_ID_BASE + 500
  const LATER_ID = LOCAL_ENTITY_ID_BASE + 501
  const OUTDATED_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 502
  const SIBLING_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 503
  const DIVERGENT_ROOT_ID = LOCAL_ENTITY_ID_BASE + 504
  const DIVERGENT_LATER_ID = LOCAL_ENTITY_ID_BASE + 505
  const RANGED_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 507
  const ROOT_REVIEW_ID = LOCAL_ENTITY_ID_BASE + 600
  const LATER_REVIEW_ID = LOCAL_ENTITY_ID_BASE + 601
  const DIVERGENT_ROOT_REVIEW_ID = LOCAL_ENTITY_ID_BASE + 602
  const DIVERGENT_LATER_REVIEW_ID = LOCAL_ENTITY_ID_BASE + 603

  const REPLY_THREAD_ID = `local:${LOCAL_ID}:${ROOT_ID}`
  const OUTDATED_THREAD_ID = `local:${LOCAL_ID}:${OUTDATED_COMMENT_ID}`
  const SIBLING_THREAD_ID = `local:${LOCAL_ID}:${SIBLING_COMMENT_ID}`
  const EMPTY_THREAD_ID = `local:${LOCAL_ID}:${LOCAL_ENTITY_ID_BASE + 506}`
  const RANGED_THREAD_ID = `local:${LOCAL_ID}:${RANGED_COMMENT_ID}`
  const DIVERGENT_THREAD_ID = `local:${LOCAL_ID}:${DIVERGENT_ROOT_ID}`
  const UNKNOWN_THREAD_ID = `local:${LOCAL_ID}:${LOCAL_ENTITY_ID_BASE + 900}`

  /** The head the divergent thread was opened against, before the branch moved on. */
  const OLDER_SHA = 'd'.repeat(40)
  const DIVERGENT_HUNK = '@@ -98,2 +98,2 @@\n-was\n+is\n'

  const PRIOR_AUTHOR_ID = 'wren.abbot@example.test'
  const REPLY_BODY = 'Agreed — it should stop at the first 4xx rather than retrying it.'

  /** The author every local write synthesizes, written out rather than imported. */
  const LOCAL_AUTHOR: GhUser = {
    login: SESSION.human.name,
    id: 0,
    node_id: 'local:user',
    avatar_url: '',
    html_url: '',
    type: 'Bot',
  }

  const NO_REACTIONS = {
    url: '',
    total_count: 0,
    '+1': 0,
    '-1': 0,
    laugh: 0,
    hooray: 0,
    confused: 0,
    heart: 0,
    rocket: 0,
    eyes: 0,
  }

  /**
   * Reactions the divergent thread's root already carries. Non-zero so a reply
   * that handed its own rollup on from the comment it answers is a different
   * value from one that mints a fresh empty rollup — with a zeroed seed the two
   * are indistinguishable.
   */
  const ROOT_REACTIONS = { ...NO_REACTIONS, url: 'seeded-rollup', total_count: 2, '+1': 2 }

  const ON = { headSha: HEAD_SHA, at: FIXED_NOW }

  /**
   * The two threads the resolution cases work on, written out field by field
   * rather than seeded through the shorthand.
   *
   * The shorthand leaves a thread's range fields and its start side at their
   * defaults, and a claim that a resolve carries a field cannot be measured on a
   * thread whose value for it is what a rebuild would have defaulted it to
   * anyway. Between these two every field of a thread holds a value no rebuild
   * could guess: the first has gone outdated — no line in the current diff, a
   * remembered original one, a selection that began on the other side, and a
   * whole-file subject — and the second is current and carries a real
   * multi-line range, which an outdated thread cannot.
   */
  const outdatedThread = (): ReviewThread => ({
    id: OUTDATED_THREAD_ID,
    isResolved: false,
    isOutdated: true,
    path: OUTDATED_PATH,
    line: null,
    originalLine: 44,
    startLine: null,
    originalStartLine: 41,
    diffSide: 'LEFT',
    startDiffSide: 'LEFT',
    subjectType: 'FILE',
    resolvedBy: null,
    comments: localThread(
      { id: OUTDATED_THREAD_ID, path: OUTDATED_PATH, comments: [{ id: OUTDATED_COMMENT_ID }] },
      ON,
    ).comments,
  })

  const rangedThread = (): ReviewThread => ({
    id: RANGED_THREAD_ID,
    isResolved: false,
    isOutdated: false,
    path: RANGED_PATH,
    line: 12,
    originalLine: 11,
    startLine: 9,
    originalStartLine: 7,
    diffSide: 'RIGHT',
    startDiffSide: 'RIGHT',
    subjectType: 'LINE',
    resolvedBy: null,
    comments: localThread(
      { id: RANGED_THREAD_ID, path: RANGED_PATH, comments: [{ id: RANGED_COMMENT_ID }] },
      ON,
    ).comments,
  })

  /**
   * The stored state both verbs start from: one ordinary thread with two
   * comments, two threads the resolution cases flip, one bystander nothing
   * touches, and one thread holding no comment at all.
   */
  const seeded = (): Snapshot => {
    const snapshot = localSnapshot({
      localId: LOCAL_ID,
      headSha: HEAD_SHA,
      at: FIXED_NOW,
      mergeBaseSha: BASE_SHA,
      paths: [REPLY_PATH, OUTDATED_PATH, RANGED_PATH, SIBLING_PATH, EMPTY_PATH],
      commentAuthors: { [ROOT_ID]: PRIOR_AUTHOR_ID },
    })
    snapshot.mutable.threads = [
      localThread(
        {
          id: REPLY_THREAD_ID,
          path: REPLY_PATH,
          line: 12,
          comments: [
            { id: ROOT_ID, reviewId: ROOT_REVIEW_ID, body: 'This retries on a 4xx too.' },
            { id: LATER_ID, reviewId: LATER_REVIEW_ID, body: 'And the backoff never caps.' },
          ],
        },
        ON,
      ),
      outdatedThread(),
      rangedThread(),
      localThread(
        { id: SIBLING_THREAD_ID, path: SIBLING_PATH, comments: [{ id: SIBLING_COMMENT_ID }] },
        ON,
      ),
      localThread({ id: EMPTY_THREAD_ID, path: EMPTY_PATH, comments: [] }, ON),
    ]
    return snapshot
  }

  const seededStore = (): FakeLocalStore => makeLocalStore({ snapshots: [seeded()] })

  /** One thread of a freshly built seed — the comparison target, never a read of the store. */
  const seededThread = (threadId: string): ReviewThread => {
    const held = seeded().mutable.threads.find((thread) => thread.id === threadId)
    if (held === undefined) throw new Error(`the seed carries no thread ${threadId}`)
    return held
  }

  /** One thread as the store holds it now, or a loud failure. */
  const readThread = (store: FakeLocalStore, threadId: string): ReviewThread => {
    const snapshot = store.getLocalSnapshot(LOCAL_ID)
    const held = snapshot?.mutable.threads.find((thread) => thread.id === threadId)
    if (held === undefined) throw new Error(`no thread ${threadId} is stored`)
    return held
  }

  /**
   * A thread whose own anchor disagrees with its root comment's in every field
   * either could supply, opened against an earlier head and already carrying
   * reactions. Installed as a row rather than seeded, because the seed builder
   * derives a comment's location from its thread — which is the agreement this
   * fixture exists to break.
   */
  const divergentThread = (): ReviewThread => {
    const comment = (seed: {
      id: number
      reviewId: number
      line: number
      originalLine: number
      body: string
    }): ReviewComment => ({
      id: seed.id,
      node_id: `seeded-comment-${seed.id}`,
      pull_request_review_id: seed.reviewId,
      path: COMMENT_ANCHOR_PATH,
      diff_hunk: DIVERGENT_HUNK,
      commit_id: OLDER_SHA,
      original_commit_id: OLDER_SHA,
      line: seed.line,
      original_line: seed.originalLine,
      start_line: 95,
      original_start_line: 94,
      side: 'RIGHT',
      start_side: 'RIGHT',
      subject_type: 'line',
      user: SEEDED_AUTHOR,
      body: seed.body,
      created_at: FIXED_NOW,
      updated_at: FIXED_NOW,
      reactions: { ...ROOT_REACTIONS },
      html_url: '',
    })
    return {
      id: DIVERGENT_THREAD_ID,
      isResolved: false,
      isOutdated: false,
      path: THREAD_ANCHOR_PATH,
      line: 21,
      originalLine: 19,
      startLine: 17,
      originalStartLine: 15,
      diffSide: 'LEFT',
      startDiffSide: 'LEFT',
      subjectType: 'FILE',
      resolvedBy: null,
      comments: [
        comment({
          id: DIVERGENT_ROOT_ID,
          reviewId: DIVERGENT_ROOT_REVIEW_ID,
          line: 99,
          originalLine: 98,
          body: 'The comment that opened this thread, anchored unlike the thread itself.',
        }),
        comment({
          id: DIVERGENT_LATER_ID,
          reviewId: DIVERGENT_LATER_REVIEW_ID,
          line: 97,
          originalLine: 96,
          body: 'A later comment, so first-comment derivation is distinguishable from last.',
        }),
      ],
    }
  }

  const draft = (deps: LocalWriteDeps): ReviewDraft | null =>
    deps.getLocalDraft(SESSION.human.id, LOCAL_ID)

  describe('a reply lands on the thread it names and derives its fields from it', () => {
    test('the reply is minted in the positive local band and the next read carries it last', async () => {
      const store = seededStore()
      const comment = await localWrites.replyToLocalThread(
        makeLocalDeps(store),
        LOCAL_ID,
        REPLY_THREAD_ID,
        REPLY_BODY,
      )
      expect(comment.id).toBeGreaterThan(0)
      expect(comment.id).toBeGreaterThanOrEqual(LOCAL_ENTITY_ID_BASE)
      // Read back through the store, which hands out clones, so this is the
      // persisted thread and not the object the write was built from. Order is
      // asserted with it: a reply appended anywhere but the end reorders a
      // conversation nothing re-sorts.
      const stored = readThread(store, REPLY_THREAD_ID)
      expect(stored.comments.map((held) => held.id)).toEqual([ROOT_ID, LATER_ID, comment.id])
      expect(stored.comments[2]).toEqual(comment)
    })

    test('every field of the reply comes from the one source that could have produced it', async () => {
      // Whole-object rather than field-sampled, over the fixture where the
      // thread and its root disagree: the location fields are the THREAD's, the
      // two review-shaped links and the two original-state fields are the ROOT's,
      // the current commit is the resolved head's, and the range fields and the
      // rollup are neither's.
      const store = seededStore()
      store.putLocalThread(LOCAL_ID, divergentThread())
      const comment = await localWrites.replyToLocalThread(
        makeLocalDeps(store),
        LOCAL_ID,
        DIVERGENT_THREAD_ID,
        REPLY_BODY,
      )
      expect(comment).toEqual({
        id: comment.id,
        node_id: `local:comment:${comment.id}`,
        pull_request_review_id: DIVERGENT_ROOT_REVIEW_ID,
        in_reply_to_id: DIVERGENT_ROOT_ID,
        path: THREAD_ANCHOR_PATH,
        diff_hunk: DIVERGENT_HUNK,
        commit_id: HEAD_SHA,
        original_commit_id: OLDER_SHA,
        line: 21,
        original_line: 19,
        // A reply is a point on the thread's anchor, never a range: the
        // selection belongs to the comment that opened the thread, and both the
        // thread and its root carry one here so a copied range would show.
        start_line: null,
        original_start_line: null,
        side: 'LEFT',
        start_side: null,
        subject_type: 'file',
        user: LOCAL_AUTHOR,
        body: REPLY_BODY,
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
        reactions: NO_REACTIONS,
        html_url: '',
      })
    })

    test('the reply body is stored exactly as it was written', async () => {
      // The categorical statement is that no local body is ever stamped, and the
      // exact-body comparison above already implies it — an unstamped body that
      // matched the stamp pattern would have to differ from what was written.
      // It is kept as its own case with the real stamper as the control, so the
      // claim is measured against the exact text the defect would produce rather
      // than against a hand-written imitation of it.
      const store = seededStore()
      const stampable = 'Worth another look before this lands.'
      const comment = await localWrites.replyToLocalThread(
        makeLocalDeps(store),
        LOCAL_ID,
        REPLY_THREAD_ID,
        stampable,
      )
      expect(prefixBody(SESSION.human, stampable)).toContain(SESSION.human.name)
      expect(comment.body).toBe(stampable)
      expect(readThread(store, REPLY_THREAD_ID).comments[2]?.body).toBe(stampable)
    })

    test('the reply is attributed by key, and the entries already there survive', async () => {
      const store = seededStore()
      const comment = await localWrites.replyToLocalThread(
        makeLocalDeps(store),
        LOCAL_ID,
        REPLY_THREAD_ID,
        REPLY_BODY,
      )
      const snapshot = store.getLocalSnapshot(LOCAL_ID)
      // Compared whole: a map REPLACED rather than merged would carry the new
      // entry and orphan every comment written before this reply, and an
      // orphaned local comment can never be recognized as its writer's own
      // again — there is no stamped name and no forge login to fall back to.
      expect(snapshot?.mutable.commentAuthors).toEqual({
        [ROOT_ID]: PRIOR_AUTHOR_ID,
        [comment.id]: SESSION.human.id,
      })
    })

    test('the envelope handed to storage still carries every thread it did not touch', async () => {
      // Asserted on what was WRITTEN, not on what reads back. This store keeps
      // threads as rows and upserts them, so an envelope written with the other
      // threads dropped reads back complete — the dropped rows were simply never
      // revisited — and on a store that treats a snapshot write as the whole
      // truth that is silent data loss.
      const store = seededStore()
      const { deps, envelopes } = capturing(store)
      const comment = await localWrites.replyToLocalThread(
        deps,
        LOCAL_ID,
        REPLY_THREAD_ID,
        REPLY_BODY,
      )
      expect(envelopes).toHaveLength(1)
      const envelope = envelopes[0]
      if (envelope === undefined) throw new Error('no snapshot was handed to storage')
      // The whole list in one comparison, against a freshly built seed: a
      // dropped thread, a reordered list, a bystander quietly rewritten and an
      // append onto the wrong thread all fail here.
      expect(envelope.mutable.threads).toEqual(
        seeded().mutable.threads.map((thread) =>
          thread.id === REPLY_THREAD_ID
            ? { ...thread, comments: [...thread.comments, comment] }
            : thread,
        ),
      )
    })

    test('the thread row handed to storage is the whole thread with the reply appended', async () => {
      const store = seededStore()
      const { deps, rows } = capturing(store)
      const comment = await localWrites.replyToLocalThread(
        deps,
        LOCAL_ID,
        REPLY_THREAD_ID,
        REPLY_BODY,
      )
      expect(rows).toHaveLength(1)
      const stored = seededThread(REPLY_THREAD_ID)
      expect(rows[0]).toEqual({ ...stored, comments: [...stored.comments, comment] })
    })

    test('a thread id nothing has minted is a typed not-found', async () => {
      const failure = await localWrites
        .replyToLocalThread(makeLocalDeps(seededStore()), LOCAL_ID, UNKNOWN_THREAD_ID, REPLY_BODY)
        .then(
          () => null,
          (error: unknown) => error,
        )
      expect(failure).toBeInstanceOf(ApiError)
      expect((failure as ApiError).code).toBe('not_found')
      expect((failure as ApiError).message).toContain(UNKNOWN_THREAD_ID)
    })

    test('a thread holding no comment to answer is a typed not-found', async () => {
      // Its own case rather than a second assertion on the one above: the two
      // fail at different points and a shared body would let the first abort
      // before the second ran.
      const failure = await localWrites
        .replyToLocalThread(makeLocalDeps(seededStore()), LOCAL_ID, EMPTY_THREAD_ID, REPLY_BODY)
        .then(
          () => null,
          (error: unknown) => error,
        )
      expect(failure).toBeInstanceOf(ApiError)
      expect((failure as ApiError).code).toBe('not_found')
    })

    test('a reply that cannot find its thread writes nothing at all', async () => {
      const { deps, rows, envelopes } = capturing(seededStore())
      await expect(
        localWrites.replyToLocalThread(deps, LOCAL_ID, UNKNOWN_THREAD_ID, REPLY_BODY),
      ).rejects.toThrow(ApiError)
      // One comparison over both, so neither absence can abort before the other
      // has been given the chance to fail.
      expect({ rows, envelopes }).toEqual({ rows: [], envelopes: [] })
    })

    test('a successful reply leaves the reviewer’s draft byte-identical', async () => {
      // A reply is an immediate write of text the reviewer has already committed
      // to sending. The draft holds different text, for a review not yet
      // submitted, and no reply may touch it.
      const deps = makeLocalDeps(seededStore())
      const before = draft(deps)
      expect(before).not.toBeNull()
      await localWrites.replyToLocalThread(deps, LOCAL_ID, REPLY_THREAD_ID, REPLY_BODY)
      expect(JSON.stringify(draft(deps))).toBe(JSON.stringify(before))
    })
  })

  describe('a resolve changes the resolution and carries the rest of the thread', () => {
    const RESOLVED_BY = { login: SESSION.human.name }

    test('an outdated thread that is resolved still reports itself outdated', async () => {
      const returned = await localWrites.resolveLocalThread(
        makeLocalDeps(seededStore()),
        LOCAL_ID,
        OUTDATED_THREAD_ID,
        true,
      )
      // The two fields the client copies out of this answer alongside
      // `resolvedBy`. A rebuilt thread defaults the first to false and flips an
      // outdated thread back to current in the cache, with no error anywhere.
      //
      // Measured as fully SUBSUMED by the whole-thread comparison below — no
      // mutant makes this the sole red — and kept anyway as the named statement
      // of the one field this verb exists to protect, so a later edit that
      // narrows the comparison cannot take the claim with it silently.
      expect(returned.isOutdated).toBe(true)
      expect(returned.isResolved).toBe(true)
    })

    const WHOLE_THREAD_CASES: readonly (readonly [string, string])[] = [
      ['a thread the diff has moved out from under', OUTDATED_THREAD_ID],
      ['a current thread carrying a multi-line range', RANGED_THREAD_ID],
    ]

    for (const [shape, threadId] of WHOLE_THREAD_CASES) {
      test(`resolving ${shape} answers with it, changed only where it had to be`, async () => {
        // Strictly stronger than the three field assertions the client's own
        // reads would suggest: this fails on ANY field the answer lost,
        // defaulted or recomputed, including the ones nothing reads today. Run
        // over both threads because a carry claim can only be measured where the
        // stored value differs from what a rebuild would default it to, and no
        // single thread can hold a non-default value for every field: a thread
        // with no line in the current diff cannot also carry a current range.
        const returned = await localWrites.resolveLocalThread(
          makeLocalDeps(seededStore()),
          LOCAL_ID,
          threadId,
          true,
        )
        expect(returned).toEqual({
          ...seededThread(threadId),
          isResolved: true,
          resolvedBy: RESOLVED_BY,
        })
      })
    }

    test('unresolving clears the attribution and leaves everything else alone', async () => {
      const store = makeLocalStore({
        snapshots: [
          localSnapshot({
            localId: LOCAL_ID,
            headSha: HEAD_SHA,
            at: FIXED_NOW,
            mergeBaseSha: BASE_SHA,
            paths: [OUTDATED_PATH],
            threads: [
              {
                id: OUTDATED_THREAD_ID,
                path: OUTDATED_PATH,
                line: null,
                isOutdated: true,
                isResolved: true,
                resolvedBy: RESOLVED_BY,
                comments: [{ id: OUTDATED_COMMENT_ID }],
              },
            ],
          }),
        ],
      })
      const returned = await localWrites.resolveLocalThread(
        makeLocalDeps(store),
        LOCAL_ID,
        OUTDATED_THREAD_ID,
        false,
      )
      expect(returned.resolvedBy).toBeNull()
      expect(returned.isResolved).toBe(false)
      // Unresolving is the same carry obligation in the other direction, and the
      // thread it starts from is already outdated and already resolved.
      expect(returned.isOutdated).toBe(true)
    })

    test('the resolver is named by display name, never by the key their drafts are stored under', async () => {
      const returned = await localWrites.resolveLocalThread(
        makeLocalDeps(seededStore()),
        LOCAL_ID,
        OUTDATED_THREAD_ID,
        true,
      )
      // The sentinel author's own login, which locally IS the display name — and
      // demonstrably not the other name this session carries. The control is the
      // pair below it: the two really are different strings, and the one that is
      // an address is the one that must never be rendered.
      //
      // Also SUBSUMED by the whole-thread comparison, and also kept: that one
      // says the value did not change in a way it should not have, while this
      // one says what the value IS, and only this one carries the control
      // proving the address would have been caught.
      expect(returned.resolvedBy).toEqual({ login: SESSION.human.name })
      expect(SESSION.human.name).not.toBe(SESSION.human.id)
      expect(JSON.stringify(returned.resolvedBy)).not.toContain('@')
    })

    test('the next read of the thread agrees with the answer that was returned', async () => {
      const store = seededStore()
      const returned = await localWrites.resolveLocalThread(
        makeLocalDeps(store),
        LOCAL_ID,
        OUTDATED_THREAD_ID,
        true,
      )
      expect(readThread(store, OUTDATED_THREAD_ID)).toEqual(returned)
    })

    test('the envelope handed to storage still carries every thread it did not touch', async () => {
      // The write, not the read-back: threads dropped from an envelope leave
      // their rows in this store untouched, so a replaced thread list is
      // invisible to any assertion phrased as "read it back afterwards".
      const { deps, envelopes } = capturing(seededStore())
      await localWrites.resolveLocalThread(deps, LOCAL_ID, OUTDATED_THREAD_ID, true)
      expect(envelopes).toHaveLength(1)
      const envelope = envelopes[0]
      if (envelope === undefined) throw new Error('no snapshot was handed to storage')
      expect(envelope.mutable.threads).toEqual(
        seeded().mutable.threads.map((thread) =>
          thread.id === OUTDATED_THREAD_ID
            ? { ...thread, isResolved: true, resolvedBy: RESOLVED_BY }
            : thread,
        ),
      )
      // A resolve creates no comment, so it may not touch the authorship map
      // either — a map rewritten by a verb that authored nothing would drop
      // entries no later write could restore.
      expect(envelope.mutable.commentAuthors).toEqual({ [ROOT_ID]: PRIOR_AUTHOR_ID })
    })

    test('a thread id nothing has minted is a typed not-found', async () => {
      const failure = await localWrites
        .resolveLocalThread(makeLocalDeps(seededStore()), LOCAL_ID, UNKNOWN_THREAD_ID, true)
        .then(
          () => null,
          (error: unknown) => error,
        )
      expect(failure).toBeInstanceOf(ApiError)
      expect((failure as ApiError).code).toBe('not_found')
      expect((failure as ApiError).message).toContain(UNKNOWN_THREAD_ID)
    })

    test('a resolve that cannot find its thread writes nothing at all', async () => {
      const { deps, rows, envelopes } = capturing(seededStore())
      await expect(
        localWrites.resolveLocalThread(deps, LOCAL_ID, UNKNOWN_THREAD_ID, true),
      ).rejects.toThrow(ApiError)
      expect({ rows, envelopes }).toEqual({ rows: [], envelopes: [] })
    })

    test('a successful resolve leaves the reviewer’s draft byte-identical', async () => {
      const deps = makeLocalDeps(seededStore())
      const before = draft(deps)
      expect(before).not.toBeNull()
      await localWrites.resolveLocalThread(deps, LOCAL_ID, OUTDATED_THREAD_ID, true)
      expect(JSON.stringify(draft(deps))).toBe(JSON.stringify(before))
    })
  })
})

/**
 * Reacting to a comment of a local review: what comes back, what is stored, and
 * what a second identical reaction does.
 *
 * THE SEEDED ROLLUPS ARE DELIBERATELY UNEVEN, and that is what makes these
 * cases measurements rather than shapes. On a comment whose rollup is empty, a
 * verb that BUMPED the stored counts and a verb that REBUILT the rollup from
 * zero and set the one emoji it was asked for produce the same answer — and the
 * second silently destroys every reaction already on the comment. On a comment
 * whose counts are all equal, the right emoji and the wrong one are equally
 * indistinguishable. So the comment under test carries three DIFFERENT non-zero
 * counts, a fourth emoji left at zero for the cases that add one, and a rollup
 * url no rebuild would reproduce. Three fixture controls below state exactly
 * that, so the discrimination is proven rather than assumed.
 *
 * THE COMMENT UNDER TEST IS THE SECOND COMMENT OF THE SECOND THREAD, and the
 * comment beside it carries a high count on the very emoji the first-reaction
 * case adds. A verb that reacted to the thread's root instead of the comment it
 * was asked about, or that searched only the first thread, therefore fails
 * rather than passing by an accident of layout.
 *
 * THE ANSWER AND THE STORED STATE ARE ASSERTED IN SEPARATE CASES. A verb that
 * answers with the right rollup and stores nothing, and a verb that stores the
 * right rollup and answers with the old one, are different defects; either is
 * invisible to a case that checks only the other half. And the claim that the
 * review's UNTOUCHED threads survive is asserted on the envelope handed to
 * storage rather than on a later read, because this store upserts thread rows
 * and a dropped thread reads back from the row nobody revisited.
 */
describe('reacting to a comment of a local review', () => {
  const TARGET_PATH = 'src/retry.ts'
  const BYSTANDER_PATH = 'src/queue.ts'

  const BYSTANDER_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 700
  /** The root of the thread under test — deliberately not the comment reacted to. */
  const SIBLING_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 701
  const TARGET_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 702
  const UNKNOWN_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 900

  const BYSTANDER_THREAD_ID = `local:${LOCAL_ID}:${BYSTANDER_COMMENT_ID}`
  const TARGET_THREAD_ID = `local:${LOCAL_ID}:${SIBLING_COMMENT_ID}`

  const PRIOR_AUTHOR_ID = 'wren.abbot@example.test'

  /** Every emoji a rollup counts, for the fixture control that sums them. */
  const EMOJI: readonly ReactionKey[] = [
    '+1',
    '-1',
    'laugh',
    'hooray',
    'confused',
    'heart',
    'rocket',
    'eyes',
  ]

  /** The emoji the comment under test does not carry yet: a first reaction moves it. */
  const FRESH: ReactionKey = '+1'
  /** An emoji it already carries: a repeat of this one must change nothing. */
  const REPEATED: ReactionKey = 'laugh'

  /**
   * The rollup on the comment under test. Three different non-zero counts, so a
   * rebuilt rollup and a bump on the wrong emoji are both distinguishable from
   * the right answer, and a url a rebuild would blank.
   */
  const SEEDED_ROLLUP: ReactionRollup = {
    url: 'seeded-rollup-target',
    total_count: 6,
    '+1': 0,
    '-1': 1,
    laugh: 2,
    hooray: 3,
    confused: 0,
    heart: 0,
    rocket: 0,
    eyes: 0,
  }

  /**
   * What a first `FRESH` reaction must answer with: the seeded rollup with that
   * one count moved off zero and the total moved with it. Written out in full
   * rather than derived from the seed, so the expectation cannot be satisfied by
   * the same arithmetic mistake that produced the value.
   */
  const BUMPED_ROLLUP: ReactionRollup = {
    url: 'seeded-rollup-target',
    total_count: 7,
    '+1': 1,
    '-1': 1,
    laugh: 2,
    hooray: 3,
    confused: 0,
    heart: 0,
    rocket: 0,
    eyes: 0,
  }

  /**
   * The rollup on the comment BESIDE the one under test, carrying a high count
   * on exactly the emoji the first-reaction cases add. A verb that reacted to
   * the thread's root would answer five where one was required.
   */
  const SIBLING_ROLLUP: ReactionRollup = {
    ...zeroedReactions(),
    url: 'seeded-rollup-sibling',
    total_count: 4,
    '+1': 4,
  }

  /** The rollup on a comment of another thread entirely, which nothing may move. */
  const BYSTANDER_ROLLUP: ReactionRollup = {
    ...zeroedReactions(),
    url: 'seeded-rollup-bystander',
    total_count: 1,
    eyes: 1,
  }

  /**
   * Two threads, three comments, and an authorship map whose entry for the
   * comment under test names SOMEBODY ELSE. That is deliberate: a reaction
   * authors nothing, so a verb that recorded the reacting human against the
   * comment it reacted to would overwrite that entry — and it could not be seen
   * doing so on a comment this session had written, where the entry it wrote
   * would be the entry already there.
   */
  const seeded = (): Snapshot =>
    localSnapshot({
      localId: LOCAL_ID,
      headSha: HEAD_SHA,
      at: FIXED_NOW,
      mergeBaseSha: BASE_SHA,
      paths: [TARGET_PATH, BYSTANDER_PATH],
      commentAuthors: {
        [SIBLING_COMMENT_ID]: SESSION.human.id,
        [TARGET_COMMENT_ID]: PRIOR_AUTHOR_ID,
      },
      threads: [
        {
          id: BYSTANDER_THREAD_ID,
          path: BYSTANDER_PATH,
          comments: [{ id: BYSTANDER_COMMENT_ID, reactions: { ...BYSTANDER_ROLLUP } }],
        },
        {
          id: TARGET_THREAD_ID,
          path: TARGET_PATH,
          comments: [
            { id: SIBLING_COMMENT_ID, reactions: { ...SIBLING_ROLLUP } },
            { id: TARGET_COMMENT_ID, reactions: { ...SEEDED_ROLLUP } },
          ],
        },
      ],
    })

  const seededStore = (): FakeLocalStore => makeLocalStore({ snapshots: [seeded()] })

  /** One comment of a freshly built seed — the comparison target, never a read of the store. */
  const seededComment = (commentId: number): ReviewComment => {
    const held = seeded()
      .mutable.threads.flatMap((thread) => thread.comments)
      .find((comment) => comment.id === commentId)
    if (held === undefined) throw new Error(`the seed carries no comment ${commentId}`)
    return held
  }

  /** One comment as the store holds it now, or a loud failure. */
  const storedComment = (store: FakeLocalStore, commentId: number): ReviewComment => {
    const held = store
      .getLocalSnapshot(LOCAL_ID)
      ?.mutable.threads.flatMap((thread) => thread.comments)
      .find((comment) => comment.id === commentId)
    if (held === undefined) throw new Error(`no comment ${commentId} is stored`)
    return held
  }

  const react = (
    deps: LocalWriteDeps,
    reaction: ReactionKey = FRESH,
    commentId: number = TARGET_COMMENT_ID,
  ): Promise<ReactionRollup> => localWrites.addLocalReaction(deps, LOCAL_ID, commentId, reaction)

  describe('the seeded rollup discriminates the defects these cases are about', () => {
    test('a rollup rebuilt from zero is not the rollup a bump produces', () => {
      // The control that decides whether the cases below measure anything. With
      // an empty seed these two values are identical, and a verb that discarded
      // every reaction already on the comment would be indistinguishable from
      // one that carried them.
      expect({ ...zeroedReactions(), '+1': 1, total_count: 1 }).not.toEqual(BUMPED_ROLLUP)
    })

    test('a bump on the wrong emoji is not the rollup a bump on the right one produces', () => {
      // Its own case rather than a second assertion above: two comparisons in
      // one body let the runner abort at the first, leaving the second never
      // shown able to fail. The emoji chosen here starts at zero, exactly as the
      // right one does, so the two differ only in WHICH count moved.
      expect({ ...SEEDED_ROLLUP, heart: 1, total_count: 7 }).not.toEqual(BUMPED_ROLLUP)
    })

    test('both rollups carry a total that is the sum of their counts', () => {
      // A seed whose total disagreed with its counts would let a verb that
      // reported a wrong total look right, since the expectation would carry the
      // same inconsistency. Stated over both so the bump is honest too.
      const totals = [SEEDED_ROLLUP, BUMPED_ROLLUP].map((rollup) => [
        EMOJI.reduce((sum, key) => sum + rollup[key], 0),
        rollup.total_count,
      ])
      expect(totals).toEqual([
        [6, 6],
        [7, 7],
      ])
    })
  })

  describe('a first reaction moves one count and stores what it answered', () => {
    test('the answer is the whole bumped rollup, every other count carried', async () => {
      const returned = await react(makeLocalDeps(seededStore()))
      // Whole-object rather than a check on `total_count`: a rollup rebuilt from
      // zero and a rollup bumped on the wrong emoji both carry the right total.
      expect(returned).toEqual(BUMPED_ROLLUP)
    })

    test('the stored comment carries the rollup that was answered with', async () => {
      // Its own case, and the half a return-value assertion cannot see: a verb
      // that computed the right rollup and never persisted it answers correctly
      // and loses the reaction on the next read.
      const store = seededStore()
      await react(makeLocalDeps(store))
      expect(storedComment(store, TARGET_COMMENT_ID).reactions).toEqual(BUMPED_ROLLUP)
    })

    test('nothing about the comment other than its rollup changes', async () => {
      // Compared against a freshly built seed with only the rollup swapped, so
      // a body, an anchor or an author quietly rewritten by the reaction fails
      // here rather than waiting to be noticed in a render.
      const store = seededStore()
      await react(makeLocalDeps(store))
      expect(storedComment(store, TARGET_COMMENT_ID)).toEqual({
        ...seededComment(TARGET_COMMENT_ID),
        reactions: BUMPED_ROLLUP,
      })
    })

    test('no other comment’s rollup moves, in its thread or in another', async () => {
      const store = seededStore()
      await react(makeLocalDeps(store))
      // One comparison over both, so neither can abort before the other has
      // been given the chance to fail. The sibling is the load-bearing half:
      // it carries a count on the same emoji this reaction added.
      expect([
        storedComment(store, SIBLING_COMMENT_ID).reactions,
        storedComment(store, BYSTANDER_COMMENT_ID).reactions,
      ]).toEqual([SIBLING_ROLLUP, BYSTANDER_ROLLUP])
    })

    test('the envelope handed to storage still carries every thread it did not touch', async () => {
      // Asserted on what was WRITTEN, not on what reads back: threads dropped
      // from an envelope leave their rows in this store untouched, so a replaced
      // thread list is invisible to any assertion phrased as "read it back
      // afterwards" and is silent data loss on a store that treats a snapshot
      // write as the whole truth.
      const { deps, envelopes } = capturing(seededStore())
      await react(deps)
      expect(envelopes).toHaveLength(1)
      const envelope = envelopes[0]
      if (envelope === undefined) throw new Error('no snapshot was handed to storage')
      expect(envelope.mutable.threads).toEqual(
        seeded().mutable.threads.map((thread) => ({
          ...thread,
          comments: thread.comments.map((comment) =>
            comment.id === TARGET_COMMENT_ID ? { ...comment, reactions: BUMPED_ROLLUP } : comment,
          ),
        })),
      )
    })

    test('a reaction authors no comment, so the authorship map is carried through whole', async () => {
      // Its own case: a map REPLACED rather than carried would orphan every
      // comment written before this reaction, and an orphaned local comment can
      // never be recognized as its writer's own again — there is no stamped name
      // and no forge login to fall back to.
      const { deps, envelopes } = capturing(seededStore())
      await react(deps)
      const envelope = envelopes[0]
      if (envelope === undefined) throw new Error('no snapshot was handed to storage')
      expect(envelope.mutable.commentAuthors).toEqual({
        [SIBLING_COMMENT_ID]: SESSION.human.id,
        [TARGET_COMMENT_ID]: PRIOR_AUTHOR_ID,
      })
    })

    test('a second emoji on the same comment adds to the counts already there', async () => {
      // The dedup below is per emoji, not per comment. Without this case, a verb
      // that treated any reaction after the first as a repeat would still pass
      // every other case here.
      const deps = makeLocalDeps(seededStore())
      await react(deps)
      const returned = await react(deps, 'heart')
      expect(returned).toEqual({ ...BUMPED_ROLLUP, heart: 1, total_count: 8 })
    })

    test('the reviewer’s draft is byte-identical afterwards', async () => {
      const deps = makeLocalDeps(seededStore())
      const before = deps.getLocalDraft(SESSION.human.id, LOCAL_ID)
      expect(before).not.toBeNull()
      await react(deps)
      expect(JSON.stringify(deps.getLocalDraft(SESSION.human.id, LOCAL_ID))).toBe(
        JSON.stringify(before),
      )
    })
  })

  describe('a repeat of a reaction already on the comment changes nothing', () => {
    test('the answer is the stored rollup, unchanged', async () => {
      // Honest idempotence, not a stale answer. A reaction is per account rather
      // than per press: there is exactly one author on a local review, so a
      // second identical one has nothing to add, and the client overwrites its
      // optimistic rollup with whatever comes back — so an unchanged answer
      // reconciles silently instead of reading as a lost write.
      //
      // On its own this case is also satisfied by a verb that never bumps
      // anything at all. What rules that out is the first-reaction case above,
      // which moves a count on the SAME comment through the SAME call: the two
      // together say the verb changes a count when there is one to change and
      // leaves it alone when there is not.
      const returned = await react(makeLocalDeps(seededStore()), REPEATED)
      expect(returned).toEqual(SEEDED_ROLLUP)
    })

    test('nothing at all is handed to storage', async () => {
      const { deps, rows, envelopes } = capturing(seededStore())
      await react(deps, REPEATED)
      // One comparison over both, so neither absence can abort before the other
      // has been given the chance to fail.
      expect({ rows, envelopes }).toEqual({ rows: [], envelopes: [] })
    })

    test('reacting twice answers the second time with what the first reaction stored', async () => {
      // The dedup measured ACROSS a write rather than against the seed: the
      // second call reads the state the first one persisted, so a verb that
      // stored nothing would answer a count of one twice with an empty store
      // behind it, and one that double-counted would answer two.
      const deps = makeLocalDeps(seededStore())
      const first = await react(deps)
      const second = await react(deps)
      expect([first, second]).toEqual([BUMPED_ROLLUP, BUMPED_ROLLUP])
    })
  })

  describe('a comment id that names nothing is a typed not-found', () => {
    test('the failure carries the contract code and names the id', async () => {
      const failure = await react(makeLocalDeps(seededStore()), FRESH, UNKNOWN_COMMENT_ID).then(
        () => null,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(ApiError)
      expect((failure as ApiError).code).toBe('not_found')
      expect((failure as ApiError).message).toContain(String(UNKNOWN_COMMENT_ID))
    })

    test('a reaction that cannot find its comment writes nothing at all', async () => {
      const { deps, rows, envelopes } = capturing(seededStore())
      await expect(react(deps, FRESH, UNKNOWN_COMMENT_ID)).rejects.toThrow(ApiError)
      expect({ rows, envelopes }).toEqual({ rows: [], envelopes: [] })
    })

    test('an id that names a comment of the thread’s own review is found, so the id is what decides', async () => {
      // The control for the two cases above. Without it, "an unknown id is
      // not-found" is satisfied by a verb that answers not-found for every id,
      // and the whole reaction path could be dead while this describe stayed
      // green. The same call, the same store, one id away.
      const returned = await react(makeLocalDeps(seededStore()), FRESH, SIBLING_COMMENT_ID)
      expect(returned).toEqual(SIBLING_ROLLUP)
    })
  })
})

/**
 * What the harness itself has to guarantee before any assertion written against
 * it means anything.
 *
 * The write cases this store exists for assert persistence by reading state back
 * — "the snapshot read AFTER the write already carries the new threads". Two
 * ways of building the store would make every one of those pass while nothing
 * was persisted, and each has a case here.
 *
 * A store that handed out the document it still holds would let a writer mutate
 * stored state in place: the read-back would show the mutation whether or not
 * any write method was ever reached, and the whole set of persistence
 * assertions would be measuring one object seen twice. A shallow copy is the
 * same defect wearing a disguise — it satisfies "not the same object" at the top
 * while aliasing every thread, comment and blob-index entry underneath, which is
 * exactly the depth a write reaches — so the depth is asserted, not assumed.
 *
 * A failure injection that never fires would empty the other half: every
 * persist-failure case is written as "this write throws, so the draft must
 * survive", and a `throwOn` that was silently ignored would turn each of them
 * into a second, weaker test of the happy path. The case below is paired with a
 * store that names no failure, so the red comes from the injection rather than
 * from a method that is simply broken.
 */
describe('the harness cannot make a persistence assertion pass by aliasing', () => {
  const SEEDED_PATH = 'src/retry.ts'
  const SEEDED_COMMENT_ID = LOCAL_ENTITY_ID_BASE
  const SEEDED_BODY = 'This retries on a 4xx too, which will never succeed.'
  const SECOND_THREAD_ID = `local:${LOCAL_ID}:${LOCAL_ENTITY_ID_BASE + 10}`
  const SUMMARY_BODY = 'One question on the retry loop, otherwise this reads well.'

  /** The stored state these cases start from: one review, one thread, one comment. */
  const seeded = (): Snapshot =>
    localSnapshot({
      localId: LOCAL_ID,
      headSha: HEAD_SHA,
      at: FIXED_NOW,
      mergeBaseSha: BASE_SHA,
      paths: [SEEDED_PATH],
      threads: [
        {
          id: THREAD_ID,
          path: SEEDED_PATH,
          isOutdated: true,
          comments: [{ id: SEEDED_COMMENT_ID, body: SEEDED_BODY }],
        },
      ],
      commentAuthors: { [SEEDED_COMMENT_ID]: SESSION.human.id },
    })

  const storeWithSnapshot = (options: FakeLocalStoreOptions = {}): FakeLocalStore =>
    makeLocalStore({ snapshots: [seeded()], ...options })

  /**
   * The stored snapshot, or a loud failure. A `null` read would make every
   * mutation below vacuous — nothing to alias, nothing to prove — so it ends the
   * case rather than being quietly tolerated.
   */
  const read = (store: FakeLocalStore): Snapshot => {
    const held = store.getLocalSnapshot(LOCAL_ID)
    if (held === null) throw new Error('the seeded snapshot was not stored')
    return held
  }

  const secondThread = () =>
    localThread(
      { id: SECOND_THREAD_ID, path: SEEDED_PATH, comments: [{ id: SEEDED_COMMENT_ID + 1 }] },
      { headSha: HEAD_SHA, at: FIXED_NOW },
    )

  test('two reads of one stored snapshot are the same document and not the same object', () => {
    const store = storeWithSnapshot()
    const first = store.getLocalSnapshot(LOCAL_ID)
    const second = store.getLocalSnapshot(LOCAL_ID)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })

  test('a comment body edited on a read snapshot is not the body the next read returns', () => {
    // The deepest point a write reaches, and the one a top-level copy would
    // still alias: snapshot, mutable half, thread, comment, body.
    const store = storeWithSnapshot()
    const comment = read(store).mutable.threads[0]?.comments[0]
    if (comment === undefined) throw new Error('the seeded thread carries no comment to edit')
    comment.body = 'Rewritten through a handle the store would still hold.'
    expect(read(store).mutable.threads[0]?.comments[0]?.body).toBe(SEEDED_BODY)
  })

  test('a read snapshot edited at every depth a write touches leaves the stored one unchanged', () => {
    const store = storeWithSnapshot()
    const held = read(store)
    held.syncedAt = 'edited at the top level'
    held.mutable.commentAuthors = { [SEEDED_COMMENT_ID]: 'someone.else@example.test' }
    const thread = held.mutable.threads[0]
    if (thread === undefined) throw new Error('the seeded snapshot carries no thread to edit')
    thread.isResolved = true
    thread.comments = []
    const blobs = held.immutable.blobIndex[SEEDED_PATH]
    if (blobs === undefined) throw new Error('the seeded snapshot carries no blob pair to edit')
    blobs.head = 'edited inside the blob index'
    // Compared against a freshly built seed rather than against an earlier read,
    // so a store that let ANY of those edits through fails here — including one
    // that returned copies but kept handing back the same corrupted state.
    expect(read(store)).toEqual(seeded())
  })

  test('a stored snapshot is not the object it was written from', () => {
    // The mirror of the read case: a writer that kept its own document could
    // otherwise keep editing stored state with no write call to attribute it to.
    const store = makeLocalStore()
    const written = seeded()
    store.putLocalSnapshot(written)
    const body = written.mutable.threads[0]?.comments[0]
    if (body === undefined) throw new Error('the built snapshot carries no comment to edit')
    body.body = 'Edited after the write, through the writer’s own handle.'
    expect(read(store).mutable.threads[0]?.comments[0]?.body).toBe(SEEDED_BODY)
  })

  test('a store built to fail on the thread write throws when it is called, naming the method', () => {
    const store = storeWithSnapshot({ throwOn: 'putLocalThread' })
    expect(() => store.putLocalThread(LOCAL_ID, secondThread())).toThrow('putLocalThread')
  })

  test('a store naming no failure accepts and records the same thread write', () => {
    // The paired control: without it, a `putLocalThread` that threw
    // unconditionally would satisfy the case above and every persist-failure
    // case built on it, while proving nothing about the injection.
    const store = storeWithSnapshot()
    store.putLocalThread(LOCAL_ID, secondThread())
    expect(store.listLocalThreads(LOCAL_ID).map((thread) => thread.id)).toEqual([
      THREAD_ID,
      SECOND_THREAD_ID,
    ])
    expect(read(store).mutable.threads.map((thread) => thread.id)).toEqual([
      THREAD_ID,
      SECOND_THREAD_ID,
    ])
  })

  test('a written review summary reads back, by value in both directions', () => {
    const store = storeWithSnapshot()
    const summary: ReviewSummary = {
      id: SEEDED_COMMENT_ID + 100,
      node_id: 'seeded-review-summary',
      user: SEEDED_AUTHOR,
      body: SUMMARY_BODY,
      state: 'COMMENTED',
      submitted_at: FIXED_NOW,
      commit_id: HEAD_SHA,
    }
    store.putLocalReviewSummary(LOCAL_ID, summary)
    summary.body = 'Edited after the write, through the writer’s own handle.'
    const readBack = store.listLocalSubmittedReviews(LOCAL_ID)[0]
    if (readBack === undefined) throw new Error('the written summary did not read back')
    readBack.body = 'Edited through the read.'
    expect(store.listLocalSubmittedReviews(LOCAL_ID)[0]?.body).toBe(SUMMARY_BODY)
  })
})
