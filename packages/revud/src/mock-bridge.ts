import type { Human, RateLimitInfo, RevuApi } from '@revu/shared'

/**
 * The single seam onto the app's mock. revud REUSES the app's mock adapter as
 * the permanent semantics oracle rather than duplicating it: the adapter and
 * store logic live in `packages/app/src/api/mock` and are loaded here behind a
 * typed boundary. Duplicating them would let the two copies silently diverge.
 *
 * The mock modules are pulled in via a single dynamic `import()` of the app
 * package's `./mock` export (a thin barrel over the adapter, dev controls, and
 * store). Bun resolves that through normal workspace package resolution, and
 * the mock's own internal `@/` imports resolve against the app's tsconfig at
 * run time. Because the specifier is a package export whose types are declared
 * against `@revu/shared`, revud's `tsc -b` build never statically traverses app
 * internals — it depends only on the shared contract.
 *
 * `installDiskStorage()` MUST run before this loads: the store hydrates from
 * `localStorage` at module-load time, so the disk backend has to be in place
 * first for the daemon to start warm from disk.
 */

/** The dev-panel state shape, mirrored from the app's `mockDev`. */
export interface DevStateShape {
  humanId: string
  latency: 'zero' | 'fast' | 'realistic' | 'slow'
  failureMode: 'none' | 'writes' | 'sync' | 'all'
}

/** The subset of the mock's `mockDev` surface revud exposes over `/api/dev`. */
export interface MockDev {
  get(): DevStateShape
  setHuman(id: string): void
  setLatency(m: DevStateShape['latency']): void
  setFailureMode(m: DevStateShape['failureMode']): void
  listHumans(): Human[]
  reset(): void
  getRate(): RateLimitInfo
}

/** The durability levers the daemon needs from the store. */
export interface MockStore {
  /**
   * Persist synchronously, swallowing a storage-write failure. Browser
   * semantics — used only where a failure must not mask another error (the
   * router's error path, shutdown).
   */
  flush(): void
  /**
   * Persist synchronously, propagating a storage-write failure. The daemon's
   * `localStorage` is a disk file, so a swallowed failure would turn an
   * unpersisted mutation into a silent HTTP success; mutating handlers use
   * this variant and surface the throw as a typed error instead. In-memory
   * state survives the failure.
   */
  flushOrThrow(): void
}

/** The reused mock surface: the adapter, the dev controls, and the store flush. */
export interface MockBundle {
  api: RevuApi
  dev: MockDev
  store: MockStore
}

/**
 * Load the app's mock adapter, dev controls, and store. Dynamic specifiers
 * keep revud's composite build off app internals; the results are structurally
 * typed against the shared contract. Any failure to resolve the mock (module
 * resolution, alias, workspace layout) surfaces as a thrown import error rather
 * than a silent fallback to a duplicated implementation.
 */
export async function loadMock(): Promise<MockBundle> {
  const { createMockApi, mockDev, store } = await import('@revu/app/mock')
  return { api: createMockApi(), dev: mockDev, store }
}
