import type { Human, RateLimitInfo } from '@revu/shared'
import { mockDev, DEV_EVENT } from './mock/devtools'
import type { DevState } from './mock/devtools'
import { configuredBase, forceMockFromLocation } from './select'

/**
 * Mode-neutral dev controls for the demo panel and the human switchers. The
 * dev panel and identity menus must behave identically in both transport modes;
 * the difference is only WHERE the mock state lives:
 *
 * - Mock mode (`?mock=1`, or no daemon configured): the mock store lives in the
 *   browser, so `mockDev` is wrapped directly. `mockDev`'s setters already
 *   dispatch `DEV_EVENT`, so behavior is byte-for-byte identical to today.
 * - HTTP mode: the mock lives inside `revud`, so controls route through
 *   `/api/dev` (`GET` to read, `PUT` to patch, `POST /api/dev/reset`). After
 *   every mutation this dispatches `DEV_EVENT` on `window` itself, exactly as
 *   the mock path does — so `SessionProvider` clears the query cache and
 *   refetches the session, and the dev panel re-reads its state.
 *
 * The mode decision is SHARED with `./index`'s `api` selection (same
 * `configuredBase` + `forceMockFromLocation`), so `api` and `devControls` can
 * never end up in different modes.
 */

/** The full dev snapshot the panel renders from: state, rate budget, and roster. */
export interface DevSnapshot {
  dev: DevState
  rate: RateLimitInfo
  humans: Human[]
}

/**
 * The async surface both modes implement. Every mutation resolves once the
 * change is applied AND `DEV_EVENT` has been dispatched, so an `await`ing caller
 * can trust that subscribers have been signaled.
 */
export interface DevControls {
  /**
   * The current dev snapshot, or `null` when the transport exposes no dev
   * surface at all. Only the in-browser mock and a mock-backed daemon carry
   * one; a daemon talking to real GitHub deliberately serves no dev routes, and
   * `null` is the honest answer there rather than a snapshot of blanks.
   */
  get(): Promise<DevSnapshot | null>
  setHuman(id: string): Promise<void>
  setLatency(m: DevState['latency']): Promise<void>
  setFailureMode(m: DevState['failureMode']): Promise<void>
  reset(): Promise<void>
}

function announce(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DEV_EVENT))
  }
}

/** Wrap the synchronous in-browser `mockDev` as the async `DevControls` surface. */
function mockControls(): DevControls {
  return {
    get(): Promise<DevSnapshot> {
      return Promise.resolve({
        dev: mockDev.get(),
        rate: mockDev.getRate(),
        humans: mockDev.listHumans(),
      })
    },
    setHuman(id: string): Promise<void> {
      // mockDev.* setters already dispatch DEV_EVENT — do not double-fire.
      mockDev.setHuman(id)
      return Promise.resolve()
    },
    setLatency(m: DevState['latency']): Promise<void> {
      mockDev.setLatency(m)
      return Promise.resolve()
    },
    setFailureMode(m: DevState['failureMode']): Promise<void> {
      mockDev.setFailureMode(m)
      return Promise.resolve()
    },
    reset(): Promise<void> {
      mockDev.reset()
      return Promise.resolve()
    },
  }
}

/** The `/api/dev` response envelope: DevState plus the roster and rate budget. */
interface DevWire {
  dev: DevState
  humans: Human[]
  rate: RateLimitInfo
}

/** Route dev controls through the daemon's `/api/dev` surface. */
function httpControls(base: string): DevControls {
  const root = base.replace(/\/+$/, '')

  async function readDev(): Promise<DevSnapshot | null> {
    const res = await fetch(`${root}/api/dev`)
    // The dev routes exist only while the daemon is serving the mock store; in
    // every other mode they are absent by design, because they would let any
    // caller choose the acting human. A refusal answers with a JSON error body,
    // which parses cleanly — so the status, not the parse, is what decides.
    // Reading the body regardless would yield a snapshot of `undefined` fields
    // that every consumer would then dereference.
    if (!res.ok) {
      await res.body?.cancel()
      return null
    }
    const wire = (await res.json()) as DevWire
    return { dev: wire.dev, rate: wire.rate, humans: wire.humans }
  }

  async function patch(body: Partial<DevState>): Promise<void> {
    const res = await fetch(`${root}/api/dev`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
    await res.body?.cancel()
    // The daemon mutated its own mock store; signal local subscribers so the
    // cache clears and the session refetches, mirroring the mock path.
    announce()
  }

  return {
    get: readDev,
    setHuman(id: string): Promise<void> {
      return patch({ humanId: id })
    },
    setLatency(m: DevState['latency']): Promise<void> {
      return patch({ latency: m })
    },
    setFailureMode(m: DevState['failureMode']): Promise<void> {
      return patch({ failureMode: m })
    },
    async reset(): Promise<void> {
      const res = await fetch(`${root}/api/dev/reset`, { method: 'POST' })
      await res.body?.cancel()
      announce()
    },
  }
}

function pickControls(): DevControls {
  if (forceMockFromLocation()) return mockControls()
  const base = configuredBase()
  return base !== undefined ? httpControls(base) : mockControls()
}

/**
 * The one mode-neutral place components import dev controls from. Decided once
 * at startup, in lockstep with the `api` transport selection.
 */
export const devControls: DevControls = pickControls()

export { DEV_EVENT }
export type { DevState }
