/**
 * Band dispatch on the direct API surface.
 *
 * A review created against a local branch pair has no pull request behind it,
 * so it carries a synthetic id from the reserved local band. Every id-keyed
 * method on the surface has to recognise that band and route to the local
 * review surface BEFORE it touches the GitHub client or the pull-request
 * tables. Three claims are pinned here, and each is only worth something
 * because the others can fail:
 *
 *   - a local id is served entirely by the local surface, and NOT ONE
 *     `GithubClient` method is even entered;
 *   - a real pull-request number still takes the GitHub/store path and the
 *     local surface is never consulted — so the branch is on the ID, not on the
 *     mere presence of a local surface, and the "no GitHub call" claim above is
 *     demonstrably capable of failing;
 *   - a local id with no local surface wired is a typed `not_found`, never a
 *     fall-through to GitHub.
 *
 * The last test derives its case table from the surface itself: every
 * function-valued key of the built api must appear in exactly one of two
 * literal name lists — those that dispatch on the band, and those that must
 * not. A method added later fails that assertion until someone classifies it,
 * which is the only thing keeping "every id-keyed method dispatches" true as
 * the surface grows.
 *
 * The GitHub client is the throwing stub wrapped in a call recorder, so
 * "nothing reached GitHub" is an assertion over a recorded list rather than an
 * absence nobody checks.
 */
import { describe, expect, test } from 'bun:test'
import type {
  BranchRef,
  CreateLocalReviewInput,
  FileViewedState,
  GhUser,
  LocalReviewSummary,
  ReactionKey,
  ReactionRollup,
  ReconcileReport,
  ReviewComment,
  ReviewDraft,
  ReviewSummary,
  ReviewThread,
  Session,
  Snapshot,
  SnapshotImmutable,
  SubmitResult,
  SubmitReviewInput,
} from '@revu/shared'
import { ApiError, LOCAL_ENTITY_ID_BASE, LOCAL_REVIEW_ID_BASE } from '@revu/shared'
import type { DirectApi } from './direct-api'
import { createDirectApi } from './direct-api'
import type { GithubClient } from './github-client'
import { throwingGithubClient } from './github-write-stubs'
import type { LocalReviewSurface } from './local-surface'
import type { RepoRef } from './repo'
import { openDirectStore, type DirectStore } from './store'

const REPO: RepoRef = { owner: 'o', repo: 'r' }
const SESSION: Session = {
  human: { id: 'alice@x.io', name: 'Alice', role: 'contractor', email: 'alice@x.io' },
  brokerLogin: '',
  workspace: 'direct-o-r',
  viewerLogin: 'alice-gh',
}

/** The id of the local review every dispatch assertion is driven with. */
const LOCAL_ID = LOCAL_REVIEW_ID_BASE + 7
/** A real pull-request number — the negative control for the same drive. */
const PR_ID = 204

const NOW_ISO = '2026-01-01T00:00:00.000Z'
const now = (): string => NOW_ISO

// ——— fixtures ———

function ghUser(login: string): GhUser {
  return {
    login,
    id: 1,
    node_id: 'U_1',
    avatar_url: 'https://example.invalid/a.png',
    html_url: 'https://example.invalid/u',
    type: 'User',
  }
}

function immutable(compareKey: string): SnapshotImmutable {
  return {
    compareKey,
    mergeBaseSha: 'base',
    headSha: 'head',
    files: [
      {
        sha: 'headblob',
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -1 +1 @@',
      },
    ],
    blobIndex: { 'a.ts': { base: 'baseblob', head: 'headblob' } },
    commits: [],
  }
}

function rollup(): ReactionRollup {
  return {
    url: 'https://example.invalid/reactions',
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
}

function reviewComment(id: number): ReviewComment {
  return {
    id,
    node_id: `C_${id}`,
    pull_request_review_id: null,
    path: 'a.ts',
    diff_hunk: '@@ -1 +1 @@',
    commit_id: 'head',
    original_commit_id: 'head',
    line: 1,
    original_line: 1,
    start_line: null,
    original_start_line: null,
    side: 'RIGHT',
    start_side: null,
    subject_type: 'line',
    user: ghUser('alice-gh'),
    body: 'a comment',
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    reactions: rollup(),
    html_url: 'https://example.invalid/c',
  }
}

function reviewThread(id: string, commentId: number): ReviewThread {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: 'a.ts',
    line: 1,
    originalLine: 1,
    startLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    startDiffSide: null,
    subjectType: 'LINE',
    resolvedBy: null,
    comments: [reviewComment(commentId)],
  }
}

function reviewSummary(id: number): ReviewSummary {
  return {
    id,
    node_id: `R_${id}`,
    user: ghUser('alice-gh'),
    body: 'looks fine',
    state: 'COMMENTED',
    submitted_at: NOW_ISO,
    commit_id: 'head',
  }
}

function snapshot(prNumber: number, compareKey: string, threadId: string): Snapshot {
  return {
    prNumber,
    syncedAt: NOW_ISO,
    partial: null,
    syncStats: { blobsFetched: 0, blobsReused: 0, requests: 5 },
    immutable: immutable(compareKey),
    mutable: {
      fetchedAt: NOW_ISO,
      pull: { number: prNumber } as Snapshot['mutable']['pull'],
      threads: [reviewThread(threadId, 5001)],
      issueComments: [],
      reviews: [],
      checks: [],
    },
  }
}

function draft(humanId: string, prNumber: number, body: string): ReviewDraft {
  return {
    humanId,
    prNumber,
    headSha: 'head',
    compareKey: 'base...head',
    body,
    event: 'COMMENT',
    comments: [],
    createdAt: NOW_ISO,
    updatedAt: '2025-12-31T00:00:00.000Z',
  }
}

function submitInput(prNumber: number): SubmitReviewInput {
  return {
    prNumber,
    expectedHeadSha: 'head',
    event: 'COMMENT',
    body: 'submitting',
    comments: [],
  }
}

// What the fake local surface answers with. Distinct from anything the store
// holds, so "the local surface answered" and "the store answered" can never be
// confused for one another.
const LOCAL_SNAPSHOT = snapshot(LOCAL_ID, 'local-base...local-head', 'LOCALTHREAD_1')
const LOCAL_DRAFT = draft(SESSION.human.id, LOCAL_ID, 'the local draft')
const LOCAL_REPORT: ReconcileReport = {
  prNumber: LOCAL_ID,
  draftHeadSha: 'local-head',
  currentHeadSha: 'local-head',
  newCommits: [],
  results: [],
}
const LOCAL_VIEWED: FileViewedState = {
  'a.ts': { viewed: true, blobSha: 'localblob', at: NOW_ISO },
}
const LOCAL_SUBMIT: SubmitResult = { status: 'ok', review: reviewSummary(7001) }
const LOCAL_COMMENT = reviewComment(LOCAL_ENTITY_ID_BASE + 3)
const LOCAL_THREAD = reviewThread('LOCALTHREAD_1', LOCAL_ENTITY_ID_BASE + 3)
const LOCAL_ROLLUP = rollup()

// ——— test doubles ———

/**
 * The throwing GitHub client with every method wrapped in a recorder. The name
 * is pushed BEFORE the stub throws, so an attempted call is recorded even
 * though it never returns — which is what makes "no GitHub call happened" an
 * assertion over evidence rather than over the absence of a thrown error.
 */
function recordingGithubClient(): { client: GithubClient; calls: string[] } {
  const calls: string[] = []
  const base = throwingGithubClient() as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >
  const wrapped: Record<string, (...args: unknown[]) => unknown> = {}
  for (const name of Object.keys(base)) {
    wrapped[name] = (...args: unknown[]): unknown => {
      calls.push(name)
      return base[name](...args)
    }
  }
  return { client: wrapped as unknown as GithubClient, calls }
}

/** Everything the fake local surface was asked to do, in order. */
interface SurfaceSpy {
  calls: string[]
  savedDraft: ReviewDraft | null
  viewedArgs: { path: string; viewed: boolean; blobSha: string | null } | null
  submitted: SubmitReviewInput | null
  reactionArgs: { commentId: number; reaction: ReactionKey } | null
}

function fakeLocalSurface(): { surface: LocalReviewSurface; spy: SurfaceSpy } {
  const spy: SurfaceSpy = {
    calls: [],
    savedDraft: null,
    viewedArgs: null,
    submitted: null,
    reactionArgs: null,
  }
  const surface: LocalReviewSurface = {
    async createLocalReview(input: CreateLocalReviewInput): Promise<LocalReviewSummary> {
      spy.calls.push('createLocalReview')
      return {
        id: LOCAL_ID,
        repo: 'o/r',
        baseRef: input.baseRef,
        headRef: input.headRef,
        title: input.title ?? input.headRef,
        baseSha: null,
        mergeBaseSha: null,
        headSha: null,
        dirty: false,
        archivedPr: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        lastSyncedAt: null,
      }
    },
    listLocalReviews(): LocalReviewSummary[] {
      spy.calls.push('listLocalReviews')
      return []
    },
    async listBranches(): Promise<BranchRef[]> {
      spy.calls.push('listBranches')
      return []
    },
    async syncPull(localId: number): Promise<Snapshot> {
      spy.calls.push(`syncPull:${localId}`)
      return LOCAL_SNAPSHOT
    },
    getSnapshot(localId: number): Snapshot | null {
      spy.calls.push(`getSnapshot:${localId}`)
      return LOCAL_SNAPSHOT
    },
    getDraft(localId: number): ReviewDraft | null {
      spy.calls.push(`getDraft:${localId}`)
      return LOCAL_DRAFT
    },
    saveDraft(d: ReviewDraft): ReviewDraft {
      spy.calls.push(`saveDraft:${d.prNumber}`)
      spy.savedDraft = d
      return d
    },
    discardDraft(localId: number): void {
      spy.calls.push(`discardDraft:${localId}`)
    },
    reconcileDraft(localId: number): ReconcileReport {
      spy.calls.push(`reconcileDraft:${localId}`)
      return LOCAL_REPORT
    },
    getFileViewed(localId: number): FileViewedState {
      spy.calls.push(`getFileViewed:${localId}`)
      return LOCAL_VIEWED
    },
    setFileViewed(
      localId: number,
      path: string,
      viewed: boolean,
      blobSha: string | null,
    ): FileViewedState {
      spy.calls.push(`setFileViewed:${localId}`)
      spy.viewedArgs = { path, viewed, blobSha }
      return LOCAL_VIEWED
    },
    async submitReview(input: SubmitReviewInput): Promise<SubmitResult> {
      spy.calls.push(`submitReview:${input.prNumber}`)
      spy.submitted = input
      return LOCAL_SUBMIT
    },
    async replyToThread(
      localId: number,
      _threadId: string,
      _body: string,
    ): Promise<ReviewComment> {
      spy.calls.push(`replyToThread:${localId}`)
      return LOCAL_COMMENT
    },
    async resolveThread(
      localId: number,
      _threadId: string,
      _resolved: boolean,
    ): Promise<ReviewThread> {
      spy.calls.push(`resolveThread:${localId}`)
      return LOCAL_THREAD
    },
    async addReaction(
      localId: number,
      commentId: number,
      reaction: ReactionKey,
    ): Promise<ReactionRollup> {
      spy.calls.push(`addReaction:${localId}`)
      spy.reactionArgs = { commentId, reaction }
      return LOCAL_ROLLUP
    },
    listThreads(localId: number): ReviewThread[] {
      spy.calls.push(`listThreads:${localId}`)
      return [LOCAL_THREAD]
    },
  }
  return { surface, spy }
}

interface Harness {
  api: DirectApi
  store: DirectStore
  githubCalls: string[]
  spy: SurfaceSpy
}

/** Build the surface over an in-memory store; `local: false` omits the dep. */
function build(opts: { local: boolean }): Harness {
  const store = openDirectStore({ dataDir: ':memory:' })
  const { client, calls } = recordingGithubClient()
  const { surface, spy } = fakeLocalSurface()
  const api = createDirectApi({
    session: SESSION,
    github: client,
    repo: REPO,
    store,
    now,
    ...(opts.local ? { localReviews: surface } : {}),
  })
  return { api, store, githubCalls: calls, spy }
}

/**
 * The id-keyed methods: each takes a review id (positionally, or inside its
 * input object) and MUST branch on the band before reaching GitHub or the
 * pull-request store.
 */
const DISPATCHING = [
  'syncPull',
  'getSnapshot',
  'getDraft',
  'saveDraft',
  'discardDraft',
  'reconcileDraft',
  'getFileViewed',
  'setFileViewed',
  'submitReview',
  'replyToThread',
  'resolveThread',
  'addReaction',
]

/**
 * The methods that take no review id and must NOT dispatch: `getBlob` is
 * content-addressed and the local store reuses the one blob table, preferences
 * are keyed by the human, and the two list/allowance reads take no id at all.
 */
const NON_DISPATCHING = [
  'listPulls',
  'getRateLimit',
  'getBlob',
  'getPreferences',
  'setPreferences',
]

describe('direct api band dispatch', () => {
  test('a local id is served by the local surface, and GitHub is never entered', async () => {
    const { api, store, githubCalls, spy } = build({ local: true })

    expect(await api.syncPull(LOCAL_ID)).toEqual(LOCAL_SNAPSHOT)
    expect(api.getSnapshot(LOCAL_ID)).toEqual(LOCAL_SNAPSHOT)
    expect(api.getDraft(LOCAL_ID)).toEqual(LOCAL_DRAFT)

    // The draft is re-keyed to the session's human on the local branch exactly
    // as it is on the pull-request branch — a caller cannot write another
    // human's local draft by putting their id in the body.
    const saved = api.saveDraft(draft('mallory@x.io', LOCAL_ID, 'body'))
    expect(saved.humanId).toBe(SESSION.human.id)
    expect(saved.updatedAt).toBe(NOW_ISO)
    expect(spy.savedDraft?.humanId).toBe(SESSION.human.id)

    api.discardDraft(LOCAL_ID)
    expect(api.reconcileDraft(LOCAL_ID)).toEqual(LOCAL_REPORT)
    expect(api.getFileViewed(LOCAL_ID)).toEqual(LOCAL_VIEWED)
    expect(api.setFileViewed(LOCAL_ID, 'a.ts', true, 'localblob')).toEqual(LOCAL_VIEWED)
    expect(spy.viewedArgs).toEqual({ path: 'a.ts', viewed: true, blobSha: 'localblob' })

    expect(await api.submitReview(submitInput(LOCAL_ID))).toEqual(LOCAL_SUBMIT)
    expect(await api.replyToThread(LOCAL_ID, 'LOCALTHREAD_1', 'hi')).toEqual(LOCAL_COMMENT)
    expect(await api.resolveThread(LOCAL_ID, 'LOCALTHREAD_1', true)).toEqual(LOCAL_THREAD)
    expect(await api.addReaction(LOCAL_ID, LOCAL_ENTITY_ID_BASE + 3, 'heart')).toEqual(
      LOCAL_ROLLUP,
    )
    expect(spy.reactionArgs).toEqual({
      commentId: LOCAL_ENTITY_ID_BASE + 3,
      reaction: 'heart',
    })

    // Every id-keyed method reached the local surface, with the local id intact.
    expect(spy.calls).toEqual([
      `syncPull:${LOCAL_ID}`,
      `getSnapshot:${LOCAL_ID}`,
      `getDraft:${LOCAL_ID}`,
      `saveDraft:${LOCAL_ID}`,
      `discardDraft:${LOCAL_ID}`,
      `reconcileDraft:${LOCAL_ID}`,
      `getFileViewed:${LOCAL_ID}`,
      `setFileViewed:${LOCAL_ID}`,
      `submitReview:${LOCAL_ID}`,
      `replyToThread:${LOCAL_ID}`,
      `resolveThread:${LOCAL_ID}`,
      `addReaction:${LOCAL_ID}`,
    ])

    // Not one GithubClient method was even entered...
    expect(githubCalls).toEqual([])
    // ...and nothing leaked into the pull-request tables under a local id.
    expect(store.getSnapshot(LOCAL_ID)).toBeNull()
    expect(store.getDraft(SESSION.human.id, LOCAL_ID)).toBeNull()
    expect(store.getViewed(SESSION.human.id, LOCAL_ID)).toEqual({})
    store.close()
  })

  test('a pull-request id still takes the GitHub and store paths', async () => {
    const { api, store, githubCalls, spy } = build({ local: true })
    const prSnapshot = snapshot(PR_ID, 'pr-base...pr-head', 'PRRT_1')
    const prDraft = draft(SESSION.human.id, PR_ID, 'the pull-request draft')
    store.putSnapshot(prSnapshot)
    store.putDraft(prDraft)

    // The five that go out to GitHub: the throwing stub fires, which is the
    // proof that the empty `githubCalls` above is an assertion that CAN fail.
    // The stub set raises two message families — one for the read methods, one
    // for the write methods it shares with the read-path stubs — and both mean
    // the same thing here: a `GithubClient` method was entered.
    const stubFired = /(did not stub GithubClient|sync read path must not call)/
    await expect(api.syncPull(PR_ID)).rejects.toThrow(stubFired)
    await expect(api.submitReview(submitInput(PR_ID))).rejects.toThrow(stubFired)
    await expect(api.replyToThread(PR_ID, 'PRRT_1', 'hi')).rejects.toThrow(stubFired)
    await expect(api.resolveThread(PR_ID, 'PRRT_1', true)).rejects.toThrow(stubFired)
    await expect(api.addReaction(PR_ID, 5001, 'heart')).rejects.toThrow(stubFired)
    expect(githubCalls).toEqual([
      'getPullDetail',
      'getPullDetail',
      'replyToReviewComment',
      'setThreadResolution',
      'addReaction',
    ])

    // The seven that never leave the process still answer from the
    // pull-request store, not from the local surface.
    expect(api.getSnapshot(PR_ID)).toEqual(prSnapshot)
    expect(api.getDraft(PR_ID)).toEqual(prDraft)
    expect(api.saveDraft(draft(SESSION.human.id, PR_ID, 'edited')).body).toBe('edited')
    expect(store.getDraft(SESSION.human.id, PR_ID)?.body).toBe('edited')
    expect(api.reconcileDraft(PR_ID).prNumber).toBe(PR_ID)
    expect(api.getFileViewed(PR_ID)).toEqual({})
    expect(api.setFileViewed(PR_ID, 'a.ts', true, 'headblob')['a.ts']?.viewed).toBe(true)
    api.discardDraft(PR_ID)
    expect(store.getDraft(SESSION.human.id, PR_ID)).toBeNull()

    // The local surface was not consulted once — the branch is on the id, not
    // on the presence of the dep.
    expect(spy.calls).toEqual([])
    store.close()
  })

  test('a local id with no local surface wired is a typed not_found', async () => {
    const { api, githubCalls, store } = build({ local: false })

    const notFound = (fn: () => unknown): void => {
      let threw: unknown = null
      let returned = false
      try {
        fn()
        returned = true
      } catch (err) {
        threw = err
      }
      expect(returned).toBe(false)
      expect(threw).toBeInstanceOf(ApiError)
      expect((threw as ApiError).code).toBe('not_found')
    }

    notFound(() => api.getSnapshot(LOCAL_ID))
    notFound(() => api.getDraft(LOCAL_ID))
    notFound(() => api.saveDraft(draft(SESSION.human.id, LOCAL_ID, 'body')))
    notFound(() => api.discardDraft(LOCAL_ID))
    notFound(() => api.reconcileDraft(LOCAL_ID))
    notFound(() => api.getFileViewed(LOCAL_ID))
    notFound(() => api.setFileViewed(LOCAL_ID, 'a.ts', true, null))

    for (const call of [
      (): Promise<unknown> => api.syncPull(LOCAL_ID),
      (): Promise<unknown> => api.submitReview(submitInput(LOCAL_ID)),
      (): Promise<unknown> => api.replyToThread(LOCAL_ID, 'LOCALTHREAD_1', 'hi'),
      (): Promise<unknown> => api.resolveThread(LOCAL_ID, 'LOCALTHREAD_1', true),
      (): Promise<unknown> => api.addReaction(LOCAL_ID, LOCAL_ENTITY_ID_BASE + 3, 'heart'),
    ]) {
      const outcome = await call().then(
        () => ({ resolved: true, err: null as unknown }),
        (e: unknown) => ({ resolved: false, err: e }),
      )
      expect(outcome.resolved).toBe(false)
      expect(outcome.err).toBeInstanceOf(ApiError)
      expect((outcome.err as ApiError).code).toBe('not_found')
    }

    expect(githubCalls).toEqual([])
    store.close()
  })

  test('every function-valued key of the surface is classified', () => {
    const { api, store } = build({ local: true })
    const record = api as unknown as Record<string, unknown>
    const functionKeys = Object.keys(api).filter((k) => typeof record[k] === 'function')

    // Union, exactly: a method added to DirectApi later fails here until
    // someone decides which list it belongs in.
    expect(functionKeys.slice().sort()).toEqual([...DISPATCHING, ...NON_DISPATCHING].sort())
    // Disjoint, so a name cannot satisfy the union by sitting in both lists.
    expect(DISPATCHING.filter((k) => NON_DISPATCHING.includes(k))).toEqual([])
    // `getSession` is served by the router from the session itself; it is not
    // part of this surface, and the union above would fail if it ever were.
    expect(functionKeys).not.toContain('getSession')
    store.close()
  })
})
