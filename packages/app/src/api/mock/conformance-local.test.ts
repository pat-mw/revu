/**
 * Conformance runner: drives the shared LOCAL-REVIEW conformance blocks — the
 * whole loop over a branch pair with no pull request behind it, and what
 * happens once a pull request covers one — against the IN-PROCESS mock
 * adapter. The assertions themselves live in `@revu/shared/conformance` and are
 * run identically against every other transport by its own runner, so all of
 * them are held to the same contract from one source of truth.
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
 *
 * ## The archive block's own pair
 *
 * This store IS its own stand-in for GitHub: the pull requests a local review
 * is compared against are its fixture pull requests, so a pull request "appears"
 * for a pair by that pair already being one a fixture covers. So the archive
 * block's `appear` is a no-op and its pair is a covered one — `main ←
 * feat/gateway-rate-limiting`, which fixture pull request 312 covers — while
 * the suite above keeps a pair nothing covers, so its review stays live for the
 * whole of its own walk.
 *
 * A consequence worth naming: on this transport the FIRST sync of a covered
 * pair is the one that archives it. There is no window in which such a review
 * is synced and live, which is why the shared block writes its pre-archive
 * draft against an unsynced head rather than a synced one.
 */
import { beforeAll, describe } from 'bun:test'
import {
  runLocalReviewArchiveConformance,
  runLocalReviewConformanceSuite,
} from '@revu/shared/conformance'
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

  runLocalReviewArchiveConformance({
    label: 'in-process mock',
    makeApi: () => createMockApi(),
    humanId: () => mockDev.get().humanId,
    superseded: {
      // Fixture pull request 312 is open over exactly this pair, so the pull
      // request is already there the moment the review is created.
      pair: { baseRef: 'main', headRef: 'feat/gateway-rate-limiting' },
      prNumber: 312,
      appear: () => {},
    },
    // Every adapter over this store reads the same module-level document, so a
    // handle built per call is the current one by construction.
    listPulls: (etag) =>
      createMockApi().listPulls(etag === null ? undefined : { etag }),
    restart: () => {
      store.flush()
      store.reload()
      return createMockApi()
    },
  })
})
