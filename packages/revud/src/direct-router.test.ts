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
  ReviewDraft,
  Session,
  Snapshot,
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

  test('a not-yet-built route (threads, review, rate-limit) is a 501 not_implemented', async () => {
    for (const [method, path] of [
      ['GET', '/api/pulls'],
      ['GET', '/api/pulls/204/threads'],
      ['POST', '/api/pulls/204/review'],
      ['GET', '/api/rate-limit'],
    ] as const) {
      const res = await handleDirectApi(req(method, path), SESSION, fakeApi())
      expect(res?.status).toBe(501)
      const body = (await res?.json()) as { code: string }
      expect(body.code).toBe('not_implemented')
    }
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
