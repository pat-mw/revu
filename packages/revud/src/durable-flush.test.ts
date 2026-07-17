/**
 * The router's durability contract for mutating handlers, proven directly
 * against `handleApi` with an injected store whose persistence fails on
 * command.
 *
 * The store applies every mutation in memory and then flushes to disk before
 * the response is sent. When that flush THROWS (disk full, permissions,
 * read-only filesystem), the router must answer with the typed
 * `persist_failed` envelope (a 5xx) — never a 200 the client would trust as
 * saved — while the mutation itself stays readable in memory, so nothing the
 * user wrote is discarded and a later retry can persist it. The swallowing
 * `flush` remains reserved for the error path (where a flush failure must not
 * mask the original error); the mutating success path must use the throwing
 * variant.
 */
import { describe, expect, test } from 'bun:test'
import type { ReviewDraft, RevuApi } from '@revu/shared'
import type { MockBundle } from './mock-bridge'
import { handleApi } from './api-router'

interface StoreCalls {
  flush: number
  flushOrThrow: number
}

/**
 * A bundle whose `api` persists drafts in an in-memory map (the mock's
 * behavior in miniature) and whose store flush can be made to fail. Only the
 * draft methods are implemented; any other `RevuApi` access throws, proving
 * the draft routes touch nothing else.
 */
function makeBundle(opts: { failFlush: boolean }): { mock: MockBundle; calls: StoreCalls } {
  const calls: StoreCalls = { flush: 0, flushOrThrow: 0 }
  const drafts = new Map<number, ReviewDraft>()

  const implemented: Partial<RevuApi> = {
    saveDraft: (draft: ReviewDraft) => {
      drafts.set(draft.prNumber, draft)
      return Promise.resolve(draft)
    },
    getDraft: (prNumber: number) => Promise.resolve(drafts.get(prNumber) ?? null),
  }
  const api = new Proxy(implemented, {
    get(target, prop) {
      const method = target[prop as keyof RevuApi]
      if (method) return method
      throw new Error(`draft routes must not touch RevuApi.${String(prop)}`)
    },
  }) as RevuApi

  const mock: MockBundle = {
    api,
    dev: {
      get: () => ({ humanId: 'h-priya', latency: 'zero', failureMode: 'none' }),
      setHuman: () => {},
      setLatency: () => {},
      setFailureMode: () => {},
      listHumans: () => [],
      reset: () => {},
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
        // The swallowing variant swallows even here: a broken disk must not
        // turn the error path into a crash.
      },
      flushOrThrow() {
        calls.flushOrThrow += 1
        if (opts.failFlush) throw new Error('ENOSPC: no space left on device')
      },
    },
  }
  return { mock, calls }
}

function draftFor(prNumber: number, body: string): ReviewDraft {
  const at = new Date().toISOString()
  return {
    humanId: 'h-priya',
    prNumber,
    headSha: 'head-sha',
    compareKey: 'base...head-sha',
    body,
    event: 'COMMENT',
    comments: [],
    createdAt: at,
    updatedAt: at,
  }
}

function putDraft(prNumber: number, draft: ReviewDraft): Request {
  return new Request(`http://localhost/api/pulls/${prNumber}/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  })
}

describe('a failed disk flush surfaces as persist_failed, never a silent 200', () => {
  test('saveDraft answers 500 { code: persist_failed } and keeps the draft in memory', async () => {
    const { mock, calls } = makeBundle({ failFlush: true })
    const draft = draftFor(204, 'Text that must never be silently dropped.')

    const res = await handleApi(putDraft(204, draft), mock, 'mock')
    expect(res).not.toBeNull()
    expect(res?.status).toBe(500)
    const body = (await res?.json()) as { code: string; message: string }
    expect(body.code).toBe('persist_failed')
    expect(body.message).toContain('ENOSPC')
    expect(body.message.length).toBeGreaterThan(0)
    // The throwing flush ran on the mutating path; the error-path flush is the
    // swallowing one and must not have replaced it.
    expect(calls.flushOrThrow).toBe(1)
    expect(calls.flush).toBe(1)

    // The write was applied in memory before the flush failed: the draft is
    // still readable in full — surfaced error, retained text.
    const read = await handleApi(
      new Request('http://localhost/api/pulls/204/draft'),
      mock,
      'mock',
    )
    expect(read?.status).toBe(200)
    const kept = (await read?.json()) as ReviewDraft | null
    expect(kept?.body).toBe('Text that must never be silently dropped.')
  })

  test('the same save with a healthy disk is an ordinary 200 (happy path unchanged)', async () => {
    const { mock, calls } = makeBundle({ failFlush: false })
    const draft = draftFor(204, 'A perfectly persistable draft.')

    const res = await handleApi(putDraft(204, draft), mock, 'mock')
    expect(res?.status).toBe(200)
    const saved = (await res?.json()) as ReviewDraft
    expect(saved.body).toBe('A perfectly persistable draft.')
    expect(calls.flushOrThrow).toBe(1)
    // No error occurred, so the swallowing error-path flush never ran.
    expect(calls.flush).toBe(0)
  })
})
