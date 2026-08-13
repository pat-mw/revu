/**
 * The route table and the `RevuApi` surface are one bijection, asserted.
 *
 * `ROUTES` claims in its own docstring that "every `RevuApi` method maps to
 * exactly one route, keyed by method name", and nothing enforces it: `satisfies
 * Record<string, Route>` checks the SHAPE of each entry, never the key set, so a
 * route keyed by a name no adapter implements — or a method with no route —
 * compiles clean and fails only at run time, on the one call that needs it.
 *
 * Two properties are pinned here.
 *
 * 1. **Bijection.** `Object.keys(ROUTES)` is exactly the set of function-valued
 *    keys on BOTH implementations of the interface — the in-browser mock and the
 *    fetch adapter. They are the only two, and a widening of `RevuApi` that
 *    reaches one but not the other leaves the app's two transports serving
 *    different contracts.
 *
 * 2. **Additive-only.** Every pre-existing `method + path` pair is pinned as a
 *    literal below. Editing a path (a renamed segment, a changed verb) or
 *    deleting an entry fails this file; that turns "the route table only ever
 *    grows" from a review habit into an assertion. A new route is legal and
 *    passes — the bijection above still forces both adapters to carry its method
 *    — and its pair belongs in the table so the next change is pinned too.
 *
 * Neither property is about behaviour, so nothing here calls a route. Whether a
 * request actually REACHES its own handler is a separate, runtime property of
 * the daemon's matcher and is asserted on the daemon side.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { ROUTES } from '@revu/shared'
import { createHttpApi } from '@/api/http/adapter'
import { createMockApi } from '@/api/mock/adapter'
import { mockDev } from '@/api/mock/devtools'

/**
 * The `method + path` of every route, pinned literally. An entry may be ADDED
 * (and should be added here in the same change); an entry may never be edited or
 * removed.
 */
const PINNED_ROUTES: Record<string, string> = {
  getSession: 'GET /api/session',
  listPulls: 'GET /api/pulls',
  syncPull: 'POST /api/pulls/:n/sync',
  getSnapshot: 'GET /api/pulls/:n/snapshot',
  getBlob: 'GET /api/blobs/:sha',
  listReviewThreads: 'GET /api/pulls/:n/threads',
  replyToThread: 'POST /api/pulls/:n/threads/:threadId/reply',
  resolveThread: 'POST /api/pulls/:n/threads/:threadId/resolve',
  addReaction: 'POST /api/comments/:id/reactions',
  submitReview: 'POST /api/pulls/:n/review',
  reconcileDraft: 'GET /api/pulls/:n/reconcile',
  getDraft: 'GET /api/pulls/:n/draft',
  saveDraft: 'PUT /api/pulls/:n/draft',
  discardDraft: 'DELETE /api/pulls/:n/draft',
  getFileViewed: 'GET /api/pulls/:n/viewed',
  setFileViewed: 'PUT /api/pulls/:n/viewed',
  getPreferences: 'GET /api/preferences',
  setPreferences: 'PUT /api/preferences',
  getRateLimit: 'GET /api/rate-limit',
}

/** The method names an object actually implements, sorted for comparison. */
function functionKeys(impl: object): string[] {
  return Object.keys(impl)
    .filter((key) => typeof (impl as Record<string, unknown>)[key] === 'function')
    .sort()
}

const routeNames = Object.keys(ROUTES).sort()

beforeAll(() => {
  // Constructing the mock adapter pulls in the mock store, which hydrates from
  // the one process-wide localStorage-backed document every `bun test` file
  // shares. Resetting to the pristine fixture seed keeps this file from
  // inheriting — or leaking — another file's mutations.
  mockDev.reset()
})

describe('every route maps to exactly one method on every RevuApi implementation', () => {
  test('the mock adapter implements exactly the routed method set', () => {
    expect(functionKeys(createMockApi())).toEqual(routeNames)
  })

  test('the fetch adapter implements exactly the routed method set', () => {
    expect(functionKeys(createHttpApi('http://x'))).toEqual(routeNames)
  })
})

describe('the route table is additive-only', () => {
  test('every pinned route still has its exact method and path', () => {
    const table = ROUTES as Record<string, { method: string; path: string }>
    const actual: Record<string, string> = {}
    for (const name of Object.keys(PINNED_ROUTES)) {
      const route = table[name]
      // An absent route would read as `undefined undefined`, which no pinned
      // value matches — a deletion fails here rather than silently skipping.
      actual[name] = route === undefined ? 'MISSING' : `${route.method} ${route.path}`
    }
    expect(actual).toEqual(PINNED_ROUTES)
  })

  test('the table never shrinks below its pinned entries', () => {
    // Guards the assertion above against being neutered by deleting a pin
    // alongside the route it pins.
    expect(Object.keys(ROUTES).length).toBeGreaterThanOrEqual(
      Object.keys(PINNED_ROUTES).length,
    )
  })
})
