/**
 * The dev-route mode gate, proven DIRECTLY against the router with an injected
 * mode — not via boot-time env validation, which would hide a router that
 * ignores the mode.
 *
 * The dev-panel routes (`GET/PUT /api/dev`, `POST /api/dev/reset`) let any
 * unauthenticated caller pick the acting human, toggle fault injection, and
 * wipe every human's drafts. They are a mock-only convenience: in any other
 * mode they must not exist at all. This suite constructs `handleApi` and the
 * full fetch handler with a NON-mock mode and asserts the routes 404 without
 * touching the dev controls, then asserts mock mode still serves them exactly
 * as before.
 *
 * The `MockBundle` here is a hand-built stub that records every dev-control
 * invocation; the `api` member is a throwing proxy, proving the dev paths never
 * reach the `RevuApi` surface in either mode.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Human, RevuApi } from '@revu/shared'
import type { DevStateShape, MockBundle } from './mock-bridge'
import { handleApi } from './api-router'
import { createFetchHandler } from './server'

interface DevCalls {
  setHuman: string[]
  setLatency: string[]
  setFailureMode: string[]
  reset: number
  flush: number
  flushOrThrow: number
}

const STUB_HUMANS: Human[] = [
  { id: 'h-priya', name: 'Priya', role: 'contractor', email: 'priya@example.com' },
]

/** A stub bundle whose dev controls record every call; `api` throws on any use. */
function makeStubMock(): { mock: MockBundle; calls: DevCalls } {
  const calls: DevCalls = {
    setHuman: [],
    setLatency: [],
    setFailureMode: [],
    reset: 0,
    flush: 0,
    flushOrThrow: 0,
  }
  const state: DevStateShape = { humanId: 'h-priya', latency: 'zero', failureMode: 'none' }
  const api = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`dev routes must never touch RevuApi (accessed .${String(prop)})`)
      },
    },
  ) as unknown as RevuApi
  const mock: MockBundle = {
    api,
    dev: {
      get: () => ({ ...state }),
      setHuman(id) {
        calls.setHuman.push(id)
        state.humanId = id
      },
      setLatency(m) {
        calls.setLatency.push(m)
        state.latency = m
      },
      setFailureMode(m) {
        calls.setFailureMode.push(m)
        state.failureMode = m
      },
      listHumans: () => STUB_HUMANS,
      reset() {
        calls.reset += 1
      },
      getRate: () => ({
        limit: 5000,
        remaining: 5000,
        used: 0,
        reset: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    },
    store: {
      flush() {
        calls.flush += 1
      },
      flushOrThrow() {
        calls.flushOrThrow += 1
      },
    },
  }
  return { mock, calls }
}

function devRequest(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body !== undefined
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  })
}

describe('dev routes are unreachable outside mock mode', () => {
  const nonMockModes = ['broker', 'direct'] as const

  for (const mode of nonMockModes) {
    test(`${mode}: GET /api/dev is a 404 and reads no dev state`, async () => {
      const { mock, calls } = makeStubMock()
      const res = await handleApi(devRequest('GET', '/api/dev'), mock, mode)
      expect(res).not.toBeNull()
      expect(res?.status).toBe(404)
      const body = (await res?.json()) as { code: string }
      expect(body.code).toBe('not_found')
      expect(calls.flush).toBe(0)
    })

    test(`${mode}: PUT /api/dev cannot change the acting human or fault injection`, async () => {
      const { mock, calls } = makeStubMock()
      const res = await handleApi(
        devRequest('PUT', '/api/dev', {
          humanId: 'h-attacker',
          latency: 'slow',
          failureMode: 'all',
        }),
        mock,
        mode,
      )
      expect(res?.status).toBe(404)
      expect(calls.setHuman).toEqual([])
      expect(calls.setLatency).toEqual([])
      expect(calls.setFailureMode).toEqual([])
      expect(calls.flush).toBe(0)
      expect(mock.dev.get().humanId).toBe('h-priya')
    })

    test(`${mode}: POST /api/dev/reset cannot wipe the store`, async () => {
      const { mock, calls } = makeStubMock()
      const res = await handleApi(devRequest('POST', '/api/dev/reset'), mock, mode)
      expect(res?.status).toBe(404)
      expect(calls.reset).toBe(0)
      expect(calls.flush).toBe(0)
    })
  }

  test('broker: the full fetch handler 404s the dev routes end to end', async () => {
    // Through createFetchHandler (static serving + SPA fallback in place), the
    // dev paths are API paths, so they must yield the router's JSON 404 — never
    // the SPA fallback, and never a dev-control invocation.
    const distDir = mkdtempSync(join(tmpdir(), 'revud-devgate-dist-'))
    try {
      writeFileSync(join(distDir, 'index.html'), '<!doctype html><html></html>', 'utf8')
      const { mock, calls } = makeStubMock()
      const fetchHandler = createFetchHandler(distDir, mock, 'broker')

      for (const req of [
        devRequest('GET', '/api/dev'),
        devRequest('PUT', '/api/dev', { humanId: 'h-attacker' }),
        devRequest('POST', '/api/dev/reset'),
      ]) {
        const res = await fetchHandler(req)
        expect(res.status).toBe(404)
        const body = (await res.json()) as { code: string }
        expect(body.code).toBe('not_found')
      }
      expect(calls.setHuman).toEqual([])
      expect(calls.reset).toBe(0)
      expect(calls.flush).toBe(0)
    } finally {
      rmSync(distDir, { recursive: true, force: true })
    }
  })
})

describe('dev routes still work in mock mode', () => {
  test('GET /api/dev returns dev state, humans, and rate', async () => {
    const { mock } = makeStubMock()
    const res = await handleApi(devRequest('GET', '/api/dev'), mock, 'mock')
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as {
      dev: DevStateShape
      humans: Human[]
      rate: { remaining: number }
    }
    expect(body.dev.humanId).toBe('h-priya')
    expect(body.humans).toHaveLength(1)
    expect(body.rate.remaining).toBe(5000)
  })

  test('PUT /api/dev patches human, latency, and failure mode, then flushes', async () => {
    const { mock, calls } = makeStubMock()
    const res = await handleApi(
      devRequest('PUT', '/api/dev', { humanId: 'h-sam', latency: 'fast', failureMode: 'sync' }),
      mock,
      'mock',
    )
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as { dev: DevStateShape }
    expect(body.dev).toEqual({ humanId: 'h-sam', latency: 'fast', failureMode: 'sync' })
    expect(calls.setHuman).toEqual(['h-sam'])
    expect(calls.setLatency).toEqual(['fast'])
    expect(calls.setFailureMode).toEqual(['sync'])
    expect(calls.flush).toBe(1)
  })

  test('POST /api/dev/reset reseeds and flushes', async () => {
    const { mock, calls } = makeStubMock()
    const res = await handleApi(devRequest('POST', '/api/dev/reset'), mock, 'mock')
    expect(res?.status).toBe(200)
    expect(calls.reset).toBe(1)
    expect(calls.flush).toBe(1)
  })
})
