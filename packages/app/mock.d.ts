/**
 * The type surface a durable host (the revu daemon) sees for the `@revu/app/mock`
 * barrel. Referenced by the app package's `exports["./mock"].types`, so a
 * CONSUMER's `tsc` reads THIS instead of the barrel's source — the consumer
 * never type-checks app internals (fixtures, adapter/store logic), only the
 * shared contract shapes. The runtime `./src/api/mock/revud.ts` provides the
 * actual values. It lives outside `src/` so the app's own `tsc` build (which
 * includes `src`) does not compile it alongside the source barrel.
 */
import type { Human, RateLimitInfo, RevuApi } from '@revu/shared'

export declare function createMockApi(): RevuApi

export interface DevState {
  humanId: string
  latency: 'zero' | 'fast' | 'realistic' | 'slow'
  failureMode: 'none' | 'writes' | 'sync' | 'all'
}

export declare const mockDev: {
  get(): DevState
  setHuman(id: string): void
  setLatency(m: DevState['latency']): void
  setFailureMode(m: DevState['failureMode']): void
  listHumans(): Human[]
  reset(): void
  getRate(): RateLimitInfo
}

export declare const store: {
  /** Persist synchronously, swallowing a storage-write failure (browser semantics). */
  flush(): void
  /**
   * Persist synchronously, propagating a storage-write failure. A durable host
   * uses this after mutations so a failed disk write surfaces as an error
   * instead of a silent success; in-memory state survives the failure.
   */
  flushOrThrow(): void
}
