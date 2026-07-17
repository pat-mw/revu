import type { DevState } from './devtools'
import { store } from './store'

/**
 * Simulated transport latency. Each profile defines a jittered range per
 * operation class; the active profile is read from dev state on every call,
 * so flipping the dev panel takes effect immediately.
 *
 * Profiles (milliseconds):
 * - zero       0 everywhere — instant iteration.
 * - fast       40–120 for everything.
 * - realistic  150–450 reads/writes; the sync burst totals 900–2200.
 * - slow       900–2600 for everything.
 */

export type LatencyOp = 'read' | 'write' | 'sync'

const PROFILES: Record<DevState['latency'], Record<LatencyOp, [number, number]>> = {
  zero: { read: [0, 0], write: [0, 0], sync: [0, 0] },
  fast: { read: [40, 120], write: [40, 120], sync: [40, 120] },
  realistic: { read: [150, 450], write: [150, 450], sync: [900, 2200] },
  slow: { read: [900, 2600], write: [900, 2600], sync: [900, 2600] },
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Network-shaped wait for one operation, per the current dev latency profile. */
export function delay(op: LatencyOp): Promise<void> {
  const [min, max] = PROFILES[store.getDev().latency][op]
  return sleep(min + Math.random() * (max - min))
}

/**
 * Local-cache reads (snapshots, blobs, cached threads, drafts, viewed state)
 * cost a short fixed 10–30ms regardless of the network profile — they never
 * touch the network. The zero profile drops even that, for instant iteration.
 */
export function localDelay(): Promise<void> {
  if (store.getDev().latency === 'zero') return Promise.resolve()
  return sleep(10 + Math.random() * 20)
}
