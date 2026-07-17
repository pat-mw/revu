import type { RevuApi } from '@revu/shared'
import { createMockApi } from './mock/adapter'
import { createHttpApi } from './http/adapter'

/**
 * The single transport decision, factored out so `api` and `devControls` cannot
 * disagree about which mode they are in. Two inputs drive it:
 *
 * - `base` — the configured daemon URL (`VITE_REVU_API`). When set, HTTP mode.
 * - `forceMock` — the `?mock=1` escape hatch. The in-browser mock is the
 *   permanent oracle and the demo mode: `?mock=1` ALWAYS wins, so a build
 *   pointed at a daemon can still drop into the pure, HTTP-free mock on demand.
 */

/**
 * Whether the pure in-browser mock is forced via `?mock=1`. Guarded for SSR /
 * non-browser contexts where `window` is absent (returns `false`).
 */
export function forceMockFromLocation(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('mock') === '1'
}

/**
 * Pure transport selection. `forceMock` short-circuits to the mock before `base`
 * is ever consulted, so the mock stays HTTP-free under `?mock=1` even when a
 * daemon URL is configured. Otherwise a configured `base` selects HTTP; an
 * absent one falls back to the mock.
 */
export function selectApi(base: string | undefined, forceMock: boolean): RevuApi {
  if (forceMock) return createMockApi()
  if (base !== undefined && base.length > 0) return createHttpApi(base)
  return createMockApi()
}

/** The configured daemon base URL, or `undefined` when unset. */
export function configuredBase(): string | undefined {
  const base = import.meta.env.VITE_REVU_API
  return base !== undefined && base.length > 0 ? base : undefined
}
