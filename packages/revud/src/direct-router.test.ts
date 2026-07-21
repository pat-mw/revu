/**
 * The direct-mode `/api/*` router. `getSession` returns the real session; sync/
 * snapshot/draft/viewed/preferences dispatch to the injected read/persist
 * surface; every not-yet-built contract route answers a typed `not_implemented`
 * (501); unknown paths 404; non-API paths return null so the caller serves
 * static assets. No mock, no dev panel, no network — the surface here is a fake.
 */
import { describe, expect, test } from 'bun:test'
import type {
  FileBlob,
  FileViewedState,
  HumanPreferences,
  RateLimitInfo,
  ReactionRollup,
  ReconcileReport,
  ReviewComment,
  ReviewDraft,
  ReviewThread,
  Session,
  Snapshot,
  SubmitResult,
} from '@revu/shared'
import { ApiError, DEFAULT_PREFERENCES } from '@revu/shared'
import type { DirectApi } from './direct/direct-api'
import { StoreWriteError } from './direct/store'
import { handleDirectApi } from './direct-router'

const SESSION: Session = {
  human: { id: 'alice@x.io', name: 'Alice', role: 'contractor', email: 'alice@x.io' },
  // Direct mode has no broker bot; the empty string is the "no bot" sentinel.
  brokerLogin: '',
  workspace: 'direct-acme-revu',
  viewerLogin: 'alice-gh',
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

  test('a not-yet-built route (list, threads) is a 501 not_implemented', async () => {
    for (const [method, path] of [
      ['GET', '/api/pulls'],
      ['GET', '/api/pulls/204/threads'],
    ] as const) {
      const res = await handleDirectApi(req(method, path), SESSION, fakeApi())
      expect(res?.status).toBe(501)
      const body = (await res?.json()) as { code: string }
      expect(body.code).toBe('not_implemented')
    }
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
