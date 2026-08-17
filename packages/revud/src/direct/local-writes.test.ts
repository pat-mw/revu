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
 * The verbs land one at a time, so this file keeps two disjoint lists of them:
 * the ones whose behaviour is written and the ones still refusing. Every case
 * that asserts a refusal runs over the second list only, and the two lists are
 * checked against the module's exports. That is what stops the refusal cases
 * being quietly weakened into conditionals as each verb arrives — a refusal
 * case that tolerates a verb answering is one that would stay green if all four
 * stopped refusing at once.
 */
import { describe, expect, test } from 'bun:test'
import type {
  CommitInfo,
  GhUser,
  PendingComment,
  ReviewComment,
  ReviewDraft,
  ReviewSummary,
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
 * The verbs whose behaviour is still unwritten, and the verbs whose behaviour is
 * written, as two disjoint lists covering the module's whole export surface.
 *
 * Splitting them is what keeps the refusal cases honest as the verbs land one at
 * a time. A refusal case looped over every export would have to be weakened —
 * skipped, or made conditional on what the verb happens to do — the moment the
 * first verb gained behaviour, and a weakened refusal case is one that passes
 * whether or not the remaining verbs still refuse. Instead each verb is listed
 * in exactly one bucket, and the pair is checked against the export list, so a
 * verb cannot be implemented without being moved and cannot be added without
 * being classified.
 */
const UNWRITTEN_VERBS: readonly string[] = [
  'addLocalReaction',
  'replyToLocalThread',
  'resolveLocalThread',
]

const IMPLEMENTED_VERBS: readonly string[] = ['submitLocalReview']

/** The subset of the call table whose verbs still refuse. */
const UNWRITTEN_VERB_CALLS = VERB_CALLS.filter(([verb]) => UNWRITTEN_VERBS.includes(verb))

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

  test('every verb is classified as written or unwritten, and none as both', () => {
    // The pair has to cover the export list exactly. A verb left out of both
    // buckets would be driven by the call table above and by nothing that
    // asserts what it does; a verb in both would let the refusal loop and the
    // behaviour cases disagree about the same function with neither failing.
    expect([...UNWRITTEN_VERBS, ...IMPLEMENTED_VERBS].sort()).toEqual(
      Object.keys(localWrites).sort(),
    )
    expect(UNWRITTEN_VERBS.filter((verb) => IMPLEMENTED_VERBS.includes(verb))).toEqual([])
  })

  test('the refusal cases below run over exactly the unwritten verbs', () => {
    // The filter that selects them is a name match, so a rename on one side and
    // not the other would empty the loop silently — a describe that runs no
    // cases is reported as green, not as missing.
    expect(UNWRITTEN_VERB_CALLS.map(([verb]) => verb).sort()).toEqual([...UNWRITTEN_VERBS].sort())
  })
})

describe('no verb answers for a local review that has never been synced', () => {
  test('every verb fails rather than returning a value', async () => {
    // Collected and compared in one shot rather than asserted inside the loop:
    // an assertion per iteration stops at the first failure, so a verb that
    // started answering would hide every verb after it in the table.
    const outcomes = await Promise.all(
      VERB_CALLS.map(async ([verb, call]) => {
        const failed = await call(makeLocalDeps()).then(
          () => false,
          () => true,
        )
        return [verb, failed] as const
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
})

describe('a verb refuses rather than answering until its behaviour is written', () => {
  for (const [verb, call] of UNWRITTEN_VERB_CALLS) {
    test(`${verb} rejects, naming itself`, async () => {
      // Anchored on the verb's own name so the red comes from the refusal and
      // not from some other throw the call happens to hit on the way.
      await expect(call(makeLocalDeps())).rejects.toThrow(verb)
    })

    test(`${verb} leaves the draft byte-identical when it refuses`, async () => {
      const deps = makeLocalDeps()
      const before = deps.getLocalDraft(SESSION.human.id, LOCAL_ID)
      expect(before).not.toBeNull()
      await expect(call(deps)).rejects.toThrow()
      const after = deps.getLocalDraft(SESSION.human.id, LOCAL_ID)
      // Byte-identical, not merely present: a draft silently rewritten by a
      // failed write loses the reviewer's text just as thoroughly as a deleted
      // one, and only the serialized comparison catches that.
      expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    })
  }
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
