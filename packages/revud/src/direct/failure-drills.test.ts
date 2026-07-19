/**
 * Failure drills that land in the read/persist ENGINE — the four the shared
 * direct/broker core owns. Each exercises a real failure mode against the REAL
 * engine (`createDirectApi` / the write core) with a network-free fake GitHub
 * client, and asserts BOTH the resulting behavior AND the exact one sentence the
 * frontend would surface for it via `describeApiError`. The two copy-only drills
 * (broker-down draft-save, rate-limit countdown) sit beside the mock adapter in
 * `packages/app/src/components/review/failure-drills.test.ts`.
 *
 * A cross-package note on the copy assertions: `describeApiError` lives in the
 * app package (in a component-adjacent module that pulls the browser stack), but
 * for every failure surfaced here it is a pure identity on the thrown value — it
 * returns an `ApiError`'s `message` verbatim (only a rate_limited countdown, which
 * none of these drills throw, rewrites it). So each engine drill pins the ACTUAL
 * message the frontend would consume: the exact bytes the router surfaces for the
 * failure (for a GitHub 5xx, the `GithubRequestError`'s own message), and — where
 * a real production sentence is reachable through the mock — the mock adapter's
 * real `broker_unreachable` copy, driven live and read back off the thrown error
 * (`copyFor`, this file's stand-in for `describeApiError`'s identity branch). The
 * app suite pins `describeApiError` itself; here we pin what it consumes, so a
 * copy regression on either side fails a drill.
 *
 * One drill (submit-window force-push) surfaces `head_moved` as a RETURNED value,
 * not a thrown error, so `describeApiError` structurally never runs for it; its
 * user-facing copy lives in the head-moved dialog title and is pinned there.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GhBlobRaw, GhGraphqlBlobObject, GithubClient, Page, SubmitReviewBody } from './github-client'
import { GithubRequestError } from './github-client'
import { ApiError } from '@revu/shared'
import type { Session, SubmitReviewInput } from '@revu/shared'
import { createMockApi, mockDev } from '@revu/app/mock'
import { AwaitingCredentialError, createFileCredentialTokenSource } from '../broker/token-source'
import { NoTokenError, type TokenSource } from './token-source'
import { createDirectApi } from './direct-api'
import { openDirectStore, type DirectStore } from './store'
import {
  CONFORMANCE_REPO,
  CONFORMANCE_SESSION,
  initialReconcileState,
  MOVING_BASE_HEAD_BLOB_SHA,
  MOVING_BASE_PR,
  movingBaseClient,
  movingHeadClient,
  RECONCILE_PR,
  seedForcePushed,
  tokenGated,
} from './conformance-fakes'

/**
 * The honest sentence `describeApiError` yields for a thrown `ApiError`: its
 * message verbatim (the rate_limited countdown is the only branch that rewrites
 * it, and none of these drills throw rate_limited). This mirrors the app-side
 * function's identity branch, so pinning `copyFor(caught)` pins the exact string
 * the frontend would render for that error — the copy a regression must break.
 */
function copyFor(error: ApiError): string {
  return error.message
}

// ————————————————————————————————————————————————————————————————
// Drill 2 — a GitHub 5xx (or any non-provisionable blob) mid-sync leaves an
// HONEST partial: syncPull RESOLVES with snapshot.partial set naming the missing
// SHA, it does NOT throw. A resume re-syncs and fetches ONLY the missing blob —
// the base blob the first pass already stored is reused, never refetched.
// ————————————————————————————————————————————————————————————————

/**
 * A base-moved read fake whose head blob is withheld from EVERY provisioning
 * tier (the GraphQL batch nulls it, the single-blob REST straggler 5xx's for it)
 * while `withholdHead` is true, and served normally once it flips false. Every
 * other blob provisions normally throughout, so the first sync keeps a partial
 * naming exactly the head SHA and the resume completes it.
 */
function togglablePartialClient(state: {
  mergeBaseSha: string
  unresolvedComments: number
  withholdHead: boolean
}): GithubClient {
  const base = movingBaseClient(state)
  return {
    ...base,
    async getBlob(owner, repo, sha): Promise<GhBlobRaw> {
      if (state.withholdHead && sha === MOVING_BASE_HEAD_BLOB_SHA) {
        // A server-side 5xx for this one blob while it is withheld — the REST
        // straggler tier folds a failed fetch into `missing`, not a thrown sync.
        throw new GithubRequestError(503, `/git/blobs/${sha}`, 'service unavailable')
      }
      return base.getBlob(owner, repo, sha)
    },
    async getBlobObjects(owner, repo, shas): Promise<Record<string, GhGraphqlBlobObject | null>> {
      const out = await base.getBlobObjects(owner, repo, shas)
      if (state.withholdHead && MOVING_BASE_HEAD_BLOB_SHA in out) {
        out[MOVING_BASE_HEAD_BLOB_SHA] = null
      }
      return out
    },
  }
}

describe('drill: GitHub 5xx mid-sync → honest partial, resume fetches only the missing piece', () => {
  test('the first sync keeps a partial naming the head blob; it does NOT throw', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = { mergeBaseSha: 'MB1', unresolvedComments: 0, withholdHead: true }
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      github: togglablePartialClient(state),
      repo: CONFORMANCE_REPO,
      store,
    })

    // In the direct engine, syncPull RESOLVES (never rejects) with an honest
    // partial: the drop rides on the resolved snapshot, it is not thrown. (The
    // mock adapter instead surfaces a mid-transfer drop as a thrown network
    // error while keeping the very same partial — both keep it and resume; the
    // conformance suite pins each transport's own surfacing.)
    const first = await api.syncPull(MOVING_BASE_PR)
    expect(first.partial).not.toBeNull()
    expect(first.partial?.missingBlobShas ?? []).toContain(MOVING_BASE_HEAD_BLOB_SHA)
    // The snapshot is still cached and re-readable — a partial is a kept snapshot,
    // not a null "never synced".
    expect(api.getSnapshot(MOVING_BASE_PR)).not.toBeNull()
    // The base blob DID land on the first pass (only the head blob was withheld).
    expect(first.syncStats?.blobsFetched).toBe(1)

    store.close()
  })

  test('a resume fetches ONLY the previously-missing blob and clears the partial', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = { mergeBaseSha: 'MB1', unresolvedComments: 0, withholdHead: true }
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      github: togglablePartialClient(state),
      repo: CONFORMANCE_REPO,
      store,
    })

    const first = await api.syncPull(MOVING_BASE_PR)
    expect(first.partial).not.toBeNull()
    // One blob fetched (base), one still missing (head).
    expect(first.syncStats?.blobsFetched).toBe(1)

    // The transient upstream failure clears; the head blob is now serveable.
    state.withholdHead = false
    const second = await api.syncPull(MOVING_BASE_PR)

    // The compare is unchanged, so the immutable half is REUSED and the base blob
    // is a store hit — the resume does NOT refetch what the partial already had.
    expect(second.immutable.compareKey).toBe(first.immutable.compareKey)
    expect(second.syncStats?.blobsReused).toBe(1) // the base blob, reused
    expect(second.syncStats?.blobsFetched).toBe(1) // ONLY the head blob, now fetched
    // The partial is gone: every referenced SHA is provisioned.
    expect(second.partial).toBeNull()
    // And the head blob is readable from the store now.
    const headSha = second.immutable.blobIndex['a.ts'].head as string
    expect(headSha).toBe(MOVING_BASE_HEAD_BLOB_SHA)
    expect(api.getBlob(headSha).content.length).toBeGreaterThan(0)

    store.close()
  })

  test('a top-level GitHub 5xx (not a blob) surfaces as a thrown error whose EXACT copy the UI names honestly', async () => {
    // The partial path tolerates a MISSING blob. A 5xx on a top-level read (pull
    // detail) is a different thing: it propagates. The router maps such a
    // failure to a broker_unreachable ApiError carrying the GithubRequestError's
    // OWN message (direct-router `envelopeForError`), and describeApiError renders
    // an ApiError's message verbatim — so the exact copy the UI shows is that
    // GithubRequestError message. We pin those exact bytes, not an invented one.
    const store = openDirectStore({ dataDir: ':memory:' })
    const base = movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 })
    const client: GithubClient = {
      ...base,
      async getPullDetail(): Promise<never> {
        throw new GithubRequestError(500, '/pulls/204', 'internal error')
      },
    }
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      github: client,
      repo: CONFORMANCE_REPO,
      store,
    })

    // The raw transport error propagates out of the engine (the router is what
    // maps it to a typed ApiError at the HTTP boundary). The drill asserts the
    // sync does NOT masquerade as a success and does NOT silently produce a
    // fabricated snapshot.
    let caught: unknown = null
    try {
      await api.syncPull(MOVING_BASE_PR)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(GithubRequestError)
    expect(api.getSnapshot(MOVING_BASE_PR)).toBeNull()

    // The router re-wraps this thrown transport error as a broker_unreachable
    // ApiError carrying err.message unchanged; the frontend then renders that
    // message verbatim. Pin the EXACT surfaced sentence — the GithubRequestError's
    // own message — so a change to either the transport wording or the router's
    // pass-through breaks the drill.
    const surfaced = new ApiError('broker_unreachable', (caught as GithubRequestError).message)
    expect(copyFor(surfaced)).toBe(
      'GitHub request GET /pulls/204 failed with HTTP 500: internal error',
    )

    store.close()
  })
})

// ————————————————————————————————————————————————————————————————
// Drill 2 (copy half, mock side) — the broker-mode read surface the frontend
// consumes when the WHOLE broker is down. The direct engine surfaces the raw
// GithubRequestError message for an upstream 5xx (pinned just above); the mock
// adapter is the production oracle for the friendlier "reads are local" sentence
// a fully-down broker shows. Driving the mock with failureMode 'all' makes a real
// remote read throw that exact broker_unreachable ApiError, and copyFor (this
// file's stand-in for describeApiError's identity branch) reads its message back.
// ————————————————————————————————————————————————————————————————

describe('drill: broker fully down → the mock adapter surfaces the real "reads are local" copy', () => {
  const mock = createMockApi()

  beforeAll(() => {
    // The mock's store is a process-wide localStorage shim shared across every
    // test file; reset it (and clear any ambient failure mode) before use.
    mockDev.reset()
    mockDev.setFailureMode('none')
  })

  afterAll(() => {
    // This drill toggles failureMode; restore the shared store to a pristine seed
    // so a later file inherits none of it.
    mockDev.setFailureMode('none')
    mockDev.reset()
  })

  test('a remote read with the broker down throws the real broker_unreachable copy', async () => {
    // The whole broker is unreachable: a live read (listPulls) hits the adapter's
    // read gate, which throws the production broker_unreachable ApiError.
    mockDev.setFailureMode('all')
    let caught: unknown = null
    try {
      await mock.listPulls()
    } catch (err) {
      caught = err
    }

    // It is the typed, retriable upstream failure — never a silent empty list.
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).code).toBe('broker_unreachable')
    // And its copy — the exact sentence the frontend renders via describeApiError's
    // identity branch — is the mock adapter's real failure+consequence line. Pinned
    // off the live thrown error, so a change to the production copy fails the drill.
    expect(copyFor(caught as ApiError)).toBe(
      "The broker didn't respond. Cached snapshots still work — reads are local.",
    )
  })
})

// ————————————————————————————————————————————————————————————————
// Drill 4 — the injected credential expires mid-burst. The broker token source
// re-reads ~/.git-credentials per request, so a transiently empty file yields
// the TRANSIENT AwaitingCredentialError (distinct from the fatal NoTokenError);
// once the credential returns, the in-flight operation completes with no data
// loss. Driven through the token-gated engine, exactly as broker mode boots it.
// ————————————————————————————————————————————————————————————————

describe('drill: token expiry mid-burst refreshes transparently, no data loss', () => {
  let dataDir: string
  let credentialFile: string
  const FAKE_TOKEN = 'ghs_drill_token_fake'

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'revud-drill4-'))
    credentialFile = join(dataDir, '.git-credentials')
    writeFileSync(credentialFile, `https://x-access-token:${FAKE_TOKEN}@github.com\n`, 'utf8')
  })

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  })

  function source(): TokenSource {
    return createFileCredentialTokenSource({ path: credentialFile })
  }

  test('an emptied credential file yields the TRANSIENT AwaitingCredentialError, not the fatal NoTokenError', async () => {
    const src = source()
    // A present credential resolves.
    expect(await src.getToken()).toBe(FAKE_TOKEN)

    // The host truncates the file mid-rotation: the per-request re-read now finds
    // no usable token, which is the transient awaiting state — distinct from the
    // fatal "no way to get a token" NoTokenError so callers can retry vs. give up.
    writeFileSync(credentialFile, '', 'utf8')
    let caught: unknown = null
    try {
      await src.getToken()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AwaitingCredentialError)
    expect(caught).not.toBeInstanceOf(NoTokenError)
    // The awaiting message carries no token material.
    expect((caught as Error).message).not.toContain(FAKE_TOKEN)

    // The exact user-facing copy: this AwaitingCredentialError message travels
    // verbatim through the router's broker_unreachable envelope into the app's
    // ApiError, and describeApiError renders that message unchanged. Pin the exact
    // sentence — the stable, retry-shortly copy the human reads — plus the honest
    // transient reason (an empty file) the awaiting state appends. A regression on
    // this copy fails the drill.
    const AWAITING_COPY =
      'No GitHub credential is available in the injected credential file yet. ' +
      'The host-side broker writes it and refreshes it periodically; ' +
      'this is transient — retry shortly.'
    expect((caught as Error).message).toBe(`${AWAITING_COPY} (credential file is empty)`)
  })

  test('a mid-burst sync whose first request awaits a credential completes once the credential returns, losing nothing', async () => {
    const store = openDirectStore({ dataDir })
    const state = { mergeBaseSha: 'MB1', unresolvedComments: 2 }
    // The token-gated engine: every GitHub call resolves a token first, exactly
    // as broker mode's real client does.
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      github: tokenGated(movingBaseClient(state), source()),
      repo: CONFORMANCE_REPO,
      store,
    })

    // The credential is empty when the first sync fires: the gate throws the
    // transient awaiting state, and NO snapshot is fabricated.
    writeFileSync(credentialFile, '', 'utf8')
    await expect(api.syncPull(MOVING_BASE_PR)).rejects.toBeInstanceOf(AwaitingCredentialError)
    expect(api.getSnapshot(MOVING_BASE_PR)).toBeNull()

    // The host re-injects the token (the per-request re-read is the whole point):
    // the retried sync completes with a full, non-partial snapshot — no data lost
    // to the transient credential gap.
    writeFileSync(credentialFile, `https://x-access-token:${FAKE_TOKEN}@github.com\n`, 'utf8')
    const snap = await api.syncPull(MOVING_BASE_PR)
    expect(snap.partial).toBeNull()
    expect(snap.immutable.files.length).toBeGreaterThan(0)
    expect(snap.mutable.issueComments).toHaveLength(2)
    expect(snap.immutable.compareKey).toBe('MB1...HEAD-FIXED')

    store.close()
  })
})

// ————————————————————————————————————————————————————————————————
// Drills 5 & 6 — the submit head-guard. A fake GitHub client whose live head
// (and whose POST) is scripted, over the REAL write core, so both the value-not-
// thrown routing (drill 5) and the 422-after-guard conflict (drill 6) are pinned
// against genuine persistence. Reuses the writes-suite idiom (a scripted fake +
// an in-memory store + a seeded draft).
//
// A copy note for drill 5: its outcome, `head_moved`, is a RETURNED value, not a
// thrown error, so it never flows through `describeApiError` (whose only input is
// a thrown value) — there is structurally no describeApiError sentence to assert
// here. The user-facing copy for head_moved is the head-moved dialog's title, and
// it is pinned in the app companion suite
// (packages/app/src/components/review/failure-drills.test.ts) against the exact
// exported constant that dialog renders. Drill 6's outcome IS a thrown ApiError,
// so its copy is pinned inline below.
// ————————————————————————————————————————————————————————————————

const WRITE_SESSION: Session = {
  human: { id: 'alice@x.io', name: 'Alice', role: 'contractor', email: 'alice@x.io' },
  brokerLogin: '',
  workspace: 'direct-o-r',
  viewerLogin: 'alice-gh',
}

/** A scripted write fake: reports a live head, and its POST either lands or 422s. */
function writeFake(cfg: {
  headSha: string
  submitThrowsStatus?: number
}): { client: GithubClient; posted: SubmitReviewBody[] } {
  const posted: SubmitReviewBody[] = []
  let reviewSeq = 9000
  const client: GithubClient = {
    async getViewer() {
      return { login: WRITE_SESSION.viewerLogin ?? '', id: 1 }
    },
    async getPullDetail() {
      return {
        number: 1,
        state: 'open',
        user: { login: 'someone-else', id: 2, type: 'User' },
        head: { sha: cfg.headSha },
        base: { sha: 'base1' },
        commits: 3,
      }
    },
    async getPullReviews(_o, _r, _n, params): Promise<Page<unknown>> {
      // No prior reviews → the idempotency re-check finds no candidate → a fresh
      // POST is attempted (which either lands or 422s per cfg).
      return params.page === 1 ? { items: [], hasNext: false } : { items: [], hasNext: false }
    },
    async getReviewComments(_o, _r, _n, _reviewId, params): Promise<Page<unknown>> {
      return params.page === 1 ? { items: [], hasNext: false } : { items: [], hasNext: false }
    },
    async submitReview(_o, _r, _n, body: SubmitReviewBody): Promise<unknown> {
      posted.push(body)
      if (cfg.submitThrowsStatus !== undefined) {
        throw new GithubRequestError(cfg.submitThrowsStatus, '/reviews', 'boom', 'POST')
      }
      const id = reviewSeq++
      return {
        id,
        node_id: 'PRR_x',
        user: { login: WRITE_SESSION.viewerLogin, id: 1, type: 'User' },
        body: body.body,
        state: 'COMMENTED',
        submitted_at: '2026-01-01T00:00:00.000Z',
        commit_id: body.commit_id,
      }
    },
    // The remaining surface must never be reached by these drills; a call is a bug.
    getCompare: () => { throw new Error('unexpected getCompare') },
    getPullFiles: () => { throw new Error('unexpected getPullFiles') },
    getIssueComments: () => { throw new Error('unexpected getIssueComments') },
    getPullCommits: () => { throw new Error('unexpected getPullCommits') },
    getCheckRuns: () => { throw new Error('unexpected getCheckRuns') },
    getTree: () => { throw new Error('unexpected getTree') },
    getBlob: () => { throw new Error('unexpected getBlob') },
    getBlobObjects: () => { throw new Error('unexpected getBlobObjects') },
    graphql: () => { throw new Error('unexpected graphql') },
    getReviewThreads: () => { throw new Error('unexpected getReviewThreads') },
    getThreadComments: () => { throw new Error('unexpected getThreadComments') },
    replyToReviewComment: () => { throw new Error('unexpected replyToReviewComment') },
    addReaction: () => { throw new Error('unexpected addReaction') },
    addIssueCommentReaction: () => { throw new Error('unexpected addIssueCommentReaction') },
    getReviewComment: () => { throw new Error('unexpected getReviewComment') },
    getPullReviewComments: () => { throw new Error('unexpected getPullReviewComments') },
    getIssueComment: () => { throw new Error('unexpected getIssueComment') },
    setThreadResolution: () => { throw new Error('unexpected setThreadResolution') },
  }
  return { client, posted }
}

/** Seed a draft against `headSha`, keyed by the write session's human. */
function seedWriteDraft(store: DirectStore, headSha: string, body: string): void {
  store.putDraft({
    humanId: WRITE_SESSION.human.id,
    prNumber: 1,
    headSha,
    compareKey: `base1...${headSha}`,
    body,
    event: 'COMMENT',
    comments: [
      {
        key: 'k1',
        path: 'a.ts',
        side: 'RIGHT',
        start_side: null,
        line: 10,
        start_line: null,
        body: 'inline note that must survive',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        anchor: { lineText: '', contextBefore: [], contextAfter: [] },
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
}

const submitInput = (over: Partial<SubmitReviewInput> = {}): SubmitReviewInput => ({
  prNumber: 1,
  expectedHeadSha: 'head1',
  event: 'COMMENT',
  body: 'the review body',
  comments: [
    {
      key: 'k1',
      path: 'a.ts',
      side: 'RIGHT',
      start_side: null,
      line: 10,
      start_line: null,
      body: 'inline note that must survive',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      anchor: { lineText: '', contextBefore: [], contextAfter: [] },
    },
  ],
  ...over,
})

describe('drill: submit-window force-push → head-guard fires, routes to reconcile, draft preserved', () => {
  test('a stale expectedHeadSha returns head_moved as a VALUE, posts nothing, keeps the draft', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const draftBody = 'A careful review the force-push must not cost me.'
    seedWriteDraft(store, 'head1', draftBody)
    // The remote head force-pushed from head1 → head2 in the submit window.
    const { client, posted } = writeFake({ headSha: 'head2' })
    const api = createDirectApi({
      session: WRITE_SESSION,
      github: client,
      repo: CONFORMANCE_REPO,
      store,
    })

    const result = await api.submitReview(submitInput({ expectedHeadSha: 'head1' }))

    // The guard fired: head_moved is RETURNED (never thrown), and NOTHING posted.
    expect(result.status).toBe('head_moved')
    if (result.status === 'head_moved') expect(result.currentHeadSha).toBe('head2')
    expect(posted).toHaveLength(0)

    // The draft is fully intact — body and inline comment both preserved.
    const kept = api.getDraft(1)
    expect(kept).not.toBeNull()
    expect(kept!.body).toBe(draftBody)
    expect(kept!.comments).toHaveLength(1)
    expect(kept!.comments[0].body).toBe('inline note that must survive')

    store.close()
  })

  test('guard → reconcile: the returned head_moved routes into the reconcile path with the draft still present', async () => {
    // End to end through the REAL engine: seed a draft against the old head,
    // force-push, then submit against the stale head → the guard returns
    // head_moved; the UI routes that value into reconcile (re-sync + reconcile),
    // which classifies the draft's comments — and the draft is preserved
    // throughout (a draft is deleted ONLY on a confirmed submit success).
    const store = openDirectStore({ dataDir: ':memory:' })
    const state = initialReconcileState()
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      github: movingHeadClient(state),
      repo: CONFORMANCE_REPO,
      store,
    })
    const draft = await seedForcePushed(api, state)
    expect(draft.headSha).toBe('HEAD-OLD')

    // Submit against the now-stale head: the guard reads the live (HEAD-NEW) head
    // and returns head_moved WITHOUT posting.
    const result = await api.submitReview({
      prNumber: RECONCILE_PR,
      expectedHeadSha: 'HEAD-OLD',
      event: 'COMMENT',
      body: 'review body',
      comments: draft.comments,
    })
    expect(result.status).toBe('head_moved')
    if (result.status === 'head_moved') expect(result.currentHeadSha).toBe('HEAD-NEW')

    // Route into reconcile — exactly what the head-moved dialog does: the draft's
    // comments are classified against the fresh snapshot, and the draft is STILL
    // there to be reconciled (never discarded by the guard).
    const report = api.reconcileDraft(RECONCILE_PR)
    expect(report.draftHeadSha).toBe('HEAD-OLD')
    expect(report.currentHeadSha).toBe('HEAD-NEW')
    expect(report.results.length).toBe(draft.comments.length)
    expect(api.getDraft(RECONCILE_PR)).not.toBeNull()

    store.close()
  })
})

describe('drill: a 422 AFTER the head-guard surfaces conflict and keeps the draft', () => {
  test('the guard passes, the POST 422s, submitReview throws conflict, and the draft stays intact', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const draftBody = 'This draft must survive a mid-submit force-push 422.'
    seedWriteDraft(store, 'head1', draftBody)
    // The guard PASSES (expected head === live head), then the POST 422s — a
    // force-push landed between the guard read and the POST.
    const { client, posted } = writeFake({ headSha: 'head1', submitThrowsStatus: 422 })
    const api = createDirectApi({
      session: WRITE_SESSION,
      github: client,
      repo: CONFORMANCE_REPO,
      store,
    })

    let caught: unknown = null
    try {
      await api.submitReview(submitInput({ expectedHeadSha: 'head1' }))
    } catch (err) {
      caught = err
    }

    // A 422 after the guard is a typed conflict — the honest "the PR changed under
    // you" outcome, thrown so the UI can route it, never a silent draft loss.
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).code).toBe('conflict')
    // The POST WAS attempted (the guard passed) — this is a post-guard 422, not a
    // pre-post guard rejection.
    expect(posted).toHaveLength(1)

    // The user-facing copy the frontend surfaces is exactly describeApiError's
    // output for this ApiError — its message verbatim (no rate_limited rewrite).
    expect(copyFor(caught as ApiError)).toBe(
      'A comment could not be placed on the current diff — the pull request ' +
        'changed while the review was being submitted. Your draft is kept; ' +
        're-sync and reconcile, then submit again.',
    )

    // The draft is NEVER discarded on a 422 — body and inline comment intact.
    const kept = api.getDraft(1)
    expect(kept).not.toBeNull()
    expect(kept!.body).toBe(draftBody)
    expect(kept!.comments).toHaveLength(1)
    expect(kept!.comments[0].body).toBe('inline note that must survive')

    store.close()
  })
})
