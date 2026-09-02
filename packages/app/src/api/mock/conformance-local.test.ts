/**
 * Conformance runner: drives the shared LOCAL-REVIEW conformance block — the
 * whole loop over a branch pair with no pull request behind it — against the
 * IN-PROCESS mock adapter. The assertions themselves live in
 * `@revu/shared/conformance` and are run identically against every other
 * transport by its own runner, so all of them are held to the same contract
 * from one source of truth.
 *
 * The mock store is a single localStorage-backed document shared across every
 * `bun test` file in the process, so this runner resets it in `beforeAll` to a
 * pristine fixture seed, drops simulated latency to zero and disables the
 * failure injector — otherwise a mutation from another file (or a debounced
 * flush of one) could leak in and derail the walk.
 *
 * Two config values are worth their reasons:
 *
 * - The branch pair is one nothing else in this workspace reviews. Creation is
 *   idempotent per pair, so a pair shared with another suite would hand this
 *   walk that suite's review — already synced, already carrying threads — and
 *   the "nothing synced yet" and "gained exactly one thread" assertions would
 *   be measuring the wrong review.
 * - The compare is declared EMPTY because nothing git-shaped stands behind this
 *   store: a runtime-created branch pair has no objects to diff, so the honest
 *   snapshot is the legal empty compare (merge base == head, no files, no
 *   blobs, no commits) and a comment anchors wherever it says it does.
 *
 * The restart hook models the mock's durability guarantee: flush the broker
 * document, then hand back a freshly built adapter over the same persisted
 * store — the same survival the app relies on across a page reload or a
 * workspace rebuild.
 */
import { beforeAll, describe } from 'bun:test'
import { runLocalReviewConformanceSuite } from '@revu/shared/conformance'
import { createMockApi } from '@/api/mock/adapter'
import { mockDev } from '@/api/mock/devtools'
import { store } from '@/api/mock/store'

describe('mock adapter local review conformance', () => {
  beforeAll(() => {
    mockDev.reset()
    mockDev.setLatency('zero')
    mockDev.setFailureMode('none')
  })

  runLocalReviewConformanceSuite({
    label: 'in-process mock',
    makeApi: () => createMockApi(),
    // Read after the reset above, which is what settles who the session is.
    humanId: () => mockDev.get().humanId,
    pair: { baseRef: 'main', headRef: 'feature/local-review-conformance' },
    anchor: { path: 'src/index.ts', line: 12, lineText: 'const x = compute()' },
    compare: 'empty',
    restart: () => {
      // Persist the whole broker document, re-read it from storage, then
      // rebuild the adapter: a saved draft is readable afterwards only if the
      // write reached `localStorage` — the in-process analogue of the daemon
      // reloading from disk, rather than a second handle over the same memory.
      store.flush()
      store.reload()
      return createMockApi()
    },
  })
})
