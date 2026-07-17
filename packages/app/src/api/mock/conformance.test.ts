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
import { runConformanceSuite } from '@revu/shared/conformance'
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
      // Persist the whole broker document, then rebuild the adapter. The store
      // singleton survives the rebuild, so a saved draft is still readable —
      // the in-process analogue of the daemon reloading from disk.
      store.flush()
      return createMockApi()
    },
  })
})
