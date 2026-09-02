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
  LocalReviewSummary,
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
import {
  ApiError,
  archivedReviewRefusal,
  LOCAL_ENTITY_ID_BASE,
  LOCAL_REVIEW_ID_BASE,
  parsePrefixedBody,
  prefixBody,
} from '@revu/shared'
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
  'getLocalReview',
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
    getLocalReview: (localId) => store.getLocalReview(localId),
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
      'getLocalReview',
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

/**
 * The answer each verb owes the client's optimistic path, stated as the LIST of
 * fields that path reads back rather than as one more comparison of values.
 *
 * Every verb here is called optimistically: the client paints the change into
 * its cache before the write returns and then copies fields back out of the
 * answer over what it painted. So an answer carrying less than a complete value
 * does not fail — it silently reverts what the reader just did, or overwrites
 * cached state with whatever a partly-built answer happened to hold. There is no
 * error anywhere on that path, which is why the contract has to be pinned here.
 *
 * WHAT THIS ADDS OVER THE VALUE COMPARISONS ELSEWHERE IN THIS FILE, WHICH ARE
 * ALREADY STRONGER PER FIELD. Those state what a field holds on one fixture, and
 * a whole-object comparison among them is the sole reason a wrong value for any
 * one of these fields fails. What none of them states is WHICH FIELDS THE
 * CONTRACT IS ABOUT — that knowledge lives in the client, and here it lived only
 * in the choice of what to compare. Writing it down gives a field the client
 * starts reading back somewhere to be added, and gives an answer that stopped
 * carrying one something to fail; the check is categorical over the list, so
 * adding a name is the whole edit.
 *
 * WHAT IT CANNOT SEE, STATED RATHER THAN IMPLIED. The list is maintained beside
 * the sink and nothing here can read the client's own source to confirm the two
 * still agree, because the structural scan over this path allows the shared
 * contract package and the test runner and nothing else — a filesystem read is
 * exactly the capability that scan exists to deny. So a field ADDED to the
 * client's copy-back and not added here is invisible, and that residue is the
 * pre-merge review's, in the same way a coordinated edit of a pinned literal and
 * its subject is.
 *
 * The submitted summary is deliberately absent from the list. The client reads
 * one thing out of a submit — whether it succeeded — and then re-reads the
 * review rather than copying any field of the summary into its cache. The
 * summary's fields are a stored-record contract, asserted where the submit's own
 * persistence cases assert it, and the one relationship no fixture there could
 * measure has its own describe below.
 */
describe('every verb answers with the fields the client copies back out of it', () => {
  /**
   * The fields the client reads back out of each answer.
   *
   * Typed against the contract's own shapes, so a name that is not a field of
   * the thing it claims to describe is a compile error rather than an entry that
   * silently checks nothing. Both list halves matter: `reply` names the fields
   * read individually, while the client in fact substitutes the WHOLE comment —
   * the completeness of the rest is the separate shape case below.
   */
  const CLIENT_READS: {
    readonly reply: readonly (keyof ReviewComment)[]
    readonly resolve: readonly (keyof ReviewThread)[]
    readonly react: readonly (keyof ReactionRollup)[]
  } = {
    reply: [
      'id',
      'in_reply_to_id',
      'path',
      'line',
      'side',
      'subject_type',
      'reactions',
      'user',
      'body',
    ],
    resolve: ['isResolved', 'isOutdated', 'resolvedBy'],
    react: [
      'url',
      'total_count',
      '+1',
      '-1',
      'laugh',
      'hooray',
      'confused',
      'heart',
      'rocket',
      'eyes',
    ],
  }

  /**
   * The listed fields an answer did not carry — absent, or present holding
   * nothing. Both count as unanswered: the client assigns whatever it finds
   * straight onto cached state, so a key explicitly holding `undefined` blanks
   * the cached value exactly as a missing key does.
   */
  const unanswered = (value: object, fields: readonly string[]): string[] =>
    fields.filter(
      (field) =>
        !Object.hasOwn(value, field) || (value as Record<string, unknown>)[field] === undefined,
    )

  const CONVERGENCE_PATH = 'src/retry.ts'
  const CONVERGENCE_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 800
  const CONVERGENCE_THREAD_ID = `local:${LOCAL_ID}:${CONVERGENCE_COMMENT_ID}`
  const CONVERGENCE_BODY = 'Agreed — it should stop at the first 4xx rather than retrying it.'

  /** A synced review carrying one outdated thread, which every case here answers about. */
  const convergenceStore = (): FakeLocalStore =>
    makeLocalStore({
      snapshots: [
        localSnapshot({
          localId: LOCAL_ID,
          headSha: HEAD_SHA,
          at: FIXED_NOW,
          mergeBaseSha: BASE_SHA,
          paths: [CONVERGENCE_PATH],
          threads: [
            {
              id: CONVERGENCE_THREAD_ID,
              path: CONVERGENCE_PATH,
              // Outdated, so an answer rebuilt from parts would default the one
              // field of the three the client copies that nothing here can
              // recompute — and the completeness check would still pass, which
              // is the honest limit of a check about presence.
              isOutdated: true,
              comments: [{ id: CONVERGENCE_COMMENT_ID }],
            },
          ],
        }),
      ],
    })

  const replyHere = (body: string = CONVERGENCE_BODY): Promise<ReviewComment> =>
    localWrites.replyToLocalThread(
      makeLocalDeps(convergenceStore()),
      LOCAL_ID,
      CONVERGENCE_THREAD_ID,
      body,
    )

  describe('the completeness check discriminates before anything is measured with it', () => {
    test('it names a field an answer left out', () => {
      // Without this control every case below is satisfied by a checker that
      // reports nothing, including over an answer carrying no fields at all.
      expect(unanswered({ isResolved: true, resolvedBy: null }, CLIENT_READS.resolve)).toEqual([
        'isOutdated',
      ])
    })

    test('it names a field present but holding nothing', () => {
      // Its own case: `undefined` is what a partly-built answer carries where a
      // field was named and never filled, and a check keyed only on presence
      // would read that as answered and blank the cached value in silence.
      expect(
        unanswered({ isResolved: true, isOutdated: undefined, resolvedBy: null }, CLIENT_READS.resolve),
      ).toEqual(['isOutdated'])
    })

    test('it names nothing on an answer that carries every field, null included', () => {
      // The positive half, and the reason `null` is not treated as missing: an
      // unresolved thread legitimately names nobody, and a check that read that
      // as an incomplete answer could never be satisfied by a correct verb.
      expect(
        unanswered({ isResolved: false, isOutdated: false, resolvedBy: null }, CLIENT_READS.resolve),
      ).toEqual([])
    })

    test('no list is empty, so no case below can pass by checking nothing', () => {
      // Written-out counts. A comparison of the lists against themselves would
      // hold however many members they had, which is the whole failure mode.
      expect([
        CLIENT_READS.reply.length,
        CLIENT_READS.resolve.length,
        CLIENT_READS.react.length,
      ]).toEqual([9, 3, 10])
    })
  })

  test('a reply answers with every field the client copies onto its optimistic comment', async () => {
    expect(unanswered(await replyHere(), CLIENT_READS.reply)).toEqual([])
  })

  test('a resolve answers with every field the client copies onto its optimistic flip', async () => {
    const returned = await localWrites.resolveLocalThread(
      makeLocalDeps(convergenceStore()),
      LOCAL_ID,
      CONVERGENCE_THREAD_ID,
      true,
    )
    expect(unanswered(returned, CLIENT_READS.resolve)).toEqual([])
  })

  test('an unresolve answers with them too, though one of them names nobody', async () => {
    // Its own case: unresolving is the one answer where a listed field is
    // legitimately empty, so it is the one that would break a completeness
    // check written to demand a value rather than a decision.
    const returned = await localWrites.resolveLocalThread(
      makeLocalDeps(convergenceStore()),
      LOCAL_ID,
      CONVERGENCE_THREAD_ID,
      false,
    )
    expect(unanswered(returned, CLIENT_READS.resolve)).toEqual([])
  })

  test('a reaction answers with every count the client overwrites its rollup with', async () => {
    const returned = await localWrites.addLocalReaction(
      makeLocalDeps(convergenceStore()),
      LOCAL_ID,
      CONVERGENCE_COMMENT_ID,
      '+1',
    )
    expect(unanswered(returned, CLIENT_READS.react)).toEqual([])
  })

  test('a repeat reaction answers with them too, unchanged as it is', async () => {
    // The idempotent answer is handed to the same assignment as the first one,
    // so it is held to the same completeness: a repeat that answered with a
    // partial rollup would blank counts in the cache with nothing to notice.
    const deps = makeLocalDeps(convergenceStore())
    await localWrites.addLocalReaction(deps, LOCAL_ID, CONVERGENCE_COMMENT_ID, '+1')
    const repeat = await localWrites.addLocalReaction(deps, LOCAL_ID, CONVERGENCE_COMMENT_ID, '+1')
    expect(unanswered(repeat, CLIENT_READS.react)).toEqual([])
  })

  describe('a reply is shaped like the comments it is swapped in among', () => {
    /**
     * The client swaps its optimistic comment for this one inside a list of
     * comments the read path produced, so the claim is not only that the named
     * fields are filled — it is that the answer is not a NARROWER document than
     * the ones already beside it. A field every stored comment carries and this
     * one omits changes the shape of exactly one entry in a rendered
     * conversation.
     *
     * Compared as key SETS against stored state rather than against a written-out
     * literal, deliberately: a literal would have to be edited in step with the
     * shape it describes, and a field added to the read path and forgotten by
     * this verb would then be missing from both sides and invisible. Reading the
     * expectation off a comment the review already holds is what removes that.
     */
    const storedRoot = (): ReviewComment => {
      const held = convergenceStore()
        .getLocalSnapshot(LOCAL_ID)
        ?.mutable.threads.find((thread) => thread.id === CONVERGENCE_THREAD_ID)?.comments[0]
      if (held === undefined) throw new Error('the seeded thread carries no comment to compare with')
      return held
    }

    test('it carries every field a comment already stored on the review carries', async () => {
      const comment = await replyHere()
      const root = storedRoot()
      expect(Object.keys(root).filter((key) => !Object.hasOwn(comment, key))).toEqual([])
    })

    test('the only field it carries beyond those is the link to what it answers', async () => {
      // Its own case, and the direction that keeps the one above honest: a
      // comparison in one direction alone is satisfied by an answer that carries
      // every stored field plus anything at all. The one legitimate difference
      // is named rather than tolerated — a root comment answers nothing, so it
      // is the one comment on a thread that carries no such link.
      const comment = await replyHere()
      const root = storedRoot()
      expect(Object.keys(comment).filter((key) => !Object.hasOwn(root, key))).toEqual([
        'in_reply_to_id',
      ])
    })

    test('the comparison is made against a comment that really carries fields, not an empty one', () => {
      // The fixture control. Both directions above are vacuously satisfied by a
      // stored comment with no fields, which is what a seed builder that had
      // stopped populating one would leave behind.
      expect(Object.keys(storedRoot()).length).toBeGreaterThanOrEqual(20)
    })
  })

  describe('no answer smuggles an identity into a body', () => {
    /**
     * The claim in the READER's vocabulary rather than the writer's: whatever
     * the sink did to a body, the parser that decides who a comment is from
     * must reach the same conclusion about the answer as about the text that was
     * written. That is a different statement from the ban on bold-prefixed
     * bodies elsewhere in this file, and the two were measured against each
     * other rather than assumed to agree.
     *
     * THEY ARE NOT EQUIVALENT, AND THE BAN IS THE BROADER OF THE TWO. Every body
     * the parser accepts also matches that ban — the parser's own pattern
     * requires the same bold opener — while the converse fails: a bold opener
     * with no blank line after it, or one whose bold text is too long to read as
     * a name, trips the ban and parses as nothing.
     *
     * WHICH IS WHY THIS IS AN EQUALITY AND NOT A DEMAND FOR NOTHING. A reviewer
     * who opens a comment with a bold word has written a body the parser reads as
     * a name, and bodies here are stored exactly as written — so a check
     * requiring every answer to parse as nothing would be asserting against the
     * verbatim guarantee rather than against a stamp. What a stamp does is add a
     * LAYER, which moves the parse whether or not the text underneath parsed.
     *
     * Measured as SUBSUMED for detection: bodies are compared exactly elsewhere,
     * so every stamping mutant is already caught there, in any format. Kept as
     * the statement of what the property MEANS to the surface that reads it.
     */
    const PLAIN_BODY = 'Agreed — it should stop at the first 4xx rather than retrying it.'
    /** A body the reviewer wrote that the identity parser already reads as a name. */
    const SELF_STAMPED_BODY = '**Nit**\n\nprefer a const here.'

    test('the parser reads a real stamp as an identity and a plain body as none', () => {
      // The control, built with the function the mediated write path stamps
      // with rather than with an imitation of it: without this pair, "the answer
      // parses as nothing" is satisfied by a parser that never parses anything.
      expect(parsePrefixedBody(prefixBody(SESSION.human, PLAIN_BODY))?.name).toBe(SESSION.human.name)
      expect(parsePrefixedBody(PLAIN_BODY)).toBeNull()
    })

    test('a replied body the reviewer wrote plain comes back reading as no identity', async () => {
      expect(parsePrefixedBody((await replyHere(PLAIN_BODY)).body)).toBeNull()
    })

    test('a body that already reads as an identity comes back reading as the same one', async () => {
      // The categorical form, and the one that could not be written as a demand
      // for nothing. The precondition is asserted FIRST: with it after, two
      // nulls would satisfy the equality and the case would measure nothing.
      const written = parsePrefixedBody(SELF_STAMPED_BODY)
      expect(written).not.toBeNull()
      expect(parsePrefixedBody((await replyHere(SELF_STAMPED_BODY)).body)).toEqual(written)
    })
  })
})

/**
 * Which commit a created document records as the one it was written against.
 *
 * Three different commits are in scope while a local write runs, and on
 * ordinary state they are the same string — which is exactly why a case built on
 * ordinary state proves nothing about which of them was read. The branch's head
 * as the injected resolver reports it is the one an answer must carry: it is
 * what the reviewer is looking at and what the write was guarded against. The
 * stored snapshot's head is the state of the last sync, which can be older,
 * because a local review is synced on demand while the branch moves underneath
 * it — a comment stamped with that one claims to have been written against a
 * commit the reviewer never saw, and nothing downstream could tell. The thread's
 * root carries a third: the commit the conversation was opened against, which a
 * reply does not restate.
 *
 * Every case here therefore runs against a review whose stored snapshot was
 * synced at a commit the resolver no longer reports, with a fixture control
 * asserting the three really do differ. Without that separation these are
 * comparisons between several names for one value, and they hold however the
 * answer was derived.
 *
 * ONE SUBSTITUTION IS UNFALSIFIABLE AND IS RECORDED RATHER THAN CHASED: the head
 * the submit was ASKED to guard against. A submit reaches the point where it
 * stamps anything only once the resolved head and the expected one are equal, so
 * an answer derived from either is the same answer on every input that can reach
 * the code, and no fixture can separate them.
 */
describe('a created document is stamped with the head the write was guarded against', () => {
  /** The commit the last sync captured — older than the branch's head now. */
  const LAST_SYNCED_SHA = 'e'.repeat(40)
  /** Older still: the commit the seeded thread was opened against. */
  const THREAD_OPENED_AT_SHA = 'f'.repeat(40)

  const STALE_PATH = 'src/retry.ts'
  const STALE_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 850
  const STALE_THREAD_ID = `local:${LOCAL_ID}:${STALE_COMMENT_ID}`
  const REPLY_BODY = 'Still worth stopping at the first 4xx.'

  /**
   * A thread written out rather than seeded through the shorthand, which derives
   * a comment's commit from the snapshot's head — the agreement this fixture
   * exists to break.
   */
  const openedEarlier = (): ReviewThread => ({
    id: STALE_THREAD_ID,
    isResolved: false,
    isOutdated: false,
    path: STALE_PATH,
    line: 12,
    originalLine: 12,
    startLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    startDiffSide: null,
    subjectType: 'LINE',
    resolvedBy: null,
    comments: [
      {
        id: STALE_COMMENT_ID,
        node_id: `seeded-comment-${STALE_COMMENT_ID}`,
        pull_request_review_id: null,
        path: STALE_PATH,
        diff_hunk: '@@ -12,1 +12,1 @@\n-was\n+is\n',
        commit_id: THREAD_OPENED_AT_SHA,
        original_commit_id: THREAD_OPENED_AT_SHA,
        line: 12,
        original_line: 12,
        start_line: null,
        original_start_line: null,
        side: 'RIGHT',
        start_side: null,
        subject_type: 'line',
        user: SEEDED_AUTHOR,
        body: 'The comment that opened this thread, written before the branch moved on.',
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
        reactions: zeroedReactions(),
        html_url: '',
      },
    ],
  })

  /** A review last synced at one commit, carrying a thread opened at another. */
  const staleSyncStore = (): FakeLocalStore => {
    const store = makeLocalStore({
      snapshots: [
        localSnapshot({
          localId: LOCAL_ID,
          headSha: LAST_SYNCED_SHA,
          at: FIXED_NOW,
          mergeBaseSha: BASE_SHA,
          paths: [STALE_PATH],
        }),
      ],
    })
    store.putLocalThread(LOCAL_ID, openedEarlier())
    return store
  }

  const STALE_SUBMIT: SubmitReviewInput = {
    prNumber: LOCAL_ID,
    expectedHeadSha: HEAD_SHA,
    event: 'COMMENT',
    body: 'Two things worth another look before this goes anywhere.',
    comments: [
      {
        key: 'stale-one',
        path: STALE_PATH,
        side: 'RIGHT',
        start_side: null,
        line: 20,
        start_line: null,
        body: 'This still retries on a 4xx.',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        anchor: { lineText: 'line 20', contextBefore: [], contextAfter: [] },
      },
    ],
  }

  const submitStale = async (store: FakeLocalStore): Promise<ReviewSummary> => {
    const result = await localWrites.submitLocalReview(makeLocalDeps(store), STALE_SUBMIT)
    if (result.status !== 'ok') {
      throw new Error(`the submit answered '${result.status}' where 'ok' was required`)
    }
    return result.review
  }

  /** The comments the submit created — everything except the thread that was seeded. */
  const createdComments = (store: FakeLocalStore): ReviewComment[] =>
    store
      .listLocalThreads(LOCAL_ID)
      .filter((thread) => thread.id !== STALE_THREAD_ID)
      .flatMap((thread) => thread.comments)

  test('the fixture holds three different commits, without which every case here is vacuous', async () => {
    // Read off the STORED state and off the injected resolver rather than off
    // the constants, so a seed builder that quietly normalized the snapshot to
    // the branch's head, or a resolver answering something else, is caught here
    // rather than turning the cases below into tautologies that still pass.
    const store = staleSyncStore()
    const snapshot = store.getLocalSnapshot(LOCAL_ID)
    const root = snapshot?.mutable.threads[0]?.comments[0]
    const head = await makeLocalDeps(store).resolveHead()
    expect([snapshot?.immutable.headSha, root?.commit_id, head.sha]).toEqual([
      LAST_SYNCED_SHA,
      THREAD_OPENED_AT_SHA,
      HEAD_SHA,
    ])
    // The distinctness itself, as a written-out count: three values compared
    // pairwise by hand would still hold if two of the constants became equal.
    expect(new Set([LAST_SYNCED_SHA, THREAD_OPENED_AT_SHA, HEAD_SHA]).size).toBe(3)
  })

  test('the submitted summary names the resolved head, not the commit the review was synced at', async () => {
    const review = await submitStale(staleSyncStore())
    expect(review.commit_id).toBe(HEAD_SHA)
  })

  test('every comment the submit created names the resolved head on both of its commit fields', async () => {
    // Its own case rather than a second assertion above: the summary and the
    // comments read their commit from the same value in the same function, so a
    // shared body would let the first abort before the second was measured.
    const store = staleSyncStore()
    await submitStale(store)
    const created = createdComments(store)
    expect(created).toHaveLength(1)
    expect(created.map((comment) => [comment.commit_id, comment.original_commit_id])).toEqual([
      [HEAD_SHA, HEAD_SHA],
    ])
  })

  test('a reply names the resolved head, while the commit its thread was opened against stays the root’s', async () => {
    // Both halves in one comparison, because they are one claim about one
    // document: the current commit moves with the branch, the original does not.
    const comment = await localWrites.replyToLocalThread(
      makeLocalDeps(staleSyncStore()),
      LOCAL_ID,
      STALE_THREAD_ID,
      REPLY_BODY,
    )
    expect([comment.commit_id, comment.original_commit_id]).toEqual([
      HEAD_SHA,
      THREAD_OPENED_AT_SHA,
    ])
  })
})

/**
 * The four verbs over ONE local review, each addressed at state the verb before
 * it produced.
 *
 * Every other case in this file starts a verb from a SEEDED fixture, which is
 * what makes each verb's own postconditions measurable — and is also the one
 * thing such a case can never see. A fixture is written out by the test, so a
 * value one verb derives from another verb's output is, in a single-verb case,
 * derived from a literal the test chose. Nothing there can notice that the id a
 * reply mints collides with the id of the comment it answers, that the thread id
 * a submit mints is not the id a later lookup finds, or that a fourth write
 * carries away what the third one changed. Those are properties of the
 * COMPOSITION, and the composition is what this suite drives.
 *
 * ONE DEPENDENCY SET FOR ALL FOUR VERBS, and that is the point rather than a
 * convenience. A dependency set built per verb carries an allocator of its own,
 * so each verb mints from a sequence starting where every other verb's does and
 * no two of them can be shown to agree about which ids are already spent. Driven
 * through one, the ids the four verbs mint come out of one sequence and can be
 * required to be distinct — a claim about the verbs together, and unstatable
 * about any one of them alone.
 *
 * THE IDS THE LATER VERBS ARE ADDRESSED WITH ARE READ BACK from what the submit
 * wrote, never written out here. A thread id written out as a literal is
 * compared against the minter that produced it, and such a case holds however
 * the two drift apart; read back, the reply and the resolve reach their thread
 * only if the id the submit minted really is the id a lookup finds.
 *
 * THE AUTHORSHIP MAP STARTS WITH SOMEBODY ELSE'S COMMENT IN IT, so "an entry for
 * every id this run created, keyed to this reviewer" is a claim a uniformly
 * filled map would fail. Were every entry this reviewer's, a map that attributed
 * every comment on the review to whoever wrote last would satisfy the same
 * comparison and the case would measure nothing.
 *
 * ONE CLAIM IS MADE ON WHAT WAS WRITTEN RATHER THAN ON WHAT READS BACK. This
 * store keeps threads as rows and upserts them, so an envelope written with a
 * thread DROPPED still reads back complete — a removal cannot be seen from the
 * read side at all. The claim that the last write carried the earlier writes'
 * changes through is therefore made against the envelope handed to storage.
 */
describe('the four verbs compose over one local review, each answering what the last one left', () => {
  const PRIOR_PATH = 'src/pool.ts'
  const FIRST_PATH = 'src/retry.ts'
  const SECOND_PATH = 'src/queue.ts'

  /** A comment already on the review before this run, written by another human. */
  const PRIOR_AUTHOR_ID = 'wren.abbot@example.test'
  const PRIOR_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 700
  const PRIOR_THREAD_ID = `local:${LOCAL_ID}:${PRIOR_COMMENT_ID}`

  const SUMMARY_BODY = 'Two things to change before this goes anywhere.'
  const FIRST_BODY = 'This retries on a 4xx too, which will never succeed.'
  const SECOND_BODY = 'The queue drains on shutdown but nothing awaits the drain.'
  const REPLY_BODY = 'Agreed — it should stop at the first 4xx rather than retrying it.'
  const REACTION: ReactionKey = 'rocket'

  /** Another reviewer's unsent text on the SAME local review, which this run must not reach. */
  const OTHER_DRAFT: ReviewDraft = {
    ...SEEDED_DRAFT,
    humanId: PRIOR_AUTHOR_ID,
    body: 'Another reviewer’s unsent text, on the same local review.',
  }

  const pending = (seed: {
    key: string
    path: string
    line: number
    body: string
  }): PendingComment => ({
    key: seed.key,
    path: seed.path,
    side: 'RIGHT',
    start_side: null,
    line: seed.line,
    start_line: null,
    body: seed.body,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    anchor: { lineText: `line ${seed.line}`, contextBefore: [], contextAfter: [] },
  })

  /** Two pending comments on different files, so the two threads they become cannot be confused. */
  const PENDING: readonly PendingComment[] = [
    pending({ key: 'one', path: FIRST_PATH, line: 12, body: FIRST_BODY }),
    pending({ key: 'two', path: SECOND_PATH, line: 40, body: SECOND_BODY }),
  ]

  /** A synced review already carrying one thread, written by somebody who is not the reviewer. */
  const seeded = (): Snapshot =>
    localSnapshot({
      localId: LOCAL_ID,
      headSha: HEAD_SHA,
      at: FIXED_NOW,
      mergeBaseSha: BASE_SHA,
      paths: [PRIOR_PATH, FIRST_PATH, SECOND_PATH],
      threads: [{ id: PRIOR_THREAD_ID, path: PRIOR_PATH, comments: [{ id: PRIOR_COMMENT_ID }] }],
      commentAuthors: { [PRIOR_COMMENT_ID]: PRIOR_AUTHOR_ID },
    })

  interface Loop {
    readonly store: FakeLocalStore
    readonly deps: LocalWriteDeps
    /** Every envelope handed to storage over the whole run, in write order. */
    readonly envelopes: readonly Snapshot[]
    readonly review: ReviewSummary
    readonly reply: ReviewComment
    readonly resolved: ReviewThread
    readonly rollup: ReactionRollup
    /** The thread the reply and the resolve addressed, as the submit minted its id. */
    readonly answeredThreadId: string
    /** The thread holding the reacted comment — the one the other two verbs never touched. */
    readonly reactedThreadId: string
    /** The comment the reaction addressed, as the submit minted its id. */
    readonly reactedCommentId: number
  }

  /** The stored snapshot, or a loud failure — a null read would make every case here vacuous. */
  const storedSnapshot = (store: FakeLocalStore): Snapshot => {
    const held = store.getLocalSnapshot(LOCAL_ID)
    if (held === null) throw new Error('no snapshot is stored for the local review under test')
    return held
  }

  /**
   * submit, then reply, then resolve, then react — through one store, one
   * allocator and one clock, with every id after the first step read back out of
   * what the step before it wrote.
   */
  const runLoop = async (): Promise<Loop> => {
    const store = makeLocalStore({
      snapshots: [seeded()],
      drafts: [SEEDED_DRAFT, OTHER_DRAFT],
    })
    const { deps, envelopes } = capturing(store)

    const submitted = await localWrites.submitLocalReview(deps, {
      prNumber: LOCAL_ID,
      expectedHeadSha: HEAD_SHA,
      event: 'APPROVE',
      body: SUMMARY_BODY,
      comments: [...PENDING],
    })
    if (submitted.status !== 'ok') {
      throw new Error(`the submit answered '${submitted.status}' where 'ok' was required`)
    }

    const materialized = storedSnapshot(store).mutable.threads.filter(
      (thread) => thread.id !== PRIOR_THREAD_ID,
    )
    const [answered, reactedOn] = materialized
    if (answered === undefined || reactedOn === undefined) {
      throw new Error('the submit did not materialize the two threads this run is driven over')
    }
    const reactedComment = reactedOn.comments[0]
    if (reactedComment === undefined) {
      throw new Error('the thread the reaction is addressed at holds no comment')
    }

    const reply = await localWrites.replyToLocalThread(deps, LOCAL_ID, answered.id, REPLY_BODY)
    const resolved = await localWrites.resolveLocalThread(deps, LOCAL_ID, answered.id, true)
    const rollup = await localWrites.addLocalReaction(deps, LOCAL_ID, reactedComment.id, REACTION)

    return {
      store,
      deps,
      envelopes,
      review: submitted.review,
      reply,
      resolved,
      rollup,
      answeredThreadId: answered.id,
      reactedThreadId: reactedOn.id,
      reactedCommentId: reactedComment.id,
    }
  }

  /** Every comment this run created, in stored order: the submit's two with the reply between them. */
  const createdComments = (loop: Loop): ReviewComment[] =>
    storedSnapshot(loop.store)
      .mutable.threads.filter((thread) => thread.id !== PRIOR_THREAD_ID)
      .flatMap((thread) => thread.comments)

  test('the fixture disagrees with itself everywhere the cases below compare', async () => {
    // Each clause names a coincidence that would satisfy a case below however
    // the code behaved: an authorship map holding one name, a prior comment
    // whose id is among the minted ones, and two threads that cannot be told
    // apart, so a verb landing on the wrong one reads as landing on the right.
    const loop = await runLoop()
    expect(PRIOR_AUTHOR_ID).not.toBe(SESSION.human.id)
    expect(loop.answeredThreadId).not.toBe(loop.reactedThreadId)
    expect(new Set(PENDING.map((comment) => comment.path)).size).toBe(PENDING.length)
    expect(createdComments(loop).map((comment) => comment.id)).not.toContain(PRIOR_COMMENT_ID)
  })

  test('exactly one review summary is stored, and the three verbs after the submit wrote none', async () => {
    const loop = await runLoop()
    expect(loop.store.listLocalSubmittedReviews(LOCAL_ID)).toEqual([loop.review])
  })

  test('the review’s two timelines are still empty when the run is over', async () => {
    const loop = await runLoop()
    const held = storedSnapshot(loop.store)
    // One comparison rather than two, so a non-empty first list cannot abort the
    // case before the second one has been looked at.
    expect([held.mutable.reviews, held.mutable.issueComments]).toEqual([[], []])
  })

  test('the review holds the thread it started with plus one per pending comment, and no more', async () => {
    const loop = await runLoop()
    expect(storedSnapshot(loop.store).mutable.threads.map((thread) => thread.id)).toEqual([
      PRIOR_THREAD_ID,
      loop.answeredThreadId,
      loop.reactedThreadId,
    ])
    // The rows as well as the envelope: three of the four verbs write a thread
    // row, and a row keyed differently from the one it replaces leaves the
    // review holding a thread twice while the envelope still reads as three.
    expect(loop.store.listLocalThreads(LOCAL_ID)).toHaveLength(3)
  })

  test('every id the four verbs minted is positive, inside the local band, and distinct from the rest', async () => {
    const loop = await runLoop()
    const commentIds = createdComments(loop).map((comment) => comment.id)
    // Pinned first: every clause below is vacuously true over an empty list.
    expect(commentIds).toHaveLength(3)
    const minted = [loop.review.id, ...commentIds]
    expect(minted.filter((id) => id <= 0)).toEqual([])
    expect(minted.filter((id) => id < LOCAL_ENTITY_ID_BASE)).toEqual([])
    // Drawn from ONE allocator across four verbs, which is the only arrangement
    // in which this can fail. A verb minting from a sequence of its own, or
    // reusing an id it read off a document it was handed, collides here and
    // nowhere else: a case driving a single verb builds its expectation out of
    // the id that verb answered with, so the same id twice still matches. The
    // client swaps its optimistic entries by id, and a duplicate orphans the
    // entry it was meant to replace.
    expect(new Set(minted).size).toBe(minted.length)
  })

  test('every comment this run created is attributed to the reviewer, and the one it did not is left alone', async () => {
    const loop = await runLoop()
    const commentIds = createdComments(loop).map((comment) => comment.id)
    const authors = storedSnapshot(loop.store).mutable.commentAuthors ?? {}
    expect(commentIds.map((id) => authors[id])).toEqual([
      SESSION.human.id,
      SESSION.human.id,
      SESSION.human.id,
    ])
    // The map is NOT uniformly this reviewer's, which is what makes the
    // comparison above a claim about which ids are covered rather than one any
    // filled map satisfies.
    expect(authors[PRIOR_COMMENT_ID]).toBe(PRIOR_AUTHOR_ID)
    expect(Object.keys(authors).map(Number).sort((a, b) => a - b)).toEqual(
      [PRIOR_COMMENT_ID, ...commentIds].sort((a, b) => a - b),
    )
  })

  test('the submit took this reviewer’s draft and only this reviewer’s', async () => {
    const loop = await runLoop()
    expect(loop.deps.getLocalDraft(SESSION.human.id, LOCAL_ID)).toBeNull()
    // Keyed per human as well as per review. A delete that cleared the review's
    // drafts would take unsent text belonging to somebody who never submitted,
    // and no case driving a store holding one draft can see that.
    expect(JSON.stringify(loop.store.getLocalDraft(PRIOR_AUTHOR_ID, LOCAL_ID))).toBe(
      JSON.stringify(OTHER_DRAFT),
    )
  })

  test('the reply is bound to the review summary and the root comment this same run minted', async () => {
    const loop = await runLoop()
    const root = createdComments(loop)[0]
    if (root === undefined) throw new Error('the run created no comment for the reply to answer')
    // Both values come out of documents the SUBMIT produced moments earlier. A
    // case driving the reply alone reads them from a seeded fixture, so it can
    // only show the reply copied the literal the test chose.
    expect([loop.reply.pull_request_review_id, loop.reply.in_reply_to_id]).toEqual([
      loop.review.id,
      root.id,
    ])
  })

  test('the resolve answers with the thread as the reply left it', async () => {
    const loop = await runLoop()
    const createdIds = createdComments(loop).map((comment) => comment.id)
    expect(createdIds).toHaveLength(3)
    expect(loop.resolved.id).toBe(loop.answeredThreadId)
    // The thread the resolve read already carried the reply, which is a state no
    // seeded fixture put it in: the verb before it appended that comment.
    expect(loop.resolved.comments.map((comment) => comment.id)).toEqual(createdIds.slice(0, 2))
    expect(createdIds[1]).toBe(loop.reply.id)
    expect(loop.resolved.isResolved).toBe(true)
  })

  test('the reaction moves the comment the submit created, off the zero it was created with', async () => {
    const loop = await runLoop()
    const created = createdComments(loop)
    const reacted = created.find((comment) => comment.id === loop.reactedCommentId)
    const untouched = created.find((comment) => comment.id !== loop.reactedCommentId)
    if (reacted === undefined || untouched === undefined) {
      throw new Error('the run did not create the two comments this case compares')
    }
    // The baseline is read off a sibling the same submit created rather than
    // assumed: a comment a submit materializes carries a zeroed rollup, so a
    // count of one here is a movement and not a value somebody seeded.
    expect([untouched.reactions[REACTION], reacted.reactions[REACTION]]).toEqual([0, 1])
    expect(loop.rollup).toEqual(reacted.reactions)
  })

  test('the last envelope handed to storage still carries every change the earlier verbs made', async () => {
    // Asserted on what was WRITTEN. This store keeps threads as rows and upserts
    // them, so an envelope written with a thread dropped reads back complete —
    // a removal cannot be seen from the read side at all.
    const loop = await runLoop()
    expect(loop.envelopes).toHaveLength(4)
    const last = loop.envelopes[loop.envelopes.length - 1]
    if (last === undefined) throw new Error('no snapshot was handed to storage')
    expect(last.mutable.threads.map((thread) => thread.id)).toEqual([
      PRIOR_THREAD_ID,
      loop.answeredThreadId,
      loop.reactedThreadId,
    ])
    const answered = last.mutable.threads.find((thread) => thread.id === loop.answeredThreadId)
    // The reply and the resolve landed on this thread two writes and one write
    // before the last one. A verb rebuilding the review from the state it was
    // handed at the start of the run would carry neither.
    expect([answered?.isResolved, answered?.comments.length]).toEqual([true, 2])
    expect(last.mutable.commentAuthors).toEqual({
      [PRIOR_COMMENT_ID]: PRIOR_AUTHOR_ID,
      ...Object.fromEntries(createdComments(loop).map((comment) => [comment.id, SESSION.human.id])),
    })
  })
})

/**
 * The reviewer's unsent text across every outcome short of a confirmed submit.
 *
 * A draft is the one thing on a local review that exists nowhere else. A thread
 * that fails to materialize can be written again; text deleted after a write
 * that did not land is gone, and the product exists to stop exactly that. So the
 * property is stated once over every non-success outcome rather than case by
 * case, and it is stated as BYTE-IDENTICAL rather than as still-present: a draft
 * silently rewritten by a write that failed costs the reviewer the same words a
 * deleted one does, and only a serialized comparison can tell the two apart from
 * a draft that was left alone.
 *
 * EVERY ROW HERE DRIVES A REVIEW WHOSE SNAPSHOT IS STORED, and that is what
 * separates this matrix from the refusal cases at the top of the file. Those
 * drive a review that has never been synced, where a reply and a reaction refuse
 * because there is no snapshot at all and the branch that refuses because the
 * THREAD or the COMMENT is unknown is never reached. Measured against a sink
 * that deleted the draft only on that second branch, the whole existing suite
 * stayed green; these rows are the ones that go red.
 *
 * THE MATRIX CANNOT BE GREEN BECAUSE NOTHING HAPPENED. Two controls stand
 * beside it. The first pins what each row actually answers — a returned moved
 * head, a typed not-found, and the injected storage failure named by the message
 * the store raised — so a row that quietly SUCCEEDED, because its id named
 * something real or its failure injection never fired, is named rather than
 * counted as a draft that survived. The second
 * drives the same submit through to a confirmation on the same fixture and
 * requires the draft to be GONE, because a fixture whose draft nothing could
 * reach would produce this identical column of greens.
 */
describe('no outcome short of a confirmed submit costs the reviewer a byte of their draft', () => {
  const MOVED_SHA = 'c'.repeat(40)
  const SEEDED_PATH = 'src/retry.ts'
  const KNOWN_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 800
  const KNOWN_THREAD_ID = `local:${LOCAL_ID}:${KNOWN_COMMENT_ID}`
  const UNKNOWN_THREAD_ID = `local:${LOCAL_ID}:${LOCAL_ENTITY_ID_BASE + 801}`
  const UNKNOWN_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 802
  const REPLY_BODY = 'Agreed, will fix.'

  /**
   * One pending comment, so a submit really reaches the thread write. With an
   * empty comment list the loop that writes threads runs zero times, the
   * injected failure on that method never fires, and the persistence row below
   * would be a second test of a submit that simply confirmed.
   */
  const PENDING: readonly PendingComment[] = [
    {
      key: 'one',
      path: SEEDED_PATH,
      side: 'RIGHT',
      start_side: null,
      line: 12,
      start_line: null,
      body: 'This retries on a 4xx too, which will never succeed.',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      anchor: { lineText: 'line 12', contextBefore: [], contextAfter: [] },
    },
  ]

  /** A SYNCED review carrying one thread, so an id can be unknown rather than merely unreachable. */
  const syncedStore = (options: FakeLocalStoreOptions = {}): FakeLocalStore =>
    makeLocalStore({
      snapshots: [
        localSnapshot({
          localId: LOCAL_ID,
          headSha: HEAD_SHA,
          at: FIXED_NOW,
          mergeBaseSha: BASE_SHA,
          paths: [SEEDED_PATH],
          threads: [
            { id: KNOWN_THREAD_ID, path: SEEDED_PATH, comments: [{ id: KNOWN_COMMENT_ID }] },
          ],
        }),
      ],
      ...options,
    })

  const submitInput = (over: Partial<SubmitReviewInput> = {}): SubmitReviewInput => ({
    prNumber: LOCAL_ID,
    expectedHeadSha: HEAD_SHA,
    event: 'COMMENT',
    body: SEEDED_DRAFT.body,
    comments: [...PENDING],
    ...over,
  })

  /**
   * How a verb that refused answered, as a label a table can compare.
   *
   * An untyped throw is labelled with its MESSAGE rather than with the fact that
   * it was untyped, because one of the rows below reaches exactly that. A
   * storage failure before the draft is touched is not wrapped by the sink —
   * only a draft deletion that fails after the review has landed is, and that
   * one is a different outcome with a different answer — so the injected failure
   * arrives here as the store's own error. Labelling it by message is what makes
   * the row's control discriminate: it says the INJECTION is what failed the
   * submit, where 'an untyped error' would be satisfied by any accident.
   */
  const refusal = async (call: Promise<unknown>): Promise<string> =>
    call.then(
      () => 'returned without failing',
      (error: unknown) => {
        if (error instanceof ApiError) return `threw ${error.code}`
        return error instanceof Error ? `threw ${error.message}` : 'threw a non-error'
      },
    )

  /**
   * The four non-success outcomes: the store each one needs, the call that
   * reaches it answering a label for what happened, and the label it must
   * answer. One table drives both the survival matrix and the control that pins
   * the outcomes, so a row cannot be exercised by one and forgotten by the other.
   */
  const OUTCOMES: readonly (readonly [
    string,
    () => FakeLocalStore,
    (deps: LocalWriteDeps) => Promise<string>,
    string,
  ])[] = [
    [
      'a submit whose head has moved',
      () => syncedStore(),
      async (deps) => {
        const result = await localWrites.submitLocalReview(
          deps,
          submitInput({ expectedHeadSha: MOVED_SHA }),
        )
        return `returned ${result.status}`
      },
      'returned head_moved',
    ],
    [
      'a reply to a thread this review has never held',
      () => syncedStore(),
      (deps) =>
        refusal(localWrites.replyToLocalThread(deps, LOCAL_ID, UNKNOWN_THREAD_ID, REPLY_BODY)),
      'threw not_found',
    ],
    [
      'a reaction to a comment this review has never held',
      () => syncedStore(),
      (deps) => refusal(localWrites.addLocalReaction(deps, LOCAL_ID, UNKNOWN_COMMENT_ID, '+1')),
      'threw not_found',
    ],
    [
      'a submit whose thread write fails',
      () => syncedStore({ throwOn: 'putLocalThread' }),
      (deps) => refusal(localWrites.submitLocalReview(deps, submitInput())),
      'threw the fake local store was built to fail on putLocalThread, and putLocalThread was called',
    ],
  ]

  // One independently named case per row, written as a loop over the table
  // rather than through the runner's own table helper, which this package's
  // ambient declarations for the test runner do not describe. The shape is the
  // same either way, and it is the shape the storage-failure cases above
  // already use: each row is its own test, so a row that fails names itself and
  // does not stop the rows after it from running.
  for (const [outcome, store, drive] of OUTCOMES) {
    test(`${outcome} leaves the draft byte-identical`, async () => {
      const deps = makeLocalDeps(store())
      const before = deps.getLocalDraft(SESSION.human.id, LOCAL_ID)
      expect(before).not.toBeNull()
      await drive(deps)
      const after = deps.getLocalDraft(SESSION.human.id, LOCAL_ID)
      expect(after).not.toBeNull()
      expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    })
  }

  test('each row really reaches the outcome it is named for', async () => {
    // Collected and compared in one shot rather than asserted per row, so a row
    // that quietly succeeded is NAMED instead of aborting the run before the
    // rows after it have been driven.
    const observed = await Promise.all(
      OUTCOMES.map(
        async ([outcome, store, drive]) => [outcome, await drive(makeLocalDeps(store()))] as const,
      ),
    )
    expect(observed).toEqual(
      OUTCOMES.map(([outcome, , , answered]) => [outcome, answered] as const),
    )
  })

  test('the ids the two refusing rows name really are unknown to the seeded review', async () => {
    // Without this the two not-found rows could be refusing for the wrong
    // reason. The thread the review DOES hold is answered, which is what makes
    // the unknown one a statement about the id rather than about the fixture.
    const deps = makeLocalDeps(syncedStore())
    const comment = await localWrites.replyToLocalThread(
      deps,
      LOCAL_ID,
      KNOWN_THREAD_ID,
      REPLY_BODY,
    )
    expect(comment.in_reply_to_id).toBe(KNOWN_COMMENT_ID)
    expect(KNOWN_THREAD_ID).not.toBe(UNKNOWN_THREAD_ID)
    expect(KNOWN_COMMENT_ID).not.toBe(UNKNOWN_COMMENT_ID)
  })

  test('the same submit, allowed to confirm, does take the draft', async () => {
    // The matrix's positive control. Every row above leaves the draft in place,
    // and a fixture whose draft no call could reach would report the same four
    // greens; this is the one call on this fixture that must remove it.
    const deps = makeLocalDeps(syncedStore())
    expect(deps.getLocalDraft(SESSION.human.id, LOCAL_ID)).not.toBeNull()
    const result = await localWrites.submitLocalReview(deps, submitInput())
    expect(result.status).toBe('ok')
    expect(deps.getLocalDraft(SESSION.human.id, LOCAL_ID)).toBeNull()
  })
})

/**
 * Two writes overlapping on one local review, and the state neither may erase.
 *
 * Two of the four verbs read the review's snapshot, await the branch head, and
 * only then write a whole envelope. That await is the one point at which either
 * gives up control, and it sits between the read and the write — so a verb that
 * resumes there is holding a description of the review that another write may
 * already have replaced. An envelope built from the pre-await read republishes
 * the old thread list and the old authorship map over whatever landed in
 * between: a comment that fully persisted disappears, its authorship entry
 * disappears with it — and a local comment with no entry can never be
 * recognized as its writer's own again — while BOTH verbs answer success. That
 * is confirmed reviewer text destroyed with nothing anywhere reporting it,
 * which is the outcome this product exists to prevent.
 *
 * The window is closed by re-reading the snapshot after the last await. Every
 * store method the port declares is synchronous, so once a verb resumes, its
 * whole tail runs to completion with no further interleaving: a read taken at
 * the top of that tail already carries everything that landed during the await,
 * and nothing can land after it. The rule that keeps this true is stated in the
 * write module's own header, because a verb added later that awaited anywhere
 * between its read and its write would reopen the same window in silence.
 *
 * The two cases drive the two verbs against each other in both directions, and
 * each asserts against the ENVELOPE that was written rather than against what
 * reads back. The in-memory store keeps threads as rows and upserts them, so an
 * envelope that dropped a thread still reads back complete — the loss that
 * matters is in what the verb handed to storage, and a durable store is free to
 * read that envelope as the whole truth about the review.
 *
 * NEITHER CASE CAN BE GREEN BECAUSE NOTHING OVERLAPPED. Each pins the order the
 * two verbs completed in, and each checks that the blocked verb had written
 * nothing at the moment the other one ran — so a run in which the interleaving
 * did not happen is named rather than counted as a survival.
 */
describe('two writes overlapping on one local review, neither erasing the other', () => {
  const OVERLAP_PATH = 'src/retry.ts'
  const ROOT_COMMENT_ID = LOCAL_ENTITY_ID_BASE + 900
  const ROOT_THREAD_ID = `local:${LOCAL_ID}:${ROOT_COMMENT_ID}`
  const ROOT_AUTHOR_ID = 'wren.abbot@example.test'
  const REPLY_BODY = 'This landed while the other write was resolving the head.'
  const SUMMARY_BODY = 'One note before this goes anywhere.'

  const PENDING: readonly PendingComment[] = [
    {
      key: 'one',
      path: OVERLAP_PATH,
      side: 'RIGHT',
      start_side: null,
      line: 12,
      start_line: null,
      body: 'This retries on a 4xx too, which will never succeed.',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      anchor: { lineText: 'line 12', contextBefore: [], contextAfter: [] },
    },
  ]

  const submitInput = (): SubmitReviewInput => ({
    prNumber: LOCAL_ID,
    expectedHeadSha: HEAD_SHA,
    event: 'COMMENT',
    body: SUMMARY_BODY,
    comments: [...PENDING],
  })

  /** A synced review carrying one thread written by somebody else, so both verbs have work to do. */
  const overlappingStore = (): FakeLocalStore =>
    makeLocalStore({
      snapshots: [
        localSnapshot({
          localId: LOCAL_ID,
          headSha: HEAD_SHA,
          at: FIXED_NOW,
          mergeBaseSha: BASE_SHA,
          paths: [OVERLAP_PATH],
          threads: [
            { id: ROOT_THREAD_ID, path: OVERLAP_PATH, comments: [{ id: ROOT_COMMENT_ID }] },
          ],
          commentAuthors: { [ROOT_COMMENT_ID]: ROOT_AUTHOR_ID },
        }),
      ],
    })

  /**
   * A head resolver that parks until it is released, and announces that it has
   * been entered. Entry is what tells a case that the verb under test has taken
   * its pre-await read and is now suspended; release is what lets it resume.
   * Without the entry signal a case could run its second verb before the first
   * had read anything, which is a different interleaving and not the one these
   * cases are about.
   */
  const gatedHead = (): {
    resolveHead: () => Promise<{ sha: string; commitCount: number }>
    entered: Promise<void>
    release: () => void
  } => {
    let announceEntry: () => void = () => {}
    const entered = new Promise<void>((settle) => {
      announceEntry = settle
    })
    let allow: () => void = () => {}
    const released = new Promise<void>((settle) => {
      allow = settle
    })
    return {
      entered,
      release: () => {
        allow()
      },
      resolveHead: async () => {
        announceEntry()
        await released
        return { sha: HEAD_SHA, commitCount: 3 }
      },
    }
  }

  /** Every comment id an envelope carries, across every thread it holds. */
  const envelopeCommentIds = (envelope: Snapshot): number[] =>
    envelope.mutable.threads.flatMap((thread) => thread.comments.map((comment) => comment.id))

  /** The last envelope handed to storage, or a loud failure — no envelope makes a case vacuous. */
  const lastEnvelope = (envelopes: readonly Snapshot[]): Snapshot => {
    const held = envelopes.at(-1)
    if (held === undefined) throw new Error('no snapshot envelope was written')
    return held
  }

  /**
   * Every comment id the submit created, read out of the thread ROWS rather
   * than out of an envelope: the rows are written per thread and are the one
   * record an envelope that dropped a thread cannot have erased.
   */
  const createdCommentIds = (store: FakeLocalStore): number[] =>
    store
      .listLocalThreads(LOCAL_ID)
      .filter((thread) => thread.id !== ROOT_THREAD_ID)
      .flatMap((thread) => thread.comments.map((comment) => comment.id))

  test('a reply that lands while a submit is resolving the head survives the submit', async () => {
    const store = overlappingStore()
    const nextEntityId = countingEntityIds()
    const gate = gatedHead()
    const captured = capturing(store)
    const submitDeps: LocalWriteDeps = {
      ...captured.deps,
      nextEntityId,
      resolveHead: gate.resolveHead,
    }
    const replyDeps: LocalWriteDeps = { ...makeLocalDeps(store), nextEntityId }

    const completed: string[] = []
    const submitting = localWrites.submitLocalReview(submitDeps, submitInput()).then((result) => {
      completed.push('submit')
      return result
    })
    await gate.entered

    // The submit is parked on its head resolution here, holding the read it
    // took before that await. Everything the reply does lands inside that
    // window.
    const reply = await localWrites.replyToLocalThread(
      replyDeps,
      LOCAL_ID,
      ROOT_THREAD_ID,
      REPLY_BODY,
    )
    completed.push('reply')
    // The interleaving, pinned: the submit had written nothing when the reply ran.
    expect(store.listLocalSubmittedReviews(LOCAL_ID)).toEqual([])

    gate.release()
    const result = await submitting
    expect(completed).toEqual(['reply', 'submit'])
    expect(result.status).toBe('ok')

    const envelope = lastEnvelope(captured.envelopes)
    // The control, checked first and independent of the claim: the submit put
    // its OWN comment in the envelope, so this is an envelope that really
    // carried a new write rather than one nothing reached. It holds whether or
    // not the reply survived, which is what stops it restating the claim.
    const created = createdCommentIds(store)
    expect(created.length).toBe(PENDING.length)
    for (const id of created) expect(envelopeCommentIds(envelope)).toContain(id)

    // The claim: the comment that landed inside the window is still in the
    // envelope, and still attributable to the human who wrote it.
    expect(envelopeCommentIds(envelope)).toContain(reply.id)
    expect(envelope.mutable.commentAuthors?.[reply.id]).toBe(SESSION.human.id)

    // And the loss the reviewer would see: the comment is still readable.
    const held = store.getLocalSnapshot(LOCAL_ID)
    expect(held).not.toBeNull()
    expect(held?.mutable.threads.flatMap((thread) => thread.comments).map((c) => c.id)).toContain(
      reply.id,
    )
  })

  test('a submit that lands while a reply is resolving the head survives the reply', async () => {
    const store = overlappingStore()
    const nextEntityId = countingEntityIds()
    const gate = gatedHead()
    const captured = capturing(store)
    const replyDeps: LocalWriteDeps = {
      ...captured.deps,
      nextEntityId,
      resolveHead: gate.resolveHead,
    }
    const submitDeps: LocalWriteDeps = { ...makeLocalDeps(store), nextEntityId }

    const completed: string[] = []
    const replying = localWrites
      .replyToLocalThread(replyDeps, LOCAL_ID, ROOT_THREAD_ID, REPLY_BODY)
      .then((comment) => {
        completed.push('reply')
        return comment
      })
    await gate.entered

    const result = await localWrites.submitLocalReview(submitDeps, submitInput())
    completed.push('submit')
    if (result.status !== 'ok') throw new Error(`the submit answered '${result.status}'`)
    // The interleaving, pinned: the reply had written nothing when the submit ran.
    expect(captured.envelopes).toEqual([])

    gate.release()
    const reply = await replying
    expect(completed).toEqual(['submit', 'reply'])

    const envelope = lastEnvelope(captured.envelopes)
    // The control, checked first and independent of the claim: the reply put
    // its own comment in the envelope, so this is an envelope a write really
    // reached.
    expect(envelopeCommentIds(envelope)).toContain(reply.id)

    // The claim: the submit's own comment, and the entry that says who wrote
    // it. An id present with no entry is a comment nobody can ever be shown as
    // the author of, which is the half of this loss no later write can repair.
    const created = createdCommentIds(store)
    expect(created.length).toBe(PENDING.length)
    for (const id of created) {
      expect(envelopeCommentIds(envelope)).toContain(id)
      expect(envelope.mutable.commentAuthors?.[id]).toBe(SESSION.human.id)
    }
  })
})

// ————————————————————————————————————————————————————————————————————————————
// An archived review refuses every write before its first mutation.
// ————————————————————————————————————————————————————————————————————————————

/**
 * Once a pull request covers a local review's branch pair, the review is
 * read-only: every write verb answers the one refusal sentence every transport
 * shares, and it answers it BEFORE anything is read that could answer
 * differently and before anything is written. The submit returns it as a value,
 * exactly as it returns a moved head; the other three throw it typed.
 *
 * Every refusal here is measured against the WHOLE store, serialized before and
 * after the call, rather than against the fields a refusal most obviously must
 * not touch. A refusal that wrote somewhere unexpected — a summary row, an
 * authorship entry, the draft — would pass a comparison of named fields and
 * fail this one. Each verb carries its own control on the same seed with the
 * archive absent, so "the store did not move" is measured against a verb that
 * demonstrably moves it when allowed to.
 *
 * The seed is a review that has been LIVED IN: a synced snapshot holding one
 * thread, a submitted summary and the reviewer's draft. That is the state an
 * archive lands on in practice, and it is the state in which every verb has
 * something to find and something to write — a bare review would let a verb
 * refuse for the wrong reason and pass.
 */
describe('an archived review refuses every write verb, and the refusal writes nothing', () => {
  const ARCHIVED_PR = 41
  const SEEDED_COMMENT_ID = LOCAL_ENTITY_ID_BASE
  const SEEDED_SUMMARY_ID = LOCAL_ENTITY_ID_BASE + 9
  const MOVED_HEAD_SHA = 'c'.repeat(40)
  const UNKNOWN_THREAD_ID = `local:${LOCAL_ID}:${LOCAL_ENTITY_ID_BASE + 500}`

  const reviewRow = (archivedPr: number | null): LocalReviewSummary => ({
    id: LOCAL_ID,
    repo: 'acme/widgets',
    baseRef: 'refs/heads/main',
    headRef: 'refs/heads/feature/x',
    title: 'feature/x',
    baseSha: BASE_SHA,
    mergeBaseSha: BASE_SHA,
    headSha: HEAD_SHA,
    dirty: false,
    archivedPr,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    lastSyncedAt: FIXED_NOW,
  })

  /** The sentence the seeded row's pair and number produce. */
  const REFUSAL = archivedReviewRefusal({
    archivedPr: ARCHIVED_PR,
    baseRef: 'refs/heads/main',
    headRef: 'refs/heads/feature/x',
  })

  /** A synced review holding one thread, one submitted summary and the draft. */
  function seededStore(archivedPr: number | null): FakeLocalStore {
    const store = createFakeLocalStore({
      reviews: [reviewRow(archivedPr)],
      snapshots: [
        localSnapshot({
          localId: LOCAL_ID,
          headSha: HEAD_SHA,
          at: FIXED_NOW,
          threads: [
            {
              id: THREAD_ID,
              comments: [{ id: SEEDED_COMMENT_ID, reviewId: SEEDED_SUMMARY_ID }],
            },
          ],
          commentAuthors: { [SEEDED_COMMENT_ID]: SESSION.human.id },
        }),
      ],
      drafts: [SEEDED_DRAFT],
    })
    store.putLocalReviewSummary(LOCAL_ID, {
      id: SEEDED_SUMMARY_ID,
      node_id: `seeded-review-${SEEDED_SUMMARY_ID}`,
      user: SEEDED_AUTHOR,
      body: 'The review the seeded thread was opened by.',
      state: 'COMMENTED',
      submitted_at: FIXED_NOW,
      commit_id: HEAD_SHA,
    })
    return store
  }

  const submitWithAComment = (expectedHeadSha: string): SubmitReviewInput => ({
    ...SUBMIT_INPUT,
    expectedHeadSha,
    comments: [
      {
        key: 'archived-one',
        path: 'src/a.ts',
        side: 'RIGHT',
        start_side: null,
        line: 3,
        start_line: null,
        body: 'A comment that must never be materialized.',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        anchor: { lineText: '', contextBefore: [], contextAfter: [] },
      },
    ],
  })

  /**
   * The three verbs that refuse by throwing, each aimed at the seeded thread
   * and comment so that, with the archive absent, every one of them has a real
   * target and really writes.
   */
  const THROWING_VERBS: readonly (readonly [string, (deps: LocalWriteDeps) => Promise<unknown>])[] =
    [
      [
        'replyToLocalThread',
        (deps) => localWrites.replyToLocalThread(deps, LOCAL_ID, THREAD_ID, 'Agreed.'),
      ],
      ['resolveLocalThread', (deps) => localWrites.resolveLocalThread(deps, LOCAL_ID, THREAD_ID, true)],
      [
        'addLocalReaction',
        (deps) => localWrites.addLocalReaction(deps, LOCAL_ID, SEEDED_COMMENT_ID, '+1'),
      ],
    ]

  /** How a throwing verb answered: the typed code and sentence, or what else happened. */
  const outcomeOf = (run: () => Promise<unknown>): Promise<string> =>
    run().then(
      () => 'answered',
      (error: unknown) =>
        error instanceof ApiError ? `${error.code}: ${error.message}` : 'threw an untyped error',
    )

  test('the seed is the lived-in review the cases below assume', () => {
    // Pinned so a seed that quietly lost its thread, its summary or its draft
    // would not let a verb refuse for a reason other than the archive.
    const store = seededStore(ARCHIVED_PR)
    expect(store.getLocalReview(LOCAL_ID)?.archivedPr).toBe(ARCHIVED_PR)
    expect(store.getLocalSnapshot(LOCAL_ID)?.mutable.threads.map((t) => t.id)).toEqual([THREAD_ID])
    expect(store.listLocalSubmittedReviews(LOCAL_ID).map((r) => r.id)).toEqual([SEEDED_SUMMARY_ID])
    expect(store.getLocalDraft(SESSION.human.id, LOCAL_ID)).toEqual(SEEDED_DRAFT)
  })

  test('a submit answers forbidden as a value carrying the refusal sentence, and writes nothing', async () => {
    const store = seededStore(ARCHIVED_PR)
    const before = store.serialize()
    const result = await localWrites.submitLocalReview(
      makeLocalDeps(store),
      submitWithAComment(HEAD_SHA),
    )
    expect(result).toEqual({ status: 'forbidden', reason: REFUSAL })
    expect(store.serialize()).toBe(before)
  })

  test('the control: the same submit on the same seed with the review live lands and moves the store', async () => {
    const store = seededStore(null)
    const before = store.serialize()
    const result = await localWrites.submitLocalReview(
      makeLocalDeps(store),
      submitWithAComment(HEAD_SHA),
    )
    expect(result.status).toBe('ok')
    expect(store.serialize()).not.toBe(before)
  })

  for (const [verb, call] of THROWING_VERBS) {
    test(`${verb} throws a typed forbidden carrying the refusal sentence, and writes nothing`, async () => {
      const store = seededStore(ARCHIVED_PR)
      const before = store.serialize()
      expect(await outcomeOf(() => call(makeLocalDeps(store)))).toBe(`forbidden: ${REFUSAL}`)
      expect(store.serialize()).toBe(before)
    })

    test(`the control: ${verb} on the same seed with the review live answers and moves the store`, async () => {
      const store = seededStore(null)
      const before = store.serialize()
      expect(await outcomeOf(() => call(makeLocalDeps(store)))).toBe('answered')
      expect(store.serialize()).not.toBe(before)
    })
  }

  test('the refusal precedes the head guard: a submit quoting a moved head is forbidden, not head_moved', async () => {
    // The head guard is the first read that could answer something other than
    // the refusal. Against the live seed the same input IS a moved head, which
    // is what makes the archived answer evidence of ordering rather than of a
    // guard that never ran.
    const archived = await localWrites.submitLocalReview(
      makeLocalDeps(seededStore(ARCHIVED_PR)),
      submitWithAComment(MOVED_HEAD_SHA),
    )
    expect(archived).toEqual({ status: 'forbidden', reason: REFUSAL })
    const live = await localWrites.submitLocalReview(
      makeLocalDeps(seededStore(null)),
      submitWithAComment(MOVED_HEAD_SHA),
    )
    expect(live.status).toBe('head_moved')
  })

  test('the refusal precedes the thread lookup: a reply to a thread the review does not hold is forbidden, not not_found', async () => {
    const archived = await outcomeOf(() =>
      localWrites.replyToLocalThread(
        makeLocalDeps(seededStore(ARCHIVED_PR)),
        LOCAL_ID,
        UNKNOWN_THREAD_ID,
        'Aimed at nothing.',
      ),
    )
    expect(archived).toBe(`forbidden: ${REFUSAL}`)
    // The live seed answers the lookup's own refusal for the same thread id.
    const live = await outcomeOf(() =>
      localWrites.replyToLocalThread(
        makeLocalDeps(seededStore(null)),
        LOCAL_ID,
        UNKNOWN_THREAD_ID,
        'Aimed at nothing.',
      ),
    )
    expect(live.startsWith('not_found: ')).toBe(true)
  })

  test('every read still answers what it answered before the archive, after all four refusals', async () => {
    const store = seededStore(null)
    const deps = makeLocalDeps(store)
    const snapshotBefore = deps.getLocalSnapshot(LOCAL_ID)
    const draftBefore = deps.getLocalDraft(SESSION.human.id, LOCAL_ID)
    const threadsBefore = store.listLocalThreads(LOCAL_ID)

    store.markLocalReviewArchived(LOCAL_ID, ARCHIVED_PR)
    // The mark landed, so the reads below are reads of an archived review.
    expect(deps.getLocalReview(LOCAL_ID)?.archivedPr).toBe(ARCHIVED_PR)

    expect(await localWrites.submitLocalReview(deps, submitWithAComment(HEAD_SHA))).toEqual({
      status: 'forbidden',
      reason: REFUSAL,
    })
    for (const [, call] of THROWING_VERBS) {
      expect(await outcomeOf(() => call(deps))).toBe(`forbidden: ${REFUSAL}`)
    }

    expect(deps.getLocalSnapshot(LOCAL_ID)).toEqual(snapshotBefore)
    expect(deps.getLocalDraft(SESSION.human.id, LOCAL_ID)).toEqual(draftBefore)
    expect(store.listLocalThreads(LOCAL_ID)).toEqual(threadsBefore)
    // The reads compared above are reads of something: the seed was not empty.
    expect(snapshotBefore).not.toBeNull()
    expect(draftBefore).not.toBeNull()
    expect(threadsBefore).toHaveLength(1)
  })

  test('a review with no row reads as live, which is the state every earlier case ran in', () => {
    expect(makeLocalStore().getLocalReview(LOCAL_ID)).toBeNull()
  })

  test('the harness archive mark is write-once, as the durable column is', () => {
    const store = seededStore(null)
    store.markLocalReviewArchived(LOCAL_ID, ARCHIVED_PR)
    store.markLocalReviewArchived(LOCAL_ID, ARCHIVED_PR + 1)
    expect(store.getLocalReview(LOCAL_ID)?.archivedPr).toBe(ARCHIVED_PR)
  })

  test('the harness serialization stands still across reads and moves on a write', () => {
    // Without this, "serialized identically" would also hold over a
    // serialization that never changes — the byte comparisons above rest on
    // the string moving when, and only when, something was written.
    const store = seededStore(ARCHIVED_PR)
    const before = store.serialize()
    store.getLocalSnapshot(LOCAL_ID)
    store.getLocalDraft(SESSION.human.id, LOCAL_ID)
    store.listLocalThreads(LOCAL_ID)
    expect(store.serialize()).toBe(before)
    store.putLocalThread(LOCAL_ID, localThread({ id: UNKNOWN_THREAD_ID, comments: [] }, { headSha: HEAD_SHA, at: FIXED_NOW }))
    expect(store.serialize()).not.toBe(before)
  })
})
