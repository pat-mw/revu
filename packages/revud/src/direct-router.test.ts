/**
 * The direct-mode `/api/*` router. `getSession` returns the real session; every
 * other contract route answers a typed `not_implemented` (501) rather than
 * fabricating data or crashing; unknown paths 404; non-API paths return null so
 * the caller serves static assets. No mock, no dev panel, no network.
 */
import { describe, expect, test } from 'bun:test'
import type { Session } from '@revu/shared'
import { handleDirectApi } from './direct-router'

const SESSION: Session = {
  human: { id: 'alice@x.io', name: 'Alice', role: 'contractor', email: 'alice@x.io' },
  // Direct mode has no broker bot; the empty string is the "no bot" sentinel.
  brokerLogin: '',
  workspace: 'direct-acme-revu',
  viewerLogin: 'alice-gh',
}

function req(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method })
}

describe('handleDirectApi', () => {
  test('GET /api/session returns the real session', async () => {
    const res = handleDirectApi(req('GET', '/api/session'), SESSION)
    expect(res).not.toBeNull()
    expect(res?.status).toBe(200)
    const body = (await res?.json()) as Session
    expect(body.human.id).toBe('alice@x.io')
    expect(body.viewerLogin).toBe('alice-gh')
  })

  test('a known but unimplemented route is a 501 not_implemented, not a crash', async () => {
    for (const [method, path] of [
      ['GET', '/api/pulls'],
      ['POST', '/api/pulls/204/sync'],
      ['GET', '/api/pulls/204/snapshot'],
      ['PUT', '/api/pulls/204/draft'],
      ['GET', '/api/rate-limit'],
    ] as const) {
      const res = handleDirectApi(req(method, path), SESSION)
      expect(res?.status).toBe(501)
      const body = (await res?.json()) as { code: string }
      expect(body.code).toBe('not_implemented')
    }
  })

  test('an unknown API path is a 404 not_found', async () => {
    const res = handleDirectApi(req('GET', '/api/does-not-exist'), SESSION)
    expect(res?.status).toBe(404)
    const body = (await res?.json()) as { code: string }
    expect(body.code).toBe('not_found')
  })

  test('a bare /api is treated as an API path (404), not static fallthrough', async () => {
    const res = handleDirectApi(req('GET', '/api'), SESSION)
    expect(res?.status).toBe(404)
  })

  test('a non-API path returns null so the caller serves static assets', () => {
    expect(handleDirectApi(req('GET', '/'), SESSION)).toBeNull()
    expect(handleDirectApi(req('GET', '/pulls/204/files'), SESSION)).toBeNull()
  })

  test('the dev panel does not exist in direct mode', async () => {
    // /api/dev is never a contract route, so it is an ordinary unknown API 404.
    const res = handleDirectApi(req('GET', '/api/dev'), SESSION)
    expect(res?.status).toBe(404)
  })
})
