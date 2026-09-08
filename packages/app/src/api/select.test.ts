/**
 * The headless import seam, and the transport decision that rides on it.
 *
 * `@/api` chooses its transport at MODULE SCOPE — `selectApi(configuredBase(),
 * forceMockFromLocation())` runs on the first import of the module, not on the
 * first call — and `forceMockFromLocation` reads `window.location.search`. The
 * headless test runtime has no DOM, so the test preload installs the browser
 * globals that decision touches, `location` among them. Without that one shim,
 * every module that transitively imports `@/api` — the query layer, the pages,
 * and the command palette alike — throws while it is still being evaluated,
 * and is therefore unimportable from a test at all.
 *
 * Two properties are pinned here.
 *
 * 1. **The seam holds.** The module imports below are STATIC on purpose. A
 *    module that fails to evaluate fails this file at LOAD, before a single
 *    assertion runs — which is exactly what dropping the shim would do. That
 *    makes this file the guard that stops a tidy-up of the preload from
 *    silently disabling every test that renders or queries.
 *
 * 2. **The shim did not move the transport decision.** The shimmed location
 *    carries an EMPTY query string, so `forceMockFromLocation()` answers
 *    `false` and selection lands exactly where a browser with no `?mock=1`
 *    lands. A shim that grew a `?mock=1` by accident would quietly run every
 *    HTTP-mode test against the pure in-browser mock, passing for the wrong
 *    reason; it fails here instead.
 *
 * "Selection picked the mock" is proved by the absence of network traffic,
 * which is worthless evidence unless the detector can fire — so the network
 * tripwire carries a positive control in the same test: the transport that
 * DOES use the network is driven through the armed stub first.
 */
import { afterEach, expect, test } from 'bun:test'

import { api } from '@/api'
import { qk } from '@/state/queries'
import { InboxPage } from '@/pages/inbox'
import { CommandPalette } from '@/components/palette'
import { configuredBase, forceMockFromLocation, selectApi } from '@/api/select'
import { createHttpApi } from '@/api/http/adapter'

// ————————————————————————————————————————————————————————————————
// The network tripwire
// ————————————————————————————————————————————————————————————————

const realFetch = globalThis.fetch

/** Every URL a transport tried to reach while the tripwire was armed. */
const attempted: string[] = []

/** Replace `fetch` with a stub that records the attempt and refuses to serve it. */
function armFetchTripwire(): void {
  attempted.length = 0
  globalThis.fetch = ((input: string | URL | Request): never => {
    attempted.push(String(input))
    throw new Error(`the selected transport reached the network: ${String(input)}`)
  }) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

// ————————————————————————————————————————————————————————————————
// 1. The seam holds
// ————————————————————————————————————————————————————————————————

test('the modules behind the transport decision evaluate headlessly', () => {
  // Reaching this line at all is most of the assertion: each import above had
  // to run its module body, and `@/api`'s body performs the location read.
  expect(typeof api.listPulls).toBe('function')
  expect(qk.pulls).toEqual(['pulls'])
  expect(typeof InboxPage).toBe('function')
  expect(typeof CommandPalette).toBe('function')
})

test('the shimmed location carries every field the app reads', () => {
  // Trimming the shim down to whichever field today's code happens to touch
  // breaks the next module that reads one of the others, at import time and
  // with an error that names the reader rather than the shim. Pin the shape.
  expect(typeof window.location.search).toBe('string')
  expect(typeof window.location.pathname).toBe('string')
  expect(typeof window.location.href).toBe('string')
  expect(typeof window.location.origin).toBe('string')
})

// ————————————————————————————————————————————————————————————————
// 2. The transport decision is where it was
// ————————————————————————————————————————————————————————————————

test('the shimmed query string forces nothing', () => {
  expect(window.location.search).toBe('')
  expect(forceMockFromLocation()).toBe(false)
})

test('no base and no force selects the mock, which never touches the network', async () => {
  armFetchTripwire()

  // Positive control. "Nothing called fetch" reads identically against a stub
  // that was never installed, so prove the stub is live by tripping it with
  // the transport that is defined by its network use.
  let httpReachedTheStub = false
  try {
    await createHttpApi('http://transport.invalid').listBranches()
  } catch {
    httpReachedTheStub = true
  }
  expect(httpReachedTheStub).toBe(true)
  expect(attempted).toEqual(['http://transport.invalid/api/branches'])

  attempted.length = 0
  const selected = selectApi(undefined, false)
  expect(Array.isArray(await selected.listBranches())).toBe(true)
  expect(attempted).toEqual([])
})

test('the headless run is the unconfigured one the decision assumes', () => {
  // The two assertions above describe the no-daemon path. If a daemon URL were
  // configured for this process they would still hold, but they would no
  // longer describe what `@/api` itself picked — so state the precondition.
  expect(configuredBase()).toBeUndefined()
})
