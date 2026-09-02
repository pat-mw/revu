/**
 * The direct-mode `/api/*` router. `getSession` returns the real session; sync/
 * snapshot/draft/viewed/preferences dispatch to the injected read/persist
 * surface; every not-yet-built contract route answers a typed `not_implemented`
 * (501); unknown paths 404; non-API paths return null so the caller serves
 * static assets. No mock, no dev panel, no network — the surface here is a fake.
 *
 * The local-review routes at the bottom of this file are driven differently, and
 * deliberately: they run against the REAL api surface, the REAL store and the
 * REAL local-git readers over a scripted command runner, because what they pin
 * is the seam between an untrusted request body and a git argv. A hand-rolled
 * api fake would sit exactly where the validation under test belongs.
 */
import { describe, expect, test } from 'bun:test'
import type {
  BranchRef,
  CommitInfo,
  CreateLocalReviewInput,
  FileBlob,
  FileViewedState,
  GhRef,
  HumanPreferences,
  LocalReviewSummary,
  PullListItem,
  PullListResponse,
  RateLimitInfo,
  ReactionRollup,
  ReconcileReport,
  ReviewComment,
  ReviewDraft,
  ReviewThread,
  RouteName,
  Session,
  Snapshot,
  SubmitResult,
} from '@revu/shared'
import {
  ApiError,
  DEFAULT_PREFERENCES,
  fillPath,
  LOCAL_ENTITY_ID_BASE,
  LOCAL_REVIEW_ID_BASE,
  ROUTES,
  validateLocalReviewSummaries,
  validatePullListResponse,
} from '@revu/shared'
import type { CommandResult, CommandRunner } from './direct/command-runner'
import type { DirectApi, PullListSource } from './direct/direct-api'
import { createDirectApi } from './direct/direct-api'
import { throwingGithubClient } from './direct/github-write-stubs'
import { listBranches as readGitBranches } from './direct/local-git'
import type { LocalRange, LocalRangeFailure } from './direct/local-sync'
import { detectDirtyWorktree, resolveLocalRange } from './direct/local-sync'
import type { LocalReviewSurface } from './direct/local-surface'
import type { RepoRef } from './direct/repo'
import type { DirectStore } from './direct/store'
import { openDirectStore, StoreWriteError } from './direct/store'
import { handleDirectApi } from './direct-router'

const SESSION: Session = {
  human: { id: 'alice@x.io', name: 'Alice', role: 'contractor', email: 'alice@x.io' },
  // Direct mode has no broker bot; the empty string is the "no bot" sentinel.
  brokerLogin: '',
  workspace: 'direct-acme-revu',
  viewerLogin: 'alice-gh',
}

/**
 * A conditional-list answer with nothing in it. The items a real list carries
 * are pinned against the REAL api further down; what this stands in for is only
 * the transport — a 200 with an ETag header, and the 304 that replays it.
 */
const EMPTY_LIST: PullListResponse = {
  items: [],
  etag: 'W/"pulls+local:none"',
  notModified: false,
  rateLimit: { limit: 5000, remaining: 5000, used: 0, reset: '2026-01-01T00:00:00.000Z' },
}

/** A fake read/persist surface: no network, no disk — just enough to route against. */
function fakeApi(overrides: Partial<DirectApi> = {}): DirectApi {
  const snapshots = new Map<number, Snapshot>()
  const drafts = new Map<number, ReviewDraft>()
  const viewed = new Map<number, FileViewedState>()
  const blobs = new Map<string, FileBlob>()
  let prefs: HumanPreferences = { ...DEFAULT_PREFERENCES }
  return {
    // These router tests run in direct mode, where writes are gated by mode,
    // not by the broker write capability — so the fake honestly reports false.
    brokerWritesEnabled: false,
    // No poll loop and no local surface stand behind this fake, so it serves no
    // list at all and the route must keep answering its honest 501. A test that
    // wants the list served overrides this alongside `listPulls`.
    pullListEnabled: false,
    // This fake answers a live rate limit and serves the write path, so it
    // stands for a daemon that DOES hold a repository: the no-repository
    // degradation is exercised against a real api further down, never here.
    githubEnabled: true,
    getRateLimit: async () => ({
      limit: 5000,
      remaining: 4999,
      used: 1,
      reset: '2026-01-01T00:00:00.000Z',
    }),
    listPulls() {
      // Direct mode has no poll loop; the live list is broker-only. The router
      // never dispatches here in direct mode (it falls through to the 501
      // placeholder), so this is defensive.
      throw new ApiError('not_found', 'A live pull list is served only in broker mode.')
    },
    async syncPull(prNumber: number): Promise<Snapshot> {
      const snap = { prNumber } as Snapshot
      snapshots.set(prNumber, snap)
      return snap
    },
    getSnapshot(prNumber: number): Snapshot | null {
      return snapshots.get(prNumber) ?? null
    },
    getBlob(sha: string): FileBlob {
      const blob = blobs.get(sha)
      if (!blob) {
        throw new ApiError('not_found', `Blob ${sha} is not in the store.`)
      }
      return blob
    },
    getDraft(prNumber: number): ReviewDraft | null {
      return drafts.get(prNumber) ?? null
    },
    saveDraft(draft: ReviewDraft): ReviewDraft {
      const stored = { ...draft, humanId: SESSION.human.id }
      drafts.set(draft.prNumber, stored)
      return stored
    },
    discardDraft(prNumber: number): void {
      drafts.delete(prNumber)
    },
    reconcileDraft(prNumber: number): ReconcileReport {
      const draft = drafts.get(prNumber)
      if (!draft) {
        throw new ApiError('not_found', `No draft for pull #${prNumber}.`)
      }
      return {
        prNumber,
        draftHeadSha: draft.headSha,
        currentHeadSha: draft.headSha,
        newCommits: [],
        results: [],
      }
    },
    getFileViewed(prNumber: number): FileViewedState {
      return viewed.get(prNumber) ?? {}
    },
    setFileViewed(prNumber, path, isViewed, blobSha): FileViewedState {
      const state = viewed.get(prNumber) ?? {}
      state[path] = { viewed: isViewed, blobSha, at: '2026-01-01T00:00:00.000Z' }
      viewed.set(prNumber, state)
      return state
    },
    getPreferences(): HumanPreferences {
      return prefs
    },
    setPreferences(patch): HumanPreferences {
      prefs = { ...prefs, ...patch }
      return prefs
    },
    async submitReview(input): Promise<SubmitResult> {
      // Default: the head matched, a review was created. Overridden per test to
      // exercise head_moved / forbidden / conflict routing.
      return {
        status: 'ok',
        review: {
          id: 5001,
          node_id: 'PRR_x',
          user: { login: 'alice-gh', id: 1, node_id: '', avatar_url: '', html_url: '', type: 'User' },
          body: input.body,
          state: 'COMMENTED',
          submitted_at: '2026-01-01T00:00:00.000Z',
          commit_id: input.expectedHeadSha,
        },
      }
    },
    async replyToThread(_pr, threadId, body): Promise<ReviewComment> {
      return {
        id: 6001,
        node_id: '',
        pull_request_review_id: null,
        in_reply_to_id: 42,
        path: 'a.ts',
        diff_hunk: '@@ -1 +1 @@',
        commit_id: 'h',
        original_commit_id: 'h',
        line: 1,
        original_line: 1,
        start_line: null,
        original_start_line: null,
        side: 'RIGHT',
        start_side: null,
        subject_type: 'line',
        user: { login: 'alice-gh', id: 1, node_id: '', avatar_url: '', html_url: '', type: 'User' },
        body: `reply(${threadId}): ${body}`,
        created_at: '',
        updated_at: '',
        reactions: {
          url: '', total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0,
        },
        html_url: '',
      }
    },
    async resolveThread(_pr, threadId, resolved): Promise<ReviewThread> {
      return {
        id: threadId,
        isResolved: resolved,
        isOutdated: false,
        path: 'a.ts',
        line: 1,
        originalLine: 1,
        startLine: null,
        originalStartLine: null,
        diffSide: 'RIGHT',
        startDiffSide: null,
        subjectType: 'LINE',
        resolvedBy: resolved ? { login: 'alice-gh' } : null,
        comments: [],
      }
    },
    async addReaction(_pr, _commentId, reaction): Promise<ReactionRollup> {
      const rollup: ReactionRollup = {
        url: '', total_count: 1, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0,
      }
      rollup[reaction] = 1
      return rollup
    },
    // No local-review surface stands behind this fake, so the three local
    // routes answer the same typed `not_found` a daemon assembled without one
    // does. That is the honest answer for "this instance does not serve that",
    // and it is deliberately NOT a 501, which would promise it later.
    async listBranches(): Promise<BranchRef[]> {
      throw new ApiError('not_found', 'This daemon does not serve local reviews.')
    },
    async createLocalReview(): Promise<LocalReviewSummary> {
      throw new ApiError('not_found', 'This daemon does not serve local reviews.')
    },
    listLocalReviews(): LocalReviewSummary[] {
      throw new ApiError('not_found', 'This daemon does not serve local reviews.')
    },
    async deleteLocalReview(): Promise<void> {
      throw new ApiError('not_found', 'This daemon does not serve local reviews.')
    },
    ...overrides,
  }
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  })
}

describe('handleDirectApi', () => {
  test('GET /api/session returns the real session', async () => {
    const res = await handleDirectApi(req('GET', '/api/session'), SESSION, fakeApi())
    expect(res).not.toBeNull()
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as Session
    expect(body.human.id).toBe('alice@x.io')
    expect(body.viewerLogin).toBe('alice-gh')
  })

  test('GET snapshot returns a JSON null body (200) for a never-synced PR, not a 404', async () => {
    const res = await handleDirectApi(req('GET', '/api/pulls/204/snapshot'), SESSION, fakeApi())
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as unknown
    expect(body).toBeNull()
  })

  test('POST sync returns the snapshot (200)', async () => {
    const res = await handleDirectApi(req('POST', '/api/pulls/204/sync'), SESSION, fakeApi())
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as Snapshot
    expect(body.prNumber).toBe(204)
  })

  test('draft round-trips through PUT then GET, keyed by the session human', async () => {
    const api = fakeApi()
    const draft: ReviewDraft = {
      humanId: 'ignored-by-server',
      prNumber: 204,
      headSha: 'abc',
      compareKey: 'base...abc',
      body: 'hello',
      event: 'COMMENT',
      comments: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const put = await handleDirectApi(req('PUT', '/api/pulls/204/draft', draft), SESSION, api)
    expect(put?.status).toBe(200)
    const saved = (await put?.json()) as ReviewDraft
    expect(saved.humanId).toBe('alice@x.io')

    const get = await handleDirectApi(req('GET', '/api/pulls/204/draft'), SESSION, api)
    const body = (await get?.json()) as ReviewDraft
    expect(body.body).toBe('hello')

    const del = await handleDirectApi(req('DELETE', '/api/pulls/204/draft'), SESSION, api)
    expect(del?.status).toBe(200)
    const after = await handleDirectApi(req('GET', '/api/pulls/204/draft'), SESSION, api)
    expect(await after?.json()).toBeNull()
  })

  test('viewed round-trips through PUT then GET', async () => {
    const api = fakeApi()
    const put = await handleDirectApi(
      req('PUT', '/api/pulls/204/viewed', { path: 'a.ts', viewed: true, blobSha: 'sha1' }),
      SESSION,
      api,
    )
    expect(put?.status).toBe(200)
    const get = await handleDirectApi(req('GET', '/api/pulls/204/viewed'), SESSION, api)
    const body = (await get?.json()) as FileViewedState
    expect(body['a.ts'].viewed).toBe(true)
    expect(body['a.ts'].blobSha).toBe('sha1')
  })

  test('preferences round-trip through PUT then GET', async () => {
    const api = fakeApi()
    const put = await handleDirectApi(
      req('PUT', '/api/preferences', { diffMode: 'split' }),
      SESSION,
      api,
    )
    const saved = (await put?.json()) as HumanPreferences
    expect(saved.diffMode).toBe('split')
    const get = await handleDirectApi(req('GET', '/api/preferences'), SESSION, api)
    const body = (await get?.json()) as HumanPreferences
    expect(body.diffMode).toBe('split')
  })

  test('PUT draft with a body prNumber that does not match the path is a 400, never a write', async () => {
    const api = fakeApi()
    const draft: ReviewDraft = {
      humanId: 'alice@x.io',
      prNumber: 999,
      headSha: 'abc',
      compareKey: 'base...abc',
      body: 'landed on the wrong PR',
      event: 'COMMENT',
      comments: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    // The path names PR 204 but the body names 999. Acting on the body's number
    // would 200 while the draft the client thinks it saved (204) stays absent.
    const res = await handleDirectApi(req('PUT', '/api/pulls/204/draft', draft), SESSION, api)
    expect(res?.status).toBe(400)
    const at204 = await handleDirectApi(req('GET', '/api/pulls/204/draft'), SESSION, api)
    expect(await at204?.json()).toBeNull()
    const at999 = await handleDirectApi(req('GET', '/api/pulls/999/draft'), SESSION, api)
    expect(await at999?.json()).toBeNull()
  })

  test('PUT draft with a malformed body is a 400 validation failure, never persisted', async () => {
    const api = fakeApi()
    const res = await handleDirectApi(
      req('PUT', '/api/pulls/204/draft', { body: 'not a ReviewDraft shape' }),
      SESSION,
      api,
    )
    expect(res?.status).toBe(400)
    const get = await handleDirectApi(req('GET', '/api/pulls/204/draft'), SESSION, api)
    expect(await get?.json()).toBeNull()
  })

  test('PUT viewed with no path is a 400, not a write under an empty key', async () => {
    const api = fakeApi()
    const res = await handleDirectApi(
      req('PUT', '/api/pulls/204/viewed', { viewed: true, blobSha: null }),
      SESSION,
      api,
    )
    expect(res?.status).toBe(400)
    const get = await handleDirectApi(req('GET', '/api/pulls/204/viewed'), SESSION, api)
    expect(await get?.json()).toEqual({})
  })

  test('PUT preferences with a wrong-typed field is a 400, not persisted', async () => {
    const api = fakeApi()
    const res = await handleDirectApi(
      req('PUT', '/api/preferences', { diffMode: 'diagonal' }),
      SESSION,
      api,
    )
    expect(res?.status).toBe(400)
    const get = await handleDirectApi(req('GET', '/api/preferences'), SESSION, api)
    const body = (await get?.json()) as HumanPreferences
    expect(body.diffMode).toBe('unified')
  })

  test('a durable write failure surfaces as persist_failed (500), never a 200', async () => {
    const api = fakeApi({
      saveDraft() {
        // The store throws this typed error when a write does not reach disk.
        throw new StoreWriteError('drafts', new Error('disk full'))
      },
    })
    const res = await handleDirectApi(
      req('PUT', '/api/pulls/204/draft', {
        humanId: 'x',
        prNumber: 204,
        headSha: 'h',
        compareKey: 'b...h',
        body: '',
        event: 'COMMENT',
        comments: [],
        createdAt: '',
        updatedAt: '',
      }),
      SESSION,
      api,
    )
    expect(res?.status).toBe(500)
    const body = (await res?.json()) as { code: string }
    expect(body.code).toBe('persist_failed')
  })

  test('the thread read stays a 501 while a list-capable api serves the pull list', async () => {
    // The GraphQL thread read is genuinely unbuilt, and stays an honest 501.
    const threads = await handleDirectApi(
      req('GET', '/api/pulls/204/threads'),
      SESSION,
      fakeApi(),
    )
    expect(threads?.status).toBe(501)
    const threadsBody = (await threads?.json()) as { code: string }
    expect(threadsBody.code).toBe('not_implemented')

    // The pull list is no longer among them: an api that declares the list
    // capability serves it, in direct mode, with the conditional-list ETag on
    // the response. The two live in one test because the route the capability
    // opens and the route it must NOT open are the same shape of path.
    const list = await handleDirectApi(
      req('GET', '/api/pulls'),
      SESSION,
      fakeApi({ pullListEnabled: true, listPulls: () => EMPTY_LIST }),
    )
    expect(list?.status).toBe(200)
    expect(list?.headers.get('etag')).toBe(EMPTY_LIST.etag)
  })

  // The allowance is GitHub's to report, not this daemon's to accumulate: every
  // workspace under one installation spends from the same bucket, so the figure
  // is read live rather than summed locally.
  test('GET rate-limit answers the live allowance, not a 501', async () => {
    const res = await handleDirectApi(req('GET', '/api/rate-limit'), SESSION, fakeApi())
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as RateLimitInfo
    expect(body.limit).toBe(5000)
    expect(body.remaining).toBe(4999)
    expect(body.used).toBe(1)
    expect(typeof body.reset).toBe('string')
  })

  test('GET reconcile returns the ReconcileReport as a 200 value', async () => {
    const draft: ReviewDraft = {
      humanId: 'alice@x.io',
      prNumber: 204,
      headSha: 'head-old',
      compareKey: 'base...head-old',
      body: '',
      event: 'COMMENT',
      comments: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const api = fakeApi()
    api.saveDraft(draft)
    const res = await handleDirectApi(req('GET', '/api/pulls/204/reconcile'), SESSION, api)
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as ReconcileReport
    expect(body.prNumber).toBe(204)
    expect(body.draftHeadSha).toBe('head-old')
  })

  test('GET reconcile for a PR with no draft is a typed not_found (404)', async () => {
    const res = await handleDirectApi(req('GET', '/api/pulls/999/reconcile'), SESSION, fakeApi())
    expect(res?.status).toBe(404)
    const body = (await res?.json()) as { code: string }
    expect(body.code).toBe('not_found')
  })

  test('POST review returns the SubmitResult as a 200 value', async () => {
    const input = {
      prNumber: 204,
      expectedHeadSha: 'head1',
      event: 'COMMENT',
      body: 'looks good',
      comments: [],
    }
    const res = await handleDirectApi(req('POST', '/api/pulls/204/review', input), SESSION, fakeApi())
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as SubmitResult
    expect(body.status).toBe('ok')
  })

  test('POST review head_moved is a 200 VALUE, never an error status', async () => {
    const api = fakeApi({
      async submitReview(): Promise<SubmitResult> {
        return { status: 'head_moved', currentHeadSha: 'head2', newCommits: 2 }
      },
    })
    const input = {
      prNumber: 204,
      expectedHeadSha: 'head1',
      event: 'COMMENT',
      body: '',
      comments: [],
    }
    const res = await handleDirectApi(req('POST', '/api/pulls/204/review', input), SESSION, api)
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as SubmitResult
    expect(body.status).toBe('head_moved')
  })

  test('POST review with a body prNumber mismatching the path is a 400, never a submit', async () => {
    let submitted = false
    const api = fakeApi({
      async submitReview(): Promise<SubmitResult> {
        submitted = true
        return { status: 'head_moved', currentHeadSha: 'x', newCommits: 0 }
      },
    })
    const input = {
      prNumber: 999,
      expectedHeadSha: 'head1',
      event: 'COMMENT',
      body: '',
      comments: [],
    }
    const res = await handleDirectApi(req('POST', '/api/pulls/204/review', input), SESSION, api)
    expect(res?.status).toBe(400)
    expect(submitted).toBe(false)
  })

  test('a submit conflict (a 422 from GitHub) surfaces as 409 conflict', async () => {
    const api = fakeApi({
      async submitReview(): Promise<SubmitResult> {
        throw new ApiError('conflict', 'the diff changed under the review; draft kept')
      },
    })
    const input = {
      prNumber: 204,
      expectedHeadSha: 'head1',
      event: 'COMMENT',
      body: 'x',
      comments: [],
    }
    const res = await handleDirectApi(req('POST', '/api/pulls/204/review', input), SESSION, api)
    expect(res?.status).toBe(409)
    const body = (await res?.json()) as { code: string }
    expect(body.code).toBe('conflict')
  })

  test('POST reply returns the new comment', async () => {
    const res = await handleDirectApi(
      req('POST', '/api/pulls/204/threads/PRRT_abc/reply', { body: 'thanks' }),
      SESSION,
      fakeApi(),
    )
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as ReviewComment
    expect(body.body).toContain('thanks')
    expect(body.body).toContain('PRRT_abc')
  })

  test('POST resolve returns the mutated thread', async () => {
    const res = await handleDirectApi(
      req('POST', '/api/pulls/204/threads/PRRT_abc/resolve', { resolved: true }),
      SESSION,
      fakeApi(),
    )
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as ReviewThread
    expect(body.isResolved).toBe(true)
    expect(body.id).toBe('PRRT_abc')
  })

  test('POST reaction with ?pr= returns the rollup', async () => {
    const res = await handleDirectApi(
      req('POST', '/api/comments/7788/reactions?pr=204', { reaction: '+1' }),
      SESSION,
      fakeApi(),
    )
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as ReactionRollup
    expect(body['+1']).toBe(1)
  })

  test('POST reaction without an owning PR (?pr= or prNumber) is a 400', async () => {
    const res = await handleDirectApi(
      req('POST', '/api/comments/7788/reactions', { reaction: '+1' }),
      SESSION,
      fakeApi(),
    )
    expect(res?.status).toBe(400)
  })

  test('GET blob returns the FileBlob (200) for a present SHA', async () => {
    const blob: FileBlob = {
      sha: 'sha-1',
      path: 'a.ts',
      content: 'export const x = 1\n',
      size: 19,
      binary: false,
    }
    const api = fakeApi({
      getBlob(sha: string): FileBlob {
        if (sha === 'sha-1') return blob
        throw new ApiError('not_found', 'absent')
      },
    })
    const res = await handleDirectApi(req('GET', '/api/blobs/sha-1'), SESSION, api)
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as FileBlob
    expect(body.sha).toBe('sha-1')
    expect(body.content).toBe('export const x = 1\n')
    expect(body.binary).toBe(false)
  })

  test('GET blob for an absent SHA is a typed not_found (404), never a fabricated blob', async () => {
    // The default fakeApi store is empty, so any SHA is absent.
    const res = await handleDirectApi(req('GET', '/api/blobs/deadbeef'), SESSION, fakeApi())
    expect(res?.status).toBe(404)
    const body = (await res?.json()) as { code: string }
    expect(body.code).toBe('not_found')
  })

  test('an unknown API path is a 404 not_found', async () => {
    const res = await handleDirectApi(req('GET', '/api/does-not-exist'), SESSION, fakeApi())
    expect(res?.status).toBe(404)
    const body = (await res?.json()) as { code: string }
    expect(body.code).toBe('not_found')
  })

  test('a bare /api is treated as an API path (404), not static fallthrough', async () => {
    const res = await handleDirectApi(req('GET', '/api'), SESSION, fakeApi())
    expect(res?.status).toBe(404)
  })

  test('a non-API path returns null so the caller serves static assets', async () => {
    expect(await handleDirectApi(req('GET', '/'), SESSION, fakeApi())).toBeNull()
    expect(await handleDirectApi(req('GET', '/pulls/204/files'), SESSION, fakeApi())).toBeNull()
  })

  test('the dev panel does not exist in direct mode', async () => {
    // /api/dev is never a contract route, so it is an ordinary unknown API 404.
    const res = await handleDirectApi(req('GET', '/api/dev'), SESSION, fakeApi())
    expect(res?.status).toBe(404)
  })
})

// ————————————————————————————————————————————————————————————————
// Local reviews — three served routes over a real store and a scripted git
// ————————————————————————————————————————————————————————————————

/**
 * The repository identity every local row in these tests is keyed under, and
 * the directory the scripted git is asked about. Neither is discovered here:
 * discovery belongs to whoever assembles the local surface, and pinning both to
 * literals keeps the store's repository scoping visible in the assertions.
 */
const LOCAL_REPO = 'o/r'
const LOCAL_CWD = '/repo'
const LOCAL_REPO_REF: RepoRef = { owner: 'o', repo: 'r' }
const LOCAL_NOW = '2026-02-02T00:00:00.000Z'

const MAIN_REF = 'refs/heads/main'
const FEATURE_REF = 'refs/heads/feature/x'
/** A second NAME sitting on the feature branch's commit — a degenerate pair. */
const TWIN_REF = 'refs/heads/feature/twin'
/** A branch with no common ancestor, used for both no-merge-base outcomes. */
const ORPHAN_REF = 'refs/heads/orphan'
const ABSENT_REF = 'refs/heads/no-such-branch'
/** A remote-tracking ref no stored review names — only git knows about it. */
const REMOTE_MAIN_REF = 'refs/remotes/origin/main'

const MAIN_SHA = 'a'.repeat(40)
const FEATURE_SHA = 'b'.repeat(40)
const ORPHAN_SHA = 'c'.repeat(40)
const MERGE_BASE_SHA = 'd'.repeat(40)

/** What `git rev-parse --verify` answers for each ref this repository holds. */
const TIPS: Record<string, string> = {
  [MAIN_REF]: MAIN_SHA,
  [FEATURE_REF]: FEATURE_SHA,
  // Deliberately the SAME commit as the feature branch: two different names at
  // one commit is the degenerate pair that only a comparison of the resolved
  // commits can see, and that a comparison of the names never will.
  [TWIN_REF]: FEATURE_SHA,
  [ORPHAN_REF]: ORPHAN_SHA,
}

/** The repository the scripted git describes for one test. */
interface GitWorld {
  /** What `git rev-parse --is-shallow-repository` reports. */
  shallow: boolean
  /**
   * What `git status --porcelain=v1 -uno` reports. `unreadable` is a non-zero
   * exit — the degraded probe whose worktree state is `unknown`.
   */
  worktree: 'clean' | 'dirty' | 'unreadable'
}

/** A command runner that records every argv it is handed before answering. */
interface RecordingRunner extends CommandRunner {
  /** Every argv the runner was actually asked to spawn, in order. */
  readonly argvs: string[][]
}

function exited(code: number, stdout = ''): CommandResult {
  return { ok: code === 0, code, stdout, stderr: '' }
}

/** The NUL byte `for-each-ref` separates its fields with. */
const NUL = String.fromCharCode(0)

/**
 * A git that never spawns anything, answering from `world` and recording what
 * it was asked. Recording is what turns "no git command ran" into an assertion
 * over evidence: a ref rejected before the surface is entered leaves this list
 * empty, and the happy path leaves it non-empty in the same test.
 */
function fakeGit(world: GitWorld): RecordingRunner {
  const argvs: string[][] = []
  return {
    argvs,
    async run(args: string[]): Promise<CommandResult> {
      argvs.push([...args])
      const sub = args[1]
      const operands = args.slice(args.indexOf('--end-of-options') + 1)
      if (sub === 'rev-parse' && args[2] === '--verify') {
        const tip = TIPS[operands[0]]
        return tip === undefined ? exited(128) : exited(0, `${tip}\n`)
      }
      if (sub === 'rev-parse' && args[2] === '--is-shallow-repository') {
        return exited(0, world.shallow ? 'true\n' : 'false\n')
      }
      if (sub === 'merge-base') {
        // Exit 1 with no output is git's "no common ancestor", the outcome a
        // shallow clone counterfeits exactly.
        if (operands.includes(ORPHAN_SHA)) return exited(1)
        return exited(0, `${MERGE_BASE_SHA}\n`)
      }
      if (sub === 'for-each-ref' && args.includes('--format=%(refname)')) {
        // The pin namespace of this fake world is empty. Nothing here has ever
        // synced a review, so a drop over it discovers nothing and deletes
        // nothing — which is the ordinary answer for an unpinned review, not a
        // failure. The refname format is what distinguishes this listing from
        // the branch listing below; they are different reads of the same
        // command and answering one with the other's output would hand the
        // drop a set of branch names to delete.
        return exited(0, '')
      }
      if (sub === 'for-each-ref') {
        return exited(
          0,
          [
            `${MAIN_REF}${NUL}${MAIN_SHA}${NUL}*`,
            `${FEATURE_REF}${NUL}${FEATURE_SHA}${NUL}`,
            `${REMOTE_MAIN_REF}${NUL}${MAIN_SHA}${NUL}`,
            '',
          ].join('\n'),
        )
      }
      if (sub === 'symbolic-ref') return exited(0, `${REMOTE_MAIN_REF}\n`)
      if (sub === 'status') {
        if (world.worktree === 'unreadable') return exited(128)
        return exited(0, world.worktree === 'dirty' ? ' M a.ts\n' : '')
      }
      return exited(1)
    },
  }
}

/**
 * The contract code each way of resolving a branch pair can fail maps onto.
 *
 * A missing ref is `not_found` — the resource named does not exist. The other
 * three are `unprocessable`: the request is well-formed and the refs are real,
 * but the pair cannot be reviewed as given. None of them may reach the router's
 * terminal catch-all, which would answer `broker_unreachable` (500) and tell a
 * reader of a purely local daemon that a broker they do not have is down.
 */
function apiErrorForRange(failure: LocalRangeFailure): ApiError {
  switch (failure.reason) {
    case 'ref_not_found':
      return new ApiError(
        'not_found',
        `No such ref: ${failure.refs.join(', ')} (git exited ${failure.code}).`,
      )
    case 'same_ref':
      return new ApiError(
        'unprocessable',
        `${failure.baseRef} and ${failure.headRef} are both at ${failure.sha}.`,
      )
    case 'unrelated_histories':
      return new ApiError(
        'unprocessable',
        `${failure.baseRef} and ${failure.headRef} share no common ancestor.`,
      )
    case 'shallow_clone':
      return new ApiError(
        'unprocessable',
        `This clone is shallow, so the common ancestor of ${failure.baseRef} and ` +
          `${failure.headRef} may simply not be present.`,
      )
  }
}

function localSnapshot(localId: number, range: LocalRange): Snapshot {
  return {
    prNumber: localId,
    syncedAt: LOCAL_NOW,
    partial: null,
    syncStats: { blobsFetched: 0, blobsReused: 0, requests: 0 },
    immutable: {
      compareKey: range.compareKey,
      mergeBaseSha: range.mergeBaseSha,
      headSha: range.headSha,
      files: [],
      blobIndex: {},
      commits: [],
    },
    mutable: {
      fetchedAt: LOCAL_NOW,
      pull: { number: localId } as Snapshot['mutable']['pull'],
      threads: [],
      issueComments: [],
      reviews: [],
      checks: [],
    },
  }
}

/**
 * A stand-in for the assembled local-review surface, built from the REAL store
 * and the REAL local-git readers over a scripted runner. Only the assembly is
 * fake: `resolveLocalRange`, `detectDirtyWorktree` and the branch listing are
 * the production functions, so a ref that reaches this surface reaches git's
 * argv seam exactly as it would in a live daemon.
 *
 * Every method not needed to serve the three routes under test throws, so a
 * route accidentally answered through one of them fails loudly rather than
 * quietly returning a plausible empty value.
 */
function localSurfaceOver(
  store: DirectStore,
  runner: CommandRunner,
  calls: string[],
): LocalReviewSurface {
  const unused = (name: string): never => {
    throw new Error(`the local-review route tests do not exercise ${name}`)
  }
  return {
    async createLocalReview(input: CreateLocalReviewInput): Promise<LocalReviewSummary> {
      calls.push('createLocalReview')
      const resolved = await resolveLocalRange(runner, LOCAL_CWD, {
        baseRef: input.baseRef,
        headRef: input.headRef,
      })
      if (!resolved.ok) throw apiErrorForRange(resolved)
      return store.createLocalReview({
        repo: LOCAL_REPO,
        baseRef: input.baseRef,
        headRef: input.headRef,
        title: input.title ?? input.headRef,
      })
    },
    listLocalReviews(): LocalReviewSummary[] {
      calls.push('listLocalReviews')
      return store.listLocalReviews(LOCAL_REPO)
    },
    async listBranches(): Promise<BranchRef[]> {
      calls.push('listBranches')
      return readGitBranches(runner, LOCAL_CWD)
    },
    syncLocalReview: () => unused('syncLocalReview'),

    async syncPull(localId: number): Promise<Snapshot> {
      calls.push('syncPull')
      const review = store.getLocalReview(localId)
      if (review === null) {
        throw new ApiError('not_found', `No local review #${localId}.`)
      }
      const resolved = await resolveLocalRange(runner, LOCAL_CWD, {
        baseRef: review.baseRef,
        headRef: review.headRef,
      })
      if (!resolved.ok) throw apiErrorForRange(resolved)
      const worktree = await detectDirtyWorktree(runner, LOCAL_CWD)
      store.patchLocalReviewSync(localId, {
        baseSha: resolved.range.baseSha,
        mergeBaseSha: resolved.range.mergeBaseSha,
        headSha: resolved.range.headSha,
        // The tri-state squash. `unknown` — a worktree that could not be read
        // at all — becomes `false`, so the wire meaning of `dirty: false` is
        // "clean, or unknowable". Under-warning is the deliberate choice: a
        // banner raised by every degraded probe is a banner nobody reads, which
        // costs exactly the case it exists for.
        dirty: worktree === 'dirty',
        lastSyncedAt: LOCAL_NOW,
      })
      return localSnapshot(localId, resolved.range)
    },
    getSnapshot: () => unused('getSnapshot'),
    getDraft: () => unused('getDraft'),
    saveDraft: () => unused('saveDraft'),
    discardDraft: () => unused('discardDraft'),
    reconcileDraft: () => unused('reconcileDraft'),
    getFileViewed: () => unused('getFileViewed'),
    setFileViewed: () => unused('setFileViewed'),
    submitReview: () => unused('submitReview'),
    replyToThread: () => unused('replyToThread'),
    resolveThread: () => unused('resolveThread'),
    addReaction: () => unused('addReaction'),
    listThreads: () => unused('listThreads'),
  }
}

interface LocalHarness {
  api: DirectApi
  store: DirectStore
  runner: RecordingRunner
  /** Which local-surface methods were entered, in order. */
  surfaceCalls: string[]
  close(): void
}

/**
 * The router under a REAL `DirectApi` — not the hand-rolled fake the rest of
 * this file routes against — so the band dispatch, the new local methods and
 * the store all sit between the request and the answer. The GitHub client
 * throws on any call, which is what makes "nothing about a local review reaches
 * GitHub" hold without a separate assertion.
 */
function localHarness(world: Partial<GitWorld> = {}): LocalHarness {
  const store = openDirectStore({ dataDir: ':memory:' })
  const runner = fakeGit({ shallow: false, worktree: 'clean', ...world })
  const surfaceCalls: string[] = []
  const api = createDirectApi({
    session: SESSION,
    github: throwingGithubClient(),
    repo: LOCAL_REPO_REF,
    store,
    // The same git seam the surface runs on, wired to the api as boot wires it.
    // Removing a review has to reach the object database to drop its pins, and
    // an api holding no runner and no directory could not — so a harness that
    // omitted them would be exercising a shape no daemon is ever assembled in.
    runner,
    cwd: LOCAL_CWD,
    localReviews: localSurfaceOver(store, runner, surfaceCalls),
  })
  return { api, store, runner, surfaceCalls, close: () => store.close() }
}

/**
 * The routes this router serves for local reviews, each driven with a request
 * that carries no review id. `deleteLocalReview` is served too, but its answer
 * depends on the id in the path rather than on the route alone, so it is
 * exercised on its own below instead of being folded in here with a made-up id.
 */
const SERVED_LOCAL_ROUTES = [
  {
    name: 'listBranches',
    method: ROUTES.listBranches.method,
    path: ROUTES.listBranches.path,
    body: undefined as unknown,
  },
  {
    name: 'createLocalReview',
    method: ROUTES.createLocalReview.method,
    path: ROUTES.createLocalReview.path,
    body: { baseRef: MAIN_REF, headRef: FEATURE_REF } as unknown,
  },
  {
    name: 'listLocalReviews',
    method: ROUTES.listLocalReviews.method,
    path: ROUTES.listLocalReviews.path,
    body: undefined as unknown,
  },
] as const

/**
 * Ref shapes that must never become a git argument. A table rather than a
 * single case, because the failure being guarded against is a handler that
 * strips a leading dash and calls that validation: only the other four rows
 * distinguish stripping from validating.
 */
const HOSTILE_REFS = [
  { label: 'an option-injection flag', ref: '--upload-pack=/bin/sh' },
  { label: 'a bare leading dash', ref: '-' },
  { label: 'a range expression', ref: 'refs/heads/a..b' },
  { label: 'a trailing slash', ref: 'refs/heads/feature/' },
  { label: 'a control character', ref: `refs/heads/feature${String.fromCharCode(1)}x` },
] as const

async function createLocal(api: DirectApi, body: unknown): Promise<Response> {
  const res = await handleDirectApi(req('POST', '/api/local-reviews', body), SESSION, api)
  expect(res).not.toBeNull()
  return res as Response
}

describe('handleDirectApi: local reviews', () => {
  test('every served local route answers a 200, never the known-route 501', async () => {
    for (const route of SERVED_LOCAL_ROUTES) {
      const h = localHarness()
      const res = await handleDirectApi(req(route.method, route.path, route.body), SESSION, h.api)
      expect([route.name, res?.status]).toEqual([route.name, 200])
      h.close()
    }
  })

  test('every served local route is a typed not_found when no local surface is wired', async () => {
    // The hand-rolled fake stands in for a daemon assembled without local
    // reviews: the route exists, the request is well-formed, and the answer is
    // an honest "this instance does not serve that" rather than a 501 promise.
    for (const route of SERVED_LOCAL_ROUTES) {
      const res = await handleDirectApi(
        req(route.method, route.path, route.body),
        SESSION,
        fakeApi(),
      )
      expect([route.name, res?.status]).toEqual([route.name, 404])
      const body = (await res?.json()) as { code: string }
      expect(body.code).toBe('not_found')
    }
  })

  test('POST creates a review and answers the stored summary (200)', async () => {
    const h = localHarness()
    const res = await createLocal(h.api, { baseRef: MAIN_REF, headRef: FEATURE_REF })
    expect(res.status).toBe(200)
    const body = (await res.json()) as LocalReviewSummary
    expect(body.id).toBeGreaterThanOrEqual(LOCAL_REVIEW_ID_BASE)
    expect(body.baseRef).toBe(MAIN_REF)
    expect(body.headRef).toBe(FEATURE_REF)
    expect(h.store.getLocalReview(body.id)?.headRef).toBe(FEATURE_REF)
    h.close()
  })

  test('a bare branch name is qualified before it is stored', async () => {
    const h = localHarness()
    const res = await createLocal(h.api, { baseRef: 'main', headRef: 'feature/x' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as LocalReviewSummary
    // Qualified on the way in, so the same branch spelled bare and spelled in
    // full lands on ONE record rather than forking the pair's identity.
    expect([body.baseRef, body.headRef]).toEqual([MAIN_REF, FEATURE_REF])
    h.close()
  })

  test('a hostile ref is refused on either side, and no git command runs', async () => {
    for (const hostile of HOSTILE_REFS) {
      for (const side of ['base', 'head'] as const) {
        const h = localHarness()
        const body =
          side === 'base'
            ? { baseRef: hostile.ref, headRef: FEATURE_REF }
            : { baseRef: MAIN_REF, headRef: hostile.ref }
        const res = await createLocal(h.api, body)
        const envelope = (await res.json()) as { code: string }
        expect([hostile.label, side, res.status, envelope.code]).toEqual([
          hostile.label,
          side,
          422,
          'unprocessable',
        ])
        // Nothing was spawned...
        expect([hostile.label, side, h.runner.argvs]).toEqual([hostile.label, side, []])
        // ...and the surface was not entered either, so the refusal is the
        // router's own validation rather than the argv seam blocking a value
        // that had already been handed onward.
        expect([hostile.label, side, h.surfaceCalls]).toEqual([hostile.label, side, []])
        expect(h.store.listLocalReviews(LOCAL_REPO)).toEqual([])
        h.close()
      }
    }

    // The positive control for the two emptiness claims above, on the same
    // runner and the same surface: a well-formed pair DOES reach git. Without
    // it, "zero invocations" would pass just as well on a runner nothing was
    // ever wired to.
    const h = localHarness()
    const ok = await createLocal(h.api, { baseRef: MAIN_REF, headRef: FEATURE_REF })
    expect(ok.status).toBe(200)
    expect(h.runner.argvs.length).toBeGreaterThanOrEqual(1)
    expect(h.runner.argvs[0][0]).toBe('git')
    expect(h.surfaceCalls).toEqual(['createLocalReview'])
    h.close()
  })

  test('each typed creation failure lands on its contract code and status', async () => {
    const cases = [
      {
        label: 'base and head name the same ref',
        world: {},
        body: { baseRef: MAIN_REF, headRef: MAIN_REF },
        code: 'unprocessable',
        status: 422,
      },
      {
        label: 'two names resolving to one commit',
        world: {},
        body: { baseRef: FEATURE_REF, headRef: TWIN_REF },
        code: 'unprocessable',
        status: 422,
      },
      {
        label: 'unrelated histories',
        world: { shallow: false },
        body: { baseRef: MAIN_REF, headRef: ORPHAN_REF },
        code: 'unprocessable',
        status: 422,
      },
      {
        label: 'a shallow clone that cannot answer merge-base',
        world: { shallow: true },
        body: { baseRef: MAIN_REF, headRef: ORPHAN_REF },
        code: 'unprocessable',
        status: 422,
      },
      {
        label: 'a ref that does not exist',
        world: {},
        body: { baseRef: MAIN_REF, headRef: ABSENT_REF },
        code: 'not_found',
        status: 404,
      },
      {
        label: 'a ref name that fails validation',
        world: {},
        body: { baseRef: MAIN_REF, headRef: '-x' },
        code: 'unprocessable',
        status: 422,
      },
      {
        label: 'a body that is not a creation input at all',
        world: {},
        body: { baseRef: MAIN_REF },
        code: 'not_found',
        status: 400,
      },
    ] as const

    for (const c of cases) {
      const h = localHarness(c.world)
      const res = await createLocal(h.api, c.body)
      const envelope = (await res.json()) as { code: string }
      expect([c.label, res.status, envelope.code]).toEqual([c.label, c.status, c.code])
      // Nothing was recorded for a request that could not be satisfied.
      expect([c.label, h.store.listLocalReviews(LOCAL_REPO)]).toEqual([c.label, []])
      h.close()
    }
  })

  test('creating the same triple twice returns one id, 200 both times', async () => {
    const h = localHarness()
    const body = { baseRef: MAIN_REF, headRef: FEATURE_REF }
    const first = await createLocal(h.api, body)
    const second = await createLocal(h.api, body)
    expect([first.status, second.status]).toEqual([200, 200])
    const a = (await first.json()) as LocalReviewSummary
    const b = (await second.json()) as LocalReviewSummary
    // A duplicate pair is the review that already exists, not a conflict: the
    // retry of a request whose answer was lost must be safe.
    expect(b.id).toBe(a.id)
    expect(h.store.listLocalReviews(LOCAL_REPO).map((r) => r.id)).toEqual([a.id])
    h.close()
  })

  test('GET /api/local-reviews carries dirty and archivedPr on every item', async () => {
    const h = localHarness()
    await createLocal(h.api, { baseRef: MAIN_REF, headRef: FEATURE_REF })
    await createLocal(h.api, { baseRef: MAIN_REF, headRef: TWIN_REF })
    const res = await handleDirectApi(req('GET', '/api/local-reviews'), SESSION, h.api)
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as LocalReviewSummary[]
    expect(body.map((r) => r.headRef)).toEqual([FEATURE_REF, TWIN_REF])
    for (const item of body) {
      // This route is the ONLY wire path for the two local-only annotations, so
      // a key merely absent here is a key no client can ever read. Presence is
      // asserted structurally, then the whole shape against the contract's own
      // validator, which requires every column.
      expect(Object.hasOwn(item, 'dirty')).toBe(true)
      expect(Object.hasOwn(item, 'archivedPr')).toBe(true)
    }
    expect(() => validateLocalReviewSummaries(body)).not.toThrow()
    h.close()
  })

  test('a dirty worktree at sync time is served as dirty: true', async () => {
    const h = localHarness({ worktree: 'dirty' })
    const created = (await (
      await createLocal(h.api, { baseRef: MAIN_REF, headRef: FEATURE_REF })
    ).json()) as LocalReviewSummary
    const sync = await handleDirectApi(
      req('POST', `/api/pulls/${created.id}/sync`),
      SESSION,
      h.api,
    )
    expect(sync?.status).toBe(200)
    const list = (await (
      await handleDirectApi(req('GET', '/api/local-reviews'), SESSION, h.api)
    )?.json()) as LocalReviewSummary[]
    expect(list[0].dirty).toBe(true)
    h.close()
  })

  test('a worktree probe that cannot answer is served as dirty: false, never true', async () => {
    const h = localHarness({ worktree: 'unreadable' })
    const created = (await (
      await createLocal(h.api, { baseRef: MAIN_REF, headRef: FEATURE_REF })
    ).json()) as LocalReviewSummary

    // The probe genuinely fails, so the production detector answers `unknown` —
    // the third state, not one synthesized for this test.
    expect(await detectDirtyWorktree(h.runner, LOCAL_CWD)).toBe('unknown')

    const sync = await handleDirectApi(
      req('POST', `/api/pulls/${created.id}/sync`),
      SESSION,
      h.api,
    )
    expect(sync?.status).toBe(200)
    const list = (await (
      await handleDirectApi(req('GET', '/api/local-reviews'), SESSION, h.api)
    )?.json()) as LocalReviewSummary[]
    // Either answer would be defensible; this one is chosen and asserted, so
    // the wire meaning of `dirty: false` is "clean, or unknowable" by decision
    // rather than by a coercion nobody wrote down. The dirty case above is what
    // keeps this from passing on a `dirty` that is simply always false.
    expect(list[0].dirty).toBe(false)
    h.close()
  })

  test('GET /api/branches is a git read, and surfaces refs no stored review names', async () => {
    const h = localHarness()
    await createLocal(h.api, { baseRef: MAIN_REF, headRef: FEATURE_REF })
    const res = await handleDirectApi(req('GET', '/api/branches'), SESSION, h.api)
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as BranchRef[]
    expect(body.map((b) => b.ref)).toEqual([MAIN_REF, FEATURE_REF, REMOTE_MAIN_REF])
    // The remote-tracking ref is in no local-review row and in no store table —
    // a branch listing answered from stored reviews could not produce it, and a
    // base is frequently tracked and never checked out.
    expect(body.some((b) => b.ref === REMOTE_MAIN_REF && b.kind === 'remote')).toBe(true)
    expect(
      h.store.listLocalReviews(LOCAL_REPO).flatMap((r) => [r.baseRef, r.headRef]),
    ).not.toContain(REMOTE_MAIN_REF)
    // Exactly one entry is the default, and it is the local branch rather than
    // its remote-tracking copy.
    expect(body.filter((b) => b.isDefault).map((b) => b.ref)).toEqual([MAIN_REF])
    h.close()
  })

  test('DELETE /api/local-reviews/:n is served, and the review is gone afterwards', async () => {
    const h = localHarness()
    const created = (await (
      await createLocal(h.api, { baseRef: MAIN_REF, headRef: FEATURE_REF })
    ).json()) as LocalReviewSummary
    // The precondition, pinned rather than assumed: the row is there to be
    // removed, so an absence afterwards is the delete's doing and not a review
    // that was never recorded.
    expect(h.store.getLocalReview(created.id)).not.toBeNull()

    const res = await handleDirectApi(
      req('DELETE', `/api/local-reviews/${created.id}`),
      SESSION,
      h.api,
    )

    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ ok: true })
    expect(h.store.getLocalReview(created.id)).toBeNull()
    // The status alone cannot say the pins were dealt with: a delete that
    // removed the row and reached no git would answer 200 just the same. The
    // discovery argv is the evidence that the drop really ran, over this
    // review's own namespace and no other.
    expect(h.runner.argvs).toContainEqual([
      'git',
      'for-each-ref',
      '--format=%(refname)',
      '--end-of-options',
      `refs/revu/reviews/${created.id}/`,
    ])
    h.close()
  })

  test('deleting an id that was never created is a clean answer, not a 404', async () => {
    const h = localHarness()
    const neverCreated = LOCAL_REVIEW_ID_BASE + 4242
    // The control for the answer below: this id really does name nothing, so
    // the success is idempotence rather than a delete of something else.
    expect(h.store.getLocalReview(neverCreated)).toBeNull()

    const res = await handleDirectApi(
      req('DELETE', `/api/local-reviews/${neverCreated}`),
      SESSION,
      h.api,
    )

    // A retried removal whose first answer was lost has to be safe: "already
    // gone" is the outcome the caller asked for, and a 404 would report a
    // failure for the state the first call produced.
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ ok: true })
    h.close()
  })

  test('deleting a pull request number on the local route is refused by name', async () => {
    const h = localHarness()
    const res = await handleDirectApi(req('DELETE', '/api/local-reviews/204'), SESSION, h.api)

    // The other side of the idempotence above, and the reason it is not simply
    // "every id answers ok". A pull request number is a positive integer too,
    // so a clean success here would report a pull request removed as a review
    // of a branch pair — the mistake is named instead of absorbed.
    expect(res?.status).toBe(404)
    const body = (await res?.json()) as { code: string; message: string }
    expect(body.code).toBe('not_found')
    expect(body.message).toContain('local-review band')
    h.close()
  })
})

// ————————————————————————————————————————————————————————————————
// The pull list — the capability gate, and local reviews as list rows
// ————————————————————————————————————————————————————————————————

const LOCAL_ID_A = LOCAL_REVIEW_ID_BASE
const LOCAL_ID_B = LOCAL_REVIEW_ID_BASE + 1

/** A stored local review row, with every field the list reads spelled out. */
function localRow(id: number, over: Partial<LocalReviewSummary> = {}): LocalReviewSummary {
  return {
    id,
    repo: LOCAL_REPO,
    baseRef: MAIN_REF,
    headRef: FEATURE_REF,
    title: `review ${id}`,
    baseSha: MAIN_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    headSha: FEATURE_SHA,
    dirty: false,
    archivedPr: null,
    createdAt: LOCAL_NOW,
    updatedAt: LOCAL_NOW,
    lastSyncedAt: LOCAL_NOW,
    ...over,
  }
}

function localThread(id: string, isResolved: boolean): ReviewThread {
  return {
    id,
    isResolved,
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
    comments: [],
  }
}

function commit(index: number): CommitInfo {
  return {
    sha: `${index}`.padStart(40, '0'),
    commit: {
      message: `commit ${index}`,
      author: { name: 'Alice', email: 'alice@x.io', date: LOCAL_NOW },
    },
    author: null,
    parents: [],
  }
}

/** A stored local snapshot whose only interesting property is its commit count. */
function localSnapshotOf(localId: number, commits: number): Snapshot {
  return {
    prNumber: localId,
    syncedAt: LOCAL_NOW,
    partial: null,
    syncStats: { blobsFetched: 0, blobsReused: 0, requests: 0 },
    immutable: {
      compareKey: `${MERGE_BASE_SHA}...${FEATURE_SHA}`,
      mergeBaseSha: MERGE_BASE_SHA,
      headSha: FEATURE_SHA,
      files: [],
      blobIndex: {},
      commits: Array.from({ length: commits }, (_, i) => commit(i)),
    },
    mutable: {
      fetchedAt: LOCAL_NOW,
      pull: { number: localId } as Snapshot['mutable']['pull'],
      threads: [],
      issueComments: [],
      reviews: [],
      checks: [],
    },
  }
}

/**
 * The three reads the pull list makes of a local surface, over state a test can
 * move BETWEEN two requests — which is what makes "the etag followed the local
 * half" an observation rather than a restatement of how it was built.
 */
interface LocalListWorld {
  reviews: LocalReviewSummary[]
  threads: Map<number, ReviewThread[]>
  snapshots: Map<number, Snapshot>
}

function localListWorld(reviews: LocalReviewSummary[]): LocalListWorld {
  return { reviews, threads: new Map(), snapshots: new Map() }
}

/**
 * A local surface serving only what a list row is built from. Every other
 * method throws, so a list assembled through one of them fails loudly rather
 * than quietly returning a plausible value.
 */
function listOnlyLocalSurface(world: LocalListWorld): LocalReviewSurface {
  const unused = (name: string): never => {
    throw new Error(`the pull-list tests do not exercise ${name}`)
  }
  return {
    listLocalReviews: (): LocalReviewSummary[] => world.reviews.map((r) => ({ ...r })),
    listThreads: (localId: number): ReviewThread[] => world.threads.get(localId) ?? [],
    getSnapshot: (localId: number): Snapshot | null => world.snapshots.get(localId) ?? null,
    createLocalReview: () => unused('createLocalReview'),
    listBranches: () => unused('listBranches'),
    syncPull: () => unused('syncPull'),
    syncLocalReview: () => unused('syncLocalReview'),
    getDraft: () => unused('getDraft'),
    saveDraft: () => unused('saveDraft'),
    discardDraft: () => unused('discardDraft'),
    reconcileDraft: () => unused('reconcileDraft'),
    getFileViewed: () => unused('getFileViewed'),
    setFileViewed: () => unused('setFileViewed'),
    submitReview: () => unused('submitReview'),
    replyToThread: () => unused('replyToThread'),
    resolveThread: () => unused('resolveThread'),
    addReaction: () => unused('addReaction'),
  }
}

/** The poll loop's served view, over an etag a test can move between requests. */
interface PollWorld {
  etag: string
  items: PullListItem[]
}

const POLL_RATE_LIMIT: RateLimitInfo = {
  limit: 5000,
  remaining: 4321,
  used: 679,
  reset: '2026-03-01T00:00:00.000Z',
}

function pollSourceOver(world: PollWorld): PullListSource {
  return {
    listPulls(ifNoneMatch: string | null): PullListResponse {
      if (ifNoneMatch !== null && ifNoneMatch === world.etag) {
        return { items: [], etag: world.etag, notModified: true, rateLimit: POLL_RATE_LIMIT }
      }
      return {
        items: world.items,
        etag: world.etag,
        notModified: false,
        rateLimit: POLL_RATE_LIMIT,
      }
    },
  }
}

function remoteRef(ref: string, sha: string): GhRef {
  return { ref, sha, label: `o:${ref}`, repo: { full_name: LOCAL_REPO, default_branch: 'main' } }
}

/** A pull-request row of the kind the poll loop serves. */
function remoteItem(number: number): PullListItem {
  return {
    pull: {
      id: number,
      node_id: `PR_${number}`,
      number,
      state: 'open',
      draft: false,
      merged_at: null,
      title: `pull ${number}`,
      body: null,
      user: {
        login: 'carol',
        id: 9,
        node_id: '',
        avatar_url: '',
        html_url: '',
        type: 'User',
      },
      labels: [],
      requested_reviewers: [],
      head: remoteRef('feature', 'e'.repeat(40)),
      base: remoteRef('main', MAIN_SHA),
      created_at: LOCAL_NOW,
      updated_at: LOCAL_NOW,
    },
    broker: {
      authorHumanId: 'bob@x.io',
      canApprove: true,
      unresolvedThreads: 1,
      assignedReviewerHumanIds: ['alice@x.io'],
      compareKey: `${MERGE_BASE_SHA}...${'e'.repeat(40)}`,
      commitCount: 3,
    },
  }
}

/** The api under test, assembled with whichever list sources a case needs. */
function listApi(sources: {
  store: DirectStore
  local?: LocalListWorld
  poll?: PollWorld
}): DirectApi {
  return createDirectApi({
    session: SESSION,
    github: throwingGithubClient(),
    repo: LOCAL_REPO_REF,
    store: sources.store,
    ...(sources.local ? { localReviews: listOnlyLocalSurface(sources.local) } : {}),
    ...(sources.poll ? { pullList: pollSourceOver(sources.poll) } : {}),
  })
}

async function getList(
  api: DirectApi,
  etag?: string,
  mode?: 'direct' | 'broker',
): Promise<Response> {
  const request = new Request('http://localhost/api/pulls', {
    method: 'GET',
    ...(etag === undefined ? {} : { headers: { 'if-none-match': etag } }),
  })
  const res = await handleDirectApi(request, SESSION, api, mode)
  expect(res).not.toBeNull()
  return res as Response
}

describe('handleDirectApi: the pull list', () => {
  test('an api with neither a poll loop nor a local surface still answers 501', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const api = listApi({ store })
    const res = await getList(api)
    expect(res.status).toBe(501)
    expect(((await res.json()) as { code: string }).code).toBe('not_implemented')

    // The landmine this guards, pinned as an independent observation rather
    // than inferred from the status above: the api underneath throws a typed
    // `not_found`, which the error envelope renders as a 404. Only the
    // capability gate keeps the route from reaching it, so a naive removal of
    // the gate turns today's honest 501 into a misleading "no such resource".
    expect(api.pullListEnabled).toBe(false)
    let thrown: unknown = null
    try {
      api.listPulls(null)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).code).toBe('not_found')
    store.close()
  })

  test('a local review becomes a list row with a complete broker meta', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const world = localListWorld([localRow(LOCAL_ID_A)])
    world.threads.set(LOCAL_ID_A, [
      localThread('t1', false),
      localThread('t2', true),
      localThread('t3', false),
    ])
    world.snapshots.set(LOCAL_ID_A, localSnapshotOf(LOCAL_ID_A, 4))
    const api = listApi({ store, local: world })

    const res = await getList(api)
    expect(res.status).toBe(200)
    // Validated against the frozen contract shape, so a meta missing a required
    // field is caught here rather than by whatever renders it.
    const body = validatePullListResponse(await res.json())
    expect(body.items.length).toBe(1)
    const item = body.items[0]

    expect(item.pull.number).toBe(LOCAL_ID_A)
    expect(item.pull.title).toBe(`review ${LOCAL_ID_A}`)
    expect(item.pull.state).toBe('open')

    expect(item.broker.authorHumanId).toBeNull()
    // No self-review rule applies to a review of a local branch pair.
    expect(item.broker.canApprove).toBe(true)
    // Counted from the local threads, not carried on the row.
    expect(item.broker.unresolvedThreads).toBe(2)
    expect(item.broker.compareKey).toBe(`${MERGE_BASE_SHA}...${FEATURE_SHA}`)
    expect(item.broker.commitCount).toBe(4)
    // ABSENT, not empty: nothing has reported on a branch that was never
    // pushed, which is neither a pass nor a failure.
    expect(item.broker.checks).toBeUndefined()
    expect('checks' in item.broker).toBe(false)
    // The two local-only annotations ride the local-review summary instead, so
    // no surface renders a row from two sources of truth.
    expect('dirty' in item.broker).toBe(false)
    expect('archivedPr' in item.broker).toBe(false)

    // Nothing was spent to assemble this, so the honest-error copy reads "not
    // rate limited" rather than borrowing a GitHub reading this never took.
    expect(body.rateLimit.used).toBe(0)
    expect(body.rateLimit.remaining).toBeGreaterThan(0)
    expect(body.notModified).toBe(false)
    store.close()
  })

  test('replaying the list etag is a BODILESS 304 with the etag echoed', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const world = localListWorld([localRow(LOCAL_ID_A)])
    const api = listApi({ store, local: world })

    const first = await getList(api)
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag') as string
    expect(etag).toBeTruthy()
    await first.body?.cancel()

    const replay = await getList(api, etag)
    expect(replay.status).toBe(304)
    expect(replay.headers.get('etag')).toBe(etag)
    // A 304 carries NO body — a status assertion alone would pass on a 304 that
    // shipped the whole list anyway.
    expect(await replay.text()).toBe('')
    store.close()
  })

  test('GET /api/pulls/<localId>/threads is a 501 even on a list-capable api', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const api = listApi({ store, local: localListWorld([localRow(LOCAL_ID_A)]) })
    const res = await handleDirectApi(
      req('GET', `/api/pulls/${LOCAL_ID_A}/threads`),
      SESSION,
      api,
    )
    // Local threads ride the snapshot's mutable half. A second thread read that
    // could disagree with the snapshot the client is already rendering is two
    // sources of truth for one set of threads, so the route stays unserved.
    expect(res?.status).toBe(501)
    const body = (await res?.json()) as { code: string }
    expect(body.code).toBe('not_implemented')
    store.close()
  })

  test('a resolved thread moves the etag while no sha moves — the count cannot sit behind a 304', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const world = localListWorld([localRow(LOCAL_ID_A)])
    world.threads.set(LOCAL_ID_A, [localThread('t1', false)])
    const api = listApi({ store, local: world })

    const first = await getList(api)
    expect(first.status).toBe(200)
    const etag1 = first.headers.get('etag') as string
    const body1 = validatePullListResponse(await first.json())
    expect(body1.items[0].broker.unresolvedThreads).toBe(1)

    // Resolve the one thread. `unresolvedThreads` moves and NOTHING else does:
    // both shas stand still, so the compare key is byte-identical before and
    // after — exactly the change an etag composed from compare keys alone
    // would hide behind a 304 forever, leaving the inbox on a stale count.
    world.threads.set(LOCAL_ID_A, [localThread('t1', true)])
    const after = await getList(api, etag1)
    expect(after.status).toBe(200)
    const etag2 = after.headers.get('etag') as string
    expect(etag2).not.toBe(etag1)
    const body2 = validatePullListResponse(await after.json())
    expect(body2.items[0].broker.unresolvedThreads).toBe(0)
    expect(body2.items[0].broker.compareKey).toBe(body1.items[0].broker.compareKey)
    // The moved etag is stable in its own turn: nothing else changed, so a
    // replay of it is a genuine 304.
    expect((await getList(api, etag2)).status).toBe(304)
    store.close()
  })

  test('a rename moves the etag while no sha moves', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const world = localListWorld([localRow(LOCAL_ID_A)])
    const api = listApi({ store, local: world })

    const first = await getList(api)
    const etag1 = first.headers.get('etag') as string
    await first.body?.cancel()

    // Retitle the review: the served row changes and no compare key does.
    world.reviews[0] = localRow(LOCAL_ID_A, { title: 'renamed review' })
    const after = await getList(api, etag1)
    expect(after.status).toBe(200)
    expect(after.headers.get('etag')).not.toBe(etag1)
    const body = validatePullListResponse(await after.json())
    expect(body.items[0].pull.title).toBe('renamed review')
    store.close()
  })

  test('the merged list carries both halves, and either half moves the etag', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    const poll: PollWorld = { etag: 'W/"upstream-1"', items: [remoteItem(101), remoteItem(102)] }
    const world = localListWorld([localRow(LOCAL_ID_A), localRow(LOCAL_ID_B)])
    const api = listApi({ store, local: world, poll })

    const first = await getList(api, undefined, 'broker')
    expect(first.status).toBe(200)
    const etag1 = first.headers.get('etag') as string
    const body1 = validatePullListResponse(await first.json())
    // Poll-loop items in their existing order, then local reviews by id
    // descending — one deterministic order, so the etag is a function of the
    // list rather than of the order two sources happened to answer in.
    expect(body1.items.map((it) => it.pull.number)).toEqual([
      101,
      102,
      LOCAL_ID_B,
      LOCAL_ID_A,
    ])
    // The broker half keeps the live allowance; only a purely local list can
    // honestly claim nothing was spent.
    expect(body1.rateLimit.used).toBe(POLL_RATE_LIMIT.used)

    const idle = await getList(api, etag1, 'broker')
    expect(idle.status).toBe(304)
    await idle.body?.cancel()

    // Move ONLY the local half.
    world.reviews[1] = localRow(LOCAL_ID_B, { headSha: 'f'.repeat(40) })
    const afterLocal = await getList(api, etag1, 'broker')
    expect(afterLocal.status).toBe(200)
    const etag2 = afterLocal.headers.get('etag') as string
    expect(etag2).not.toBe(etag1)
    await afterLocal.body?.cancel()
    expect((await getList(api, etag2, 'broker')).status).toBe(304)

    // Move ONLY the poll half. An inbox that 304s forever and never shows a new
    // pull request is exactly what an etag derived from the local half alone
    // would produce here.
    poll.etag = 'W/"upstream-2"'
    poll.items = [...poll.items, remoteItem(103)]
    const afterPoll = await getList(api, etag2, 'broker')
    expect(afterPoll.status).toBe(200)
    const etag3 = afterPoll.headers.get('etag') as string
    expect(etag3).not.toBe(etag2)
    expect(etag3).not.toBe(etag1)
    const body3 = validatePullListResponse(await afterPoll.json())
    expect(body3.items.map((it) => it.pull.number)).toEqual([
      101,
      102,
      103,
      LOCAL_ID_B,
      LOCAL_ID_A,
    ])
    expect((await getList(api, etag3, 'broker')).status).toBe(304)
    store.close()
  })
})

// ————————————————————————————————————————————————————————————————————————————
// The write path across the id bands.
//
// Two places above the api read or gate a review id, and both belong to the
// router alone: the broker's reads-only write gate, and the reaction handler's
// resolution of the review its route does not carry. Everything below drives
// `handleDirectApi` directly and records what the api was HANDED, because a
// write to the wrong sink answers 200 exactly like a write to the right one.
// ————————————————————————————————————————————————————————————————————————————

/**
 * A local review id, and a locally minted entity (comment) id.
 *
 * The comment id comes from the ENTITY band, which sits ABOVE the review band —
 * so `isLocalReviewId` answers true of it while it names no review at all. A
 * band check aimed at a route's comment id instead of at the owning review
 * would therefore call EVERY reaction write local, including one on a pull
 * request. That is the shape these ids are chosen to expose.
 */
const WRITE_LOCAL_REVIEW = LOCAL_REVIEW_ID_BASE + 7
const WRITE_LOCAL_COMMENT = LOCAL_ENTITY_ID_BASE + 11

/** A pull request and one of its GitHub comment ids — the other side of the band. */
const WRITE_GITHUB_PR = 204
const WRITE_GITHUB_COMMENT = 7788

/**
 * The review id each of the four write methods was handed, in call order —
 * plus the comment id for the reaction, whose route carries the two separately
 * and can therefore mix them up.
 */
interface RecordedWrites {
  submitReview: number[]
  replyToThread: number[]
  resolveThread: number[]
  addReaction: { prNumber: number; commentId: number }[]
}

/**
 * The fake surface, wrapped so every write records the arguments it received
 * before delegating. The recording is the assertion target: a response body
 * cannot distinguish a write that reached the intended review from one that
 * reached another, since both ids are ordinary positive integers.
 */
function recordingApi(): { api: DirectApi; writes: RecordedWrites } {
  const writes: RecordedWrites = {
    submitReview: [],
    replyToThread: [],
    resolveThread: [],
    addReaction: [],
  }
  const base = fakeApi()
  const api: DirectApi = {
    ...base,
    async submitReview(input) {
      writes.submitReview.push(input.prNumber)
      return base.submitReview(input)
    },
    async replyToThread(prNumber, threadId, body) {
      writes.replyToThread.push(prNumber)
      return base.replyToThread(prNumber, threadId, body)
    },
    async resolveThread(prNumber, threadId, resolved) {
      writes.resolveThread.push(prNumber)
      return base.resolveThread(prNumber, threadId, resolved)
    },
    async addReaction(prNumber, commentId, reaction) {
      writes.addReaction.push({ prNumber, commentId })
      return base.addReaction(prNumber, commentId, reaction)
    },
  }
  return { api, writes }
}

/** No write of any kind reached the api. */
const NO_WRITES: RecordedWrites = {
  submitReview: [],
  replyToThread: [],
  resolveThread: [],
  addReaction: [],
}

/**
 * The four write routes aimed at one review, each as a fresh `Request` — a
 * request body is consumable once, so the same case cannot be replayed across
 * modes without rebuilding it.
 *
 * `path` is the URL PATHNAME, which is what the refusal message quotes: the
 * reaction's `?pr=` never appears in it.
 */
function writeRequests(
  reviewId: number,
  commentId: number,
): { endpoint: string; path: string; request: () => Request }[] {
  return [
    {
      endpoint: 'submitReview',
      path: `/api/pulls/${reviewId}/review`,
      request: () =>
        req('POST', `/api/pulls/${reviewId}/review`, {
          prNumber: reviewId,
          expectedHeadSha: 'h'.repeat(40),
          event: 'COMMENT',
          body: 'looks good',
          comments: [],
        }),
    },
    {
      endpoint: 'replyToThread',
      path: `/api/pulls/${reviewId}/threads/T1/reply`,
      request: () => req('POST', `/api/pulls/${reviewId}/threads/T1/reply`, { body: 'agreed' }),
    },
    {
      endpoint: 'resolveThread',
      path: `/api/pulls/${reviewId}/threads/T1/resolve`,
      request: () => req('POST', `/api/pulls/${reviewId}/threads/T1/resolve`, { resolved: true }),
    },
    {
      endpoint: 'addReaction',
      path: `/api/comments/${commentId}/reactions`,
      request: () =>
        req('POST', `/api/comments/${commentId}/reactions?pr=${reviewId}`, { reaction: '+1' }),
    },
  ]
}

/**
 * The refusal a reads-only broker answers a gated write with, spelled out here
 * rather than derived from the router — a message compared against the code
 * that produced it asserts nothing about the message.
 */
function readsOnlyRefusalMessage(path: string): string {
  return (
    `POST ${path} is not available: this broker has no bot identity ` +
    '(REVU_BOT_LOGIN) configured, so it is reads-only.'
  )
}

describe('handleDirectApi: the write path across the id bands', () => {
  test('a reads-only broker serves the four writes on a local review and still refuses them on a pull request', async () => {
    // The gate's precondition, pinned rather than assumed: this api carries no
    // broker write capability, so the gate under test is armed.
    const local = recordingApi()
    expect(local.api.brokerWritesEnabled).toBe(false)

    // A local review touches no GitHub and needs no bot identity, so every one
    // of the four is served — and reaches the surface carrying the local id.
    for (const route of writeRequests(WRITE_LOCAL_REVIEW, WRITE_LOCAL_COMMENT)) {
      const res = await handleDirectApi(route.request(), SESSION, local.api, 'broker')
      expect(res).not.toBeNull()
      expect(res?.status).toBe(200)
    }
    expect(local.writes).toEqual({
      submitReview: [WRITE_LOCAL_REVIEW],
      replyToThread: [WRITE_LOCAL_REVIEW],
      resolveThread: [WRITE_LOCAL_REVIEW],
      addReaction: [{ prNumber: WRITE_LOCAL_REVIEW, commentId: WRITE_LOCAL_COMMENT }],
    })

    // The same four on a pull request are unchanged: 501, the typed code, and
    // the bot-identity message byte for byte.
    const pull = recordingApi()
    for (const route of writeRequests(WRITE_GITHUB_PR, WRITE_GITHUB_COMMENT)) {
      const res = await handleDirectApi(route.request(), SESSION, pull.api, 'broker')
      expect(res?.status).toBe(501)
      const body = (await res?.json()) as { code: string; message: string }
      expect(body.code).toBe('not_implemented')
      expect(body.message).toBe(readsOnlyRefusalMessage(route.path))
    }
    expect(pull.writes).toEqual(NO_WRITES)

    // Direct mode is untouched on both ids: its writes are gated by mode, and
    // this gate never applied to it.
    for (const [reviewId, commentId] of [
      [WRITE_LOCAL_REVIEW, WRITE_LOCAL_COMMENT],
      [WRITE_GITHUB_PR, WRITE_GITHUB_COMMENT],
    ] as const) {
      const direct = recordingApi()
      for (const route of writeRequests(reviewId, commentId)) {
        const res = await handleDirectApi(route.request(), SESSION, direct.api, 'direct')
        expect(res?.status).toBe(200)
      }
      expect(direct.writes).toEqual({
        submitReview: [reviewId],
        replyToThread: [reviewId],
        resolveThread: [reviewId],
        addReaction: [{ prNumber: reviewId, commentId }],
      })
    }
  })

  test("the reaction's band decision reads the review the router resolved, never a second parse", async () => {
    // The comment id satisfies the review-band predicate on its own — the
    // entity band sits above the review band — so a decision that read the
    // route's `:id` would classify a reaction on ANY comment as local.
    expect(WRITE_LOCAL_COMMENT).toBeGreaterThan(LOCAL_REVIEW_ID_BASE)

    const served = recordingApi()
    const ok = await handleDirectApi(
      req('POST', `/api/comments/${WRITE_LOCAL_COMMENT}/reactions?pr=${WRITE_LOCAL_REVIEW}`, {
        reaction: '+1',
      }),
      SESSION,
      served.api,
      'broker',
    )
    expect(ok?.status).toBe(200)
    expect(served.writes.addReaction).toEqual([
      { prNumber: WRITE_LOCAL_REVIEW, commentId: WRITE_LOCAL_COMMENT },
    ])

    // The contradictory pairing: the query names a local review, the body names
    // a pull request. Whichever the router picks, the value it BANDED and the
    // value it PASSED ON must be the same one — and only the recorded argument
    // can say so, because either choice answers an indistinguishable 200.
    const contradictory = recordingApi()
    const res = await handleDirectApi(
      req('POST', `/api/comments/${WRITE_LOCAL_COMMENT}/reactions?pr=${WRITE_LOCAL_REVIEW}`, {
        reaction: '+1',
        prNumber: WRITE_GITHUB_PR,
      }),
      SESSION,
      contradictory.api,
      'broker',
    )
    expect(res?.status).toBe(200)
    expect(contradictory.writes.addReaction).toEqual([
      { prNumber: WRITE_LOCAL_REVIEW, commentId: WRITE_LOCAL_COMMENT },
    ])
    expect(contradictory.writes.addReaction[0]?.prNumber).not.toBe(WRITE_GITHUB_PR)
  })

  test('an id at the top of the entity band survives the router parse exactly', async () => {
    // Every id the router reads arrives as a decimal string and becomes a
    // double through `Number()`. Below the exact-integer ceiling that round
    // trips; at or above it, adjacent integers collapse onto one value and a
    // write silently lands on a neighbouring entity.
    //
    // The ceiling is ASSERTED, not assumed: `MAX_SAFE_INTEGER` is where the
    // collapse begins, and the entity band's base sits a hundredfold below it,
    // so the band has room to grow before the parse stops being lossless.
    expect(LOCAL_ENTITY_ID_BASE * 100).toBeLessThan(Number.MAX_SAFE_INTEGER)

    // The falsification, so the round-trip below is a real boundary rather than
    // a property of every decimal string: two past the ceiling does NOT survive.
    const pastCeiling = (BigInt(Number.MAX_SAFE_INTEGER) + 2n).toString()
    expect(String(Number(pastCeiling))).not.toBe(pastCeiling)

    // The largest id any band may mint and still be read back unchanged.
    const topOfBand = Number.MAX_SAFE_INTEGER
    expect(Number(String(topOfBand))).toBe(topOfBand)

    const api = recordingApi()
    const res = await handleDirectApi(
      req('POST', `/api/comments/${topOfBand}/reactions?pr=${WRITE_LOCAL_REVIEW}`, {
        reaction: '+1',
      }),
      SESSION,
      api.api,
      'broker',
    )
    expect(res?.status).toBe(200)
    expect(api.writes.addReaction).toEqual([
      { prNumber: WRITE_LOCAL_REVIEW, commentId: topOfBand },
    ])
  })
})

// ————————————————————————————————————————————————————————————————————————————
// A daemon assembled with no GitHub repository.
//
// Reviewing two local branches needs no origin, no token and no viewer, so the
// api may be assembled with its GitHub half absent by TYPE. The routes only
// GitHub can answer must then degrade to a typed contract answer that names the
// missing repository — never to the router's terminal catch-all, which emits
// `broker_unreachable` (500) and so reports a broker outage to a deployment
// whose whole premise is that it has no broker.
//
// Degradation is decided per REVIEW, never per route template: the five `:n`
// write/sync routes and the snapshot read serve a review of a local branch pair
// perfectly well, and only a pull request id makes them GitHub-bound.
// ————————————————————————————————————————————————————————————————————————————

/** The review ids one GitHub-less daemon is driven with, and a comment on each. */
const NO_GH_LOCAL_REVIEW = LOCAL_REVIEW_ID_BASE + 3
const NO_GH_LOCAL_COMMENT = LOCAL_ENTITY_ID_BASE + 5
const NO_GH_PULL = 511
const NO_GH_PULL_COMMENT = 9001

/** A well-formed draft for one review — the body the draft PUT is driven with. */
function noGithubDraft(reviewId: number): ReviewDraft {
  return {
    humanId: SESSION.human.id,
    prNumber: reviewId,
    headSha: FEATURE_SHA,
    compareKey: `${MERGE_BASE_SHA}...${FEATURE_SHA}`,
    body: 'a draft that needs no repository',
    event: 'COMMENT',
    comments: [],
    createdAt: LOCAL_NOW,
    updatedAt: LOCAL_NOW,
  }
}

/**
 * A local surface that serves EVERY method, recording which one it entered.
 *
 * The recording is what turns "the local band still reaches the local surface"
 * into an observation: a degraded route and a served one can both answer with a
 * plausible body, and only the entered method tells them apart.
 *
 * The write path's response shapes are borrowed from the hand-rolled fake above
 * rather than restated, so this surface carries no second opinion about what a
 * reply or a reaction rollup looks like.
 */
function servingLocalSurface(calls: string[]): LocalReviewSurface {
  const shapes = fakeApi()
  return {
    async createLocalReview(input: CreateLocalReviewInput): Promise<LocalReviewSummary> {
      calls.push('createLocalReview')
      return localRow(NO_GH_LOCAL_REVIEW, {
        baseRef: input.baseRef,
        headRef: input.headRef,
        title: input.title ?? input.headRef,
      })
    },
    listLocalReviews(): LocalReviewSummary[] {
      calls.push('listLocalReviews')
      return [localRow(NO_GH_LOCAL_REVIEW)]
    },
    async listBranches(): Promise<BranchRef[]> {
      calls.push('listBranches')
      return [
        { ref: MAIN_REF, name: 'main', kind: 'local', isDefault: true },
        { ref: FEATURE_REF, name: 'feature/x', kind: 'local', isDefault: false },
      ]
    },
    syncLocalReview: (): never => {
      // Never driven through this double: the real surface's `syncPull`
      // delegates here, but a double implements `syncPull` directly.
      throw new Error('these tests do not exercise syncLocalReview')
    },

    async syncPull(localId: number): Promise<Snapshot> {
      calls.push('syncPull')
      return localSnapshotOf(localId, 1)
    },
    getSnapshot(localId: number): Snapshot | null {
      calls.push('getSnapshot')
      return localSnapshotOf(localId, 1)
    },
    getDraft(): ReviewDraft | null {
      calls.push('getDraft')
      return null
    },
    saveDraft(draft: ReviewDraft): ReviewDraft {
      calls.push('saveDraft')
      return draft
    },
    discardDraft(): void {
      calls.push('discardDraft')
    },
    reconcileDraft(localId: number): ReconcileReport {
      calls.push('reconcileDraft')
      return {
        prNumber: localId,
        draftHeadSha: FEATURE_SHA,
        currentHeadSha: FEATURE_SHA,
        newCommits: [],
        results: [],
      }
    },
    getFileViewed(): FileViewedState {
      calls.push('getFileViewed')
      return {}
    },
    setFileViewed(): FileViewedState {
      calls.push('setFileViewed')
      return {}
    },
    async submitReview(input): Promise<SubmitResult> {
      calls.push('submitReview')
      return shapes.submitReview(input)
    },
    async replyToThread(localId, threadId, body): Promise<ReviewComment> {
      calls.push('replyToThread')
      return shapes.replyToThread(localId, threadId, body)
    },
    async resolveThread(_localId, threadId, resolved): Promise<ReviewThread> {
      calls.push('resolveThread')
      return localThread(threadId, resolved)
    },
    async addReaction(localId, commentId, reaction): Promise<ReactionRollup> {
      calls.push('addReaction')
      return shapes.addReaction(localId, commentId, reaction)
    },
    listThreads(): ReviewThread[] {
      calls.push('listThreads')
      return []
    },
  }
}

interface NoGithubHarness {
  api: DirectApi
  store: DirectStore
  /** Which local-surface methods were entered, in order. */
  calls: string[]
  close(): void
}

/**
 * The router over a REAL api assembled WITHOUT a repository — the shape a boot
 * inside a git repository that has no `origin` remote produces.
 *
 * A GitHub client is wired even so, and every one of its methods throws: the
 * absence under test is the repository, and a route that leaked past the
 * degradation must fail by naming the client method it reached rather than
 * quietly answering something plausible.
 */
function noGithubHarness(): NoGithubHarness {
  const store = openDirectStore({ dataDir: ':memory:' })
  const calls: string[] = []
  const api = createDirectApi({
    session: SESSION,
    github: throwingGithubClient(),
    store,
    // A daemon with no repository on GitHub still has one on disk — that is the
    // whole deployment — so the git seam is wired here exactly as boot wires it.
    // Without it a removal could not drop a review's pins and would refuse.
    runner: fakeGit({ shallow: false, worktree: 'clean' }),
    cwd: LOCAL_CWD,
    localReviews: servingLocalSurface(calls),
  })
  return { api, store, calls, close: () => store.close() }
}

/**
 * One row of the route-table classification: the contract route, the request
 * that exercises it against a GitHub-less daemon, and the exact answer expected.
 *
 * The path is always built from the route TEMPLATE, so a row cannot drift onto a
 * path the contract does not declare. `query` rides separately because a query
 * string belongs to no template.
 */
interface NoGithubRow {
  readonly name: RouteName
  readonly query?: string
  readonly body?: unknown
  readonly status: number
  /** The `code` of an error envelope; absent when the answer is a success body. */
  readonly code?: string
}

function requestFor(row: NoGithubRow, params: Record<string, string | number>): Request {
  const route = ROUTES[row.name]
  const path = fillPath(route.path, params) + (row.query ?? '')
  return req(route.method, path, row.body)
}

/** The pull-request-band params every GitHub-bound row is filled with. */
const NO_GH_PULL_PARAMS = {
  n: NO_GH_PULL,
  threadId: 'T1',
  id: NO_GH_PULL_COMMENT,
  sha: 'f'.repeat(40),
}

/** The same params in the local band, for the routes that are band-shared. */
const NO_GH_LOCAL_PARAMS = {
  n: NO_GH_LOCAL_REVIEW,
  threadId: 'T1',
  id: NO_GH_LOCAL_COMMENT,
  sha: 'f'.repeat(40),
}

/**
 * The routes a daemon with no repository DEGRADES: each answers
 * `not_implemented` (501) with a message naming the missing repository.
 *
 * Six of the seven are GitHub-bound only for a PULL REQUEST id, so each is
 * driven with one. `getRateLimit` carries no review id at all — the allowance
 * belongs to the credential, and there is no credential.
 */
const NO_GITHUB_DEGRADED: readonly NoGithubRow[] = [
  { name: 'syncPull', status: 501, code: 'not_implemented' },
  { name: 'getSnapshot', status: 501, code: 'not_implemented' },
  {
    name: 'submitReview',
    body: {
      prNumber: NO_GH_PULL,
      expectedHeadSha: 'h'.repeat(40),
      event: 'COMMENT',
      body: 'looks good',
      comments: [],
    },
    status: 501,
    code: 'not_implemented',
  },
  { name: 'replyToThread', body: { body: 'agreed' }, status: 501, code: 'not_implemented' },
  { name: 'resolveThread', body: { resolved: true }, status: 501, code: 'not_implemented' },
  {
    name: 'addReaction',
    query: `?pr=${NO_GH_PULL}`,
    body: { reaction: '+1' },
    status: 501,
    code: 'not_implemented',
  },
  { name: 'getRateLimit', status: 501, code: 'not_implemented' },
]

/**
 * The routes a daemon with no repository SERVES in full. Drafts, viewed marks
 * and preferences are per-human store state no repository is involved in, so
 * they are driven with a PULL REQUEST id deliberately: their answer does not
 * depend on the band either.
 *
 * Three rows answer a typed `not_found` (404) rather than a 200, and each is
 * the route's ordinary contract answer for the request as driven here — an
 * absent blob, a reconcile of a review that has no draft, and a delete naming a
 * PULL REQUEST number on the route that removes reviews of local branch pairs.
 * None of the three is a refusal, and none of them turns on the missing
 * repository: the delete is served in full for an id in the local band, which
 * the band-shared table below drives and asserts.
 */
const NO_GITHUB_SERVED: readonly NoGithubRow[] = [
  { name: 'getSession', status: 200 },
  { name: 'listPulls', status: 200 },
  { name: 'getBlob', status: 404, code: 'not_found' },
  { name: 'getDraft', status: 200 },
  { name: 'saveDraft', body: noGithubDraft(NO_GH_PULL), status: 200 },
  { name: 'discardDraft', status: 200 },
  { name: 'reconcileDraft', status: 404, code: 'not_found' },
  { name: 'getFileViewed', status: 200 },
  { name: 'setFileViewed', body: { path: 'a.ts', viewed: true, blobSha: null }, status: 200 },
  { name: 'getPreferences', status: 200 },
  { name: 'setPreferences', body: { diffMode: 'split' }, status: 200 },
  { name: 'listBranches', status: 200 },
  { name: 'createLocalReview', body: { baseRef: MAIN_REF, headRef: FEATURE_REF }, status: 200 },
  { name: 'listLocalReviews', status: 200 },
  { name: 'deleteLocalReview', status: 404, code: 'not_found' },
]

/**
 * The routes nobody has implemented, whether or not a repository is configured.
 * The 501 predates this degradation and says something different: the GraphQL
 * thread read has not landed. Its message may not claim a missing repository.
 */
const NO_GITHUB_NOT_IMPLEMENTED: readonly NoGithubRow[] = [
  { name: 'listReviewThreads', status: 501, code: 'not_implemented' },
]

/** The band-shared routes with a LOCAL review id, and the method each must enter. */
const NO_GITHUB_LOCAL_BAND: readonly { row: NoGithubRow; surfaceCall: string }[] = [
  { row: { name: 'syncPull', status: 200 }, surfaceCall: 'syncPull' },
  { row: { name: 'getSnapshot', status: 200 }, surfaceCall: 'getSnapshot' },
  {
    row: {
      name: 'submitReview',
      body: {
        prNumber: NO_GH_LOCAL_REVIEW,
        expectedHeadSha: 'h'.repeat(40),
        event: 'COMMENT',
        body: 'looks good',
        comments: [],
      },
      status: 200,
    },
    surfaceCall: 'submitReview',
  },
  {
    row: { name: 'replyToThread', body: { body: 'agreed' }, status: 200 },
    surfaceCall: 'replyToThread',
  },
  {
    row: { name: 'resolveThread', body: { resolved: true }, status: 200 },
    surfaceCall: 'resolveThread',
  },
  {
    row: {
      name: 'addReaction',
      query: `?pr=${NO_GH_LOCAL_REVIEW}`,
      body: { reaction: '+1' },
      status: 200,
    },
    surfaceCall: 'addReaction',
  },
  // The removal reaches the surface for its OWNERSHIP read: ids are minted from
  // one mark shared by every repository using the data directory, so the row an
  // id names may belong to a repository this daemon does not serve, and the
  // listing scoped to this one is what settles that.
  { row: { name: 'deleteLocalReview', status: 200 }, surfaceCall: 'listLocalReviews' },
]

describe('handleDirectApi: a daemon with no GitHub repository', () => {
  test('every GitHub-bound route degrades to a typed answer naming the missing repository', async () => {
    for (const row of NO_GITHUB_DEGRADED) {
      const h = noGithubHarness()
      // The precondition, pinned rather than assumed: this api reports no
      // GitHub half, so the degradation under test is armed.
      expect(h.api.githubEnabled).toBe(false)
      const res = await handleDirectApi(requestFor(row, NO_GH_PULL_PARAMS), SESSION, h.api)
      expect(res).not.toBeNull()
      const body = (await res?.json()) as { code: string; message: string }
      expect([row.name, res?.status, body.code]).toEqual([row.name, row.status, row.code])
      // The message is the whole point of the degradation, so it is asserted
      // rather than described: the reader must learn that this daemon has no
      // repository, not that a broker they do not run is unreachable.
      expect([row.name, /no GitHub repository/i.test(body.message)]).toEqual([row.name, true])
      // Nothing reached the local surface: these ids name pull requests.
      expect([row.name, h.calls]).toEqual([row.name, []])
      h.close()
    }
  })

  test('every other route is served in full, with no repository configured', async () => {
    for (const row of NO_GITHUB_SERVED) {
      const h = noGithubHarness()
      const res = await handleDirectApi(requestFor(row, NO_GH_PULL_PARAMS), SESSION, h.api)
      expect([row.name, res?.status]).toEqual([row.name, row.status])
      const body = (await res?.json()) as { code?: string; message?: string } | null
      const envelope = body !== null && typeof body === 'object' ? body : {}
      expect([row.name, envelope.code]).toEqual([row.name, row.code])
      // No served route may borrow the degradation's message — that would make
      // a working route read as a refusal.
      expect([row.name, /no GitHub repository/i.test(envelope.message ?? '')]).toEqual([
        row.name,
        false,
      ])
      h.close()
    }
  })

  test('the unimplemented routes keep their own 501 and never claim a missing repository', async () => {
    for (const row of NO_GITHUB_NOT_IMPLEMENTED) {
      const h = noGithubHarness()
      const res = await handleDirectApi(requestFor(row, NO_GH_LOCAL_PARAMS), SESSION, h.api)
      const body = (await res?.json()) as { code: string; message: string }
      expect([row.name, res?.status, body.code]).toEqual([row.name, row.status, row.code])
      expect([row.name, /no GitHub repository/i.test(body.message)]).toEqual([row.name, false])
      h.close()
    }
  })

  test('the three buckets partition the whole route table exactly', () => {
    const classified = [
      ...NO_GITHUB_DEGRADED,
      ...NO_GITHUB_SERVED,
      ...NO_GITHUB_NOT_IMPLEMENTED,
    ].map((row) => row.name)

    // No route may be classified twice — two buckets claiming one route would
    // otherwise mask a route that sits in none of them.
    expect(new Set(classified).size).toBe(classified.length)

    // Every route the contract declares is classified, and nothing outside it
    // is. A route added later therefore fails HERE, rather than falling quietly
    // into the router's `broker_unreachable` (500) catch-all on a daemon that
    // has no repository.
    const classifiedRoutes = classified
      .map((name) => `${ROUTES[name].method} ${ROUTES[name].path}`)
      .sort()
    const everyRoute = Object.values(ROUTES)
      .map((route) => `${route.method} ${route.path}`)
      .sort()
    expect(classifiedRoutes).toEqual(everyRoute)
  })

  test('a local review id still reaches the local surface on every band-shared route', async () => {
    for (const { row, surfaceCall } of NO_GITHUB_LOCAL_BAND) {
      const h = noGithubHarness()
      const res = await handleDirectApi(requestFor(row, NO_GH_LOCAL_PARAMS), SESSION, h.api)
      expect([row.name, res?.status]).toEqual([row.name, row.status])
      // The status alone cannot say the feature survived: a degradation that
      // answered 200 with a plausible body would pass it. The entered method can.
      expect([row.name, h.calls]).toEqual([row.name, [surfaceCall]])
      h.close()
    }
  })

  test('the capability reports the two halves together, and an api holding neither', async () => {
    const store = openDirectStore({ dataDir: ':memory:' })
    // The shape a `--local-only` boot in a repository with no origin produces:
    // the repo and the client are both typed-absent, never blank stand-ins.
    const bare = createDirectApi({ session: SESSION, store })
    expect(bare.githubEnabled).toBe(false)

    // The control: a repository and a client TOGETHER are what the capability
    // reports, so the degradation cannot fire on a configured daemon.
    const configured = createDirectApi({
      session: SESSION,
      store,
      github: throwingGithubClient(),
      repo: LOCAL_REPO_REF,
    })
    expect(configured.githubEnabled).toBe(true)

    // And the bare api degrades exactly as the client-only harness above does,
    // so the degradation keys on the capability rather than on which half of it
    // a test happened to omit.
    const res = await handleDirectApi(req('GET', ROUTES.getRateLimit.path), SESSION, bare)
    expect(res?.status).toBe(501)
    const body = (await res?.json()) as { code: string; message: string }
    expect(body.code).toBe('not_implemented')
    expect(/no GitHub repository/i.test(body.message)).toBe(true)
    store.close()
  })
})
