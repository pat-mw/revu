/**
 * Unit coverage for the HTTP adapter's pure logic — error mapping, the
 * `listPulls` 304 reconstruction, `?pr=` on `addReaction`, the three non-error
 * semantics, and abort propagation — with `fetch` stubbed so no daemon is
 * needed. The live adapter↔revud integration lives in `./integration.test.ts`.
 *
 * `selectApi` is unit-tested here too: it is the pure transport decision, and
 * `?mock=1` overriding a configured base is the load-bearing invariant.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ApiError } from '@revu/shared'
import type { PullListResponse, RateLimitInfo } from '@revu/shared'
import { createHttpApi } from './adapter'
import { selectApi } from '../select'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Install a stub `fetch` that returns whatever the handler produces. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  ) as unknown as typeof fetch
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value ?? null), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

const RATE: RateLimitInfo = { limit: 5000, remaining: 4999, used: 1, reset: '2026-01-01T00:00:00Z' }

const LIST: PullListResponse = {
  items: [],
  etag: 'W/"abc"',
  notModified: false,
  rateLimit: RATE,
}

describe('selectApi', () => {
  test('no base, no force → mock', () => {
    expect(selectApi(undefined, false)).toBeDefined()
  })

  test('base set → an HTTP adapter is returned (distinct instance)', () => {
    const http = selectApi('http://localhost:9999', false)
    const mockApi = selectApi(undefined, false)
    // Both satisfy RevuApi; the point is that a base produces a working adapter.
    expect(typeof http.getSession).toBe('function')
    expect(http).not.toBe(mockApi)
  })

  test('?mock=1 forces the mock even when a base is configured (no HTTP)', async () => {
    // If selectApi built an HTTP adapter, this stub would be hit; the mock never
    // calls fetch, so a throwing stub proves the mock path was taken.
    stubFetch(() => {
      throw new Error('the mock must not touch HTTP under ?mock=1')
    })
    const api = selectApi('http://localhost:9999', true)
    const session = await api.getSession()
    expect(session.human.id.length).toBeGreaterThan(0)
  })
})

describe('error mapping', () => {
  test('a { code, message } envelope on a 4xx becomes the typed ApiError', async () => {
    stubFetch(() => jsonResponse({ code: 'not_found', message: 'no such pull' }, 404))
    const api = createHttpApi('http://d')
    await expect(api.getSnapshot(1)).rejects.toMatchObject({
      code: 'not_found',
      message: 'no such pull',
    })
  })

  test('a rate_limited envelope carries resetAt through', async () => {
    stubFetch(() =>
      jsonResponse({ code: 'rate_limited', message: 'slow down', resetAt: '2026-02-02T00:00:00Z' }, 429),
    )
    const api = createHttpApi('http://d')
    const err = await api.getRateLimit().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('rate_limited')
    expect((err as ApiError).resetAt).toBe('2026-02-02T00:00:00Z')
  })

  test('an enveloped network code on a 5xx maps to ApiError(network)', async () => {
    stubFetch(() => jsonResponse({ code: 'network', message: 'connection dropped' }, 500))
    const api = createHttpApi('http://d')
    const err = await api.replyToThread(1, 't1', 'hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('network')
  })

  test('non-envelope error body (proxy HTML) degrades to broker_unreachable', async () => {
    stubFetch(
      () =>
        new Response('<html><body>502 Bad Gateway</body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    )
    const api = createHttpApi('http://d')
    const err = await api.getSession().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('broker_unreachable')
  })

  test('a rejected fetch (no response) maps to ApiError(network)', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const api = createHttpApi('http://d')
    const err = await api.getSession().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('network')
  })
})

describe('listPulls 304 reconstruction', () => {
  test('a 200 caches, then a 304 replays cached items and rateLimit', async () => {
    let calls = 0
    stubFetch((_url, init) => {
      calls++
      const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.['if-none-match']
      if (ifNoneMatch === LIST.etag) {
        // 304: no body, ETag echoed, no rate-limit headers (as revud emits it).
        return new Response(null, { status: 304, headers: { etag: LIST.etag } })
      }
      return jsonResponse(LIST, 200, { etag: LIST.etag })
    })
    const api = createHttpApi('http://d')

    const first = await api.listPulls()
    expect(first.notModified).toBe(false)
    expect(first.etag).toBe(LIST.etag)

    const second = await api.listPulls({ etag: first.etag })
    expect(second.notModified).toBe(true)
    expect(second.etag).toBe(LIST.etag)
    // Items and rateLimit are replayed from the cached 200 body.
    expect(second.items).toEqual(LIST.items)
    expect(second.rateLimit).toEqual(RATE)
    expect(calls).toBe(2)
  })

  test('a 304 before any 200 is a broker_unreachable (nothing to reconstruct)', async () => {
    stubFetch(() => new Response(null, { status: 304, headers: { etag: 'W/"x"' } }))
    const api = createHttpApi('http://d')
    const err = await api.listPulls({ etag: 'W/"x"' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('broker_unreachable')
  })
})

describe('addReaction sends ?pr', () => {
  test('the owning PR rides as a query param, not in the path', async () => {
    let seenUrl = ''
    stubFetch((url) => {
      seenUrl = url
      return jsonResponse({
        url: 'x',
        total_count: 1,
        '+1': 0,
        '-1': 0,
        laugh: 0,
        hooray: 0,
        confused: 0,
        heart: 0,
        rocket: 1,
        eyes: 0,
      })
    })
    const api = createHttpApi('http://d')
    await api.addReaction(204, 42, 'rocket')
    expect(seenUrl).toContain('/api/comments/42/reactions')
    expect(seenUrl).toContain('?pr=204')
  })
})

describe('the three non-error semantics never throw', () => {
  test('getSnapshot 200 null → null', async () => {
    stubFetch(() => jsonResponse(null))
    const api = createHttpApi('http://d')
    expect(await api.getSnapshot(101)).toBeNull()
  })

  test('submitReview 200 head_moved → the value', async () => {
    stubFetch(() =>
      jsonResponse({ status: 'head_moved', currentHeadSha: 'deadbeef', newCommits: 2 }),
    )
    const api = createHttpApi('http://d')
    const result = await api.submitReview({
      prNumber: 204,
      expectedHeadSha: 'stale',
      event: 'COMMENT',
      body: '',
      comments: [],
    })
    expect(result.status).toBe('head_moved')
  })
})

describe('abort propagation', () => {
  test('an aborted syncPull rejects (mock parity — never swallowed)', async () => {
    stubFetch((_url, init) => {
      // Model fetch honoring the signal: reject with an AbortError when aborted.
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'))
      }
      return jsonResponse(null)
    })
    const controller = new AbortController()
    controller.abort()
    const api = createHttpApi('http://d')
    const err = await api.syncPull(101, { signal: controller.signal }).catch((e: unknown) => e)
    // The aborted fetch rejects; the adapter surfaces it as a network ApiError
    // rather than resolving — matching the mock, which throws on abort.
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('network')
  })
})

describe('discardDraft tolerates the daemon body', () => {
  test('a { ok: true } body resolves void without throwing', async () => {
    stubFetch(() => jsonResponse({ ok: true }))
    const api = createHttpApi('http://d')
    await expect(api.discardDraft(204)).resolves.toBeUndefined()
  })

  test('an empty body also resolves', async () => {
    stubFetch(() => new Response(null, { status: 200 }))
    const api = createHttpApi('http://d')
    await expect(api.discardDraft(204)).resolves.toBeUndefined()
  })
})
