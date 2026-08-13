/**
 * Every route in the shared table reaches its OWN handler — a runtime property
 * no type check can see.
 *
 * `matchRoute` walks `ROUTES` in insertion order and matches by segment count
 * with `:param` matching any segment. So a route whose method, segment count and
 * literal prefix coincide with an EARLIER entry is silently swallowed by it:
 * requests meant for the later route are dispatched to the earlier handler and
 * the later handler is dead code. The switch's exhaustiveness guard proves a
 * handler EXISTS for every route name; it cannot prove any request ever arrives
 * there, and `tsc` sees nothing wrong with a shadowed table.
 *
 * This sweep drives one request per route through `handleApi` against a
 * recording proxy standing in for the `RevuApi` surface, and asserts that each
 * request records a call to the method OF ITS OWN NAME. A shadowed route records
 * the shadowing route's method instead, which fails and names both. What must
 * never appear is the unknown-path `No route for` envelope — and because that is
 * an assertion about an ABSENCE, an unknown path is swept alongside as the
 * positive control that proves the envelope is still reachable and the tripwire
 * is armed.
 *
 * Routes whose handler validates a request body before touching `api` are given
 * a VALID body, so every route is held to the same, stronger bar: it reached its
 * own `api` method, not merely its own validator. A route added to the table
 * therefore needs its body here, or the sweep reports it as unreached.
 *
 * Nothing here starts a daemon or loads the mock store: the `api`, dev controls
 * and store are stubs, so this file needs no built `dist` and cannot leak into
 * the process-wide mock document that other suites share.
 */
import { describe, expect, test } from 'bun:test'
import type { RevuApi, RouteName } from '@revu/shared'
import { ROUTES, fillPath } from '@revu/shared'
import type { MockBundle, MockDev } from './mock-bridge'
import { handleApi } from './api-router'

/** Path params covering every parameter name the table is allowed to use. */
const SWEEP_PARAMS = { n: 101, sha: 'a'.repeat(40), threadId: 'PRRT_stub', id: 7 } as const

/**
 * Request bodies for the handlers that validate before dispatching. Each is
 * VALID for its own route: a body that failed validation would 400 before the
 * `api` call this sweep measures, and could not distinguish "reached its own
 * validator" from "reached a validator at all".
 */
const REQUEST_BODIES: Partial<Record<RouteName, unknown>> = {
  replyToThread: { body: 'a reply' },
  resolveThread: { resolved: true },
  // The path carries only the comment id; the owning pull rides in the body
  // (the fetch adapter sends it as `?pr=`, which the handler also accepts).
  addReaction: { reaction: '+1', prNumber: SWEEP_PARAMS.n },
  submitReview: {
    prNumber: SWEEP_PARAMS.n,
    expectedHeadSha: 'b'.repeat(40),
    event: 'COMMENT',
    body: 'looks good',
    comments: [],
  },
  saveDraft: {
    humanId: 'sweep@example.com',
    prNumber: SWEEP_PARAMS.n,
    headSha: 'b'.repeat(40),
    compareKey: `${'c'.repeat(40)}...${'b'.repeat(40)}`,
    body: '',
    event: 'COMMENT',
    comments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  setFileViewed: { path: 'src/a.ts', viewed: true, blobSha: null },
  setPreferences: {},
}

/**
 * Canned return values for the handlers that read something off the result.
 * Everything else is answered with `null`, which serializes fine.
 */
const RESULTS: Partial<Record<RouteName, unknown>> = {
  listPulls: {
    items: [],
    etag: 'W/"sweep"',
    notModified: false,
    rateLimit: { limit: 5000, remaining: 5000, used: 0, reset: '2026-01-01T00:00:00.000Z' },
  },
}

interface RecordingMock {
  mock: MockBundle
  /** Every `RevuApi` member the router touched, in order. */
  calls: string[]
}

/**
 * A bundle whose `api` records each member the router reaches and answers with a
 * canned value. The dev controls throw on any access: the sweep drives contract
 * routes only, and must never fall into the mock-only dev surface.
 */
function makeRecordingMock(): RecordingMock {
  const calls: string[] = []
  const api = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined
        calls.push(prop)
        return () => Promise.resolve(RESULTS[prop as RouteName] ?? null)
      },
    },
  ) as unknown as RevuApi
  const dev = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`contract routes must never touch the dev controls (.${String(prop)})`)
      },
    },
  ) as unknown as MockDev
  return {
    calls,
    mock: {
      api,
      dev,
      store: {
        flush() {},
        flushOrThrow() {},
      },
    },
  }
}

function sweepRequest(name: RouteName): Request {
  const route = ROUTES[name]
  const path = fillPath(route.path, SWEEP_PARAMS)
  const body = REQUEST_BODIES[name]
  return new Request(`http://localhost${path}`, {
    method: route.method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  })
}

describe('mock-mode dispatch reaches every route', () => {
  for (const name of Object.keys(ROUTES) as RouteName[]) {
    test(`${ROUTES[name].method} ${ROUTES[name].path} dispatches to ${name}`, async () => {
      const { mock, calls } = makeRecordingMock()
      const res = await handleApi(sweepRequest(name), mock, 'mock')

      expect(res).not.toBeNull()
      const text = await (res as Response).text()
      // The unknown-path envelope means the request matched nothing at all.
      expect(text).not.toContain('No route for')
      // The whole point: its OWN handler, not a route that shadows it. A
      // mismatch prints the shadowing route's method name.
      expect(calls).toEqual([name])
      // No handler answers a 4xx once its `api` call has been made, so a status
      // here that is not 200 means the body never got past a validator.
      expect((res as Response).status).toBe(200)
    })
  }

  test('the table never shrinks below the routes swept above', () => {
    // Without this, deleting every entry from `ROUTES` would leave a file of
    // zero tests that passes.
    expect(Object.keys(ROUTES).length).toBeGreaterThanOrEqual(19)
  })

  test('an unknown path still produces the No route for envelope', async () => {
    // The positive control for the absence asserted above: the envelope this
    // sweep forbids is still reachable, so a green sweep means the requests
    // matched their routes, not that the envelope stopped being emitted.
    const { mock, calls } = makeRecordingMock()
    const res = await handleApi(
      new Request('http://localhost/api/pulls/101/definitely-not-a-route'),
      mock,
      'mock',
    )
    expect(res?.status).toBe(404)
    expect(await (res as Response).text()).toContain('No route for')
    expect(calls).toEqual([])
  })
})
