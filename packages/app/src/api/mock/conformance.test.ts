/**
 * Conformance runner: drives the shared `RevuApi` conformance suite against the
 * IN-PROCESS mock adapter. The assertions themselves live in
 * `@revu/shared/conformance` and are run identically against revud over HTTP by
 * a sibling runner, so both transports are held to the same contract from one
 * source of truth.
 *
 * The mock store is a single localStorage-backed document shared across every
 * `bun test` file in the process, so this runner resets it in `beforeAll` to a
 * pristine fixture seed and drops simulated latency to zero — otherwise a mock
 * mutation from another file (or a debounced flush of one) could leak in and
 * derail the scenario walk. The restart hook models the mock's durability
 * guarantee: flush the broker document, then hand back a freshly built adapter
 * over the same persisted store — the same survival the app relies on across a
 * page reload or a workspace rebuild.
 */
import { beforeAll, describe } from 'bun:test'
import {
  expectPartialSyncThrows,
  runConformanceSuite,
  runLocalReviewDeleteConformance,
} from '@revu/shared/conformance'
import { createMockApi } from '@/api/mock/adapter'
import { mockDev } from '@/api/mock/devtools'
import { store } from '@/api/mock/store'

describe('mock adapter conformance', () => {
  beforeAll(() => {
    mockDev.reset()
    mockDev.setLatency('zero')
    mockDev.setFailureMode('none')
  })

  runConformanceSuite({
    label: 'in-process mock',
    makeApi: () => createMockApi(),
    scenarios: {
      baseline: 101,
      seededDraft: 312,
      baseAdvanced: 410,
      mutableDrift: 415,
      partialSync: 401,
      reconcile: 389,
    },
    restart: () => {
      // Persist the whole broker document, re-read it from storage, then
      // rebuild the adapter: a saved draft is readable afterwards only if the
      // write reached `localStorage` — the in-process analogue of the daemon
      // reloading from disk, rather than a second handle over the same memory.
      store.flush()
      store.reload()
      return createMockApi()
    },
    // The mock owns the simulated drop, so it writes the partial snapshot and
    // then raises the drop as a `network` ApiError — the same shape the app's
    // error copy renders. A transport that instead resolves with the partial is
    // equally conformant, which is why this expectation is per-runner.
    partialSyncSurfacing: expectPartialSyncThrows('network'),
  })

  runLocalReviewDeleteConformance({
    label: 'in-process mock',
    makeApi: () => createMockApi(),
    // Read after the reset above, which is what settles who the session is.
    humanId: () => mockDev.get().humanId,
    // Any syntactically valid pair will do here: nothing git-shaped stands
    // behind this store, so the review's compare is the empty one and a
    // comment anchors wherever it says it does.
    pair: { baseRef: 'main', headRef: 'feature/delete-conformance' },
    anchor: { path: 'src/index.ts', line: 12, lineText: 'const x = compute()' },
    // The storage witness, read off the store document itself rather than
    // through the adapter under test. Drafts are counted across EVERY human,
    // because the delete's precondition spans every human's draft.
    rowsOf: (id) => {
      const record = store.getLocalReview(id)
      return {
        review: record ? 1 : 0,
        snapshot: store.getSnapshot(id) ? 1 : 0,
        threads: record?.threads.length ?? 0,
        submitted: record?.submitted.length ?? 0,
        drafts: store.listDraftsFor(id).length,
        viewed: Object.keys(store.getViewed(mockDev.get().humanId, id)).length,
      }
    },
  })
})
