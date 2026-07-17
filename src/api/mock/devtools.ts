import type { Human, RateLimitInfo } from '@/api/types'
import type { FixtureDB } from '@/fixtures/contract'
import { fixtureDB } from '@/fixtures'
import { store } from './store'

/**
 * Dev-panel controls for the mock transport: who is driving the workspace,
 * how slow the simulated network is, and which operations fail. Settings
 * persist in the broker store (same localStorage document as drafts and
 * snapshots) so a reload keeps the panel's configuration.
 *
 * Consumers subscribe by listening for `DEV_EVENT` on `window`; every setter
 * dispatches it after persisting, so state hooks can re-read `mockDev.get()`.
 */

export interface DevState {
  /** Coder identity currently driving the workspace. */
  humanId: string
  /** Simulated network profile applied by `latency.ts`. */
  latency: 'zero' | 'fast' | 'realistic' | 'slow'
  /**
   * Which operations fail: 'writes' fails broker writes, 'sync' fails the
   * sync burst, 'all' additionally fails remote reads. Local-cache reads
   * (snapshots, blobs, cached threads, drafts, viewed state) never fail —
   * that is the offline-first contract.
   */
  failureMode: 'none' | 'writes' | 'sync' | 'all'
}

/** Dispatched on `window` whenever any dev setting changes or the store resets. */
export const DEV_EVENT = 'revu:dev'

const db = fixtureDB as FixtureDB

function announce(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DEV_EVENT))
  }
}

export const mockDev = {
  get(): DevState {
    return store.getDev()
  },

  setHuman(id: string): void {
    store.patchDev({ humanId: id })
    announce()
  },

  setLatency(m: DevState['latency']): void {
    store.patchDev({ latency: m })
    announce()
  },

  setFailureMode(m: DevState['failureMode']): void {
    store.patchDev({ failureMode: m })
    announce()
  },

  /** Everyone who can drive this workspace's shared bot identity. */
  listHumans(): Human[] {
    return db.humans.map((h) => ({ ...h }))
  },

  /** Clears persisted broker state and re-seeds from fixtures. */
  reset(): void {
    store.reset()
    announce()
  },

  /** Current simulated shared-bucket status. */
  getRate(): RateLimitInfo {
    return store.rateInfo()
  },
}
