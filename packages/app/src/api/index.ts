import type { RevuApi } from '@revu/shared'
import { configuredBase, forceMockFromLocation, selectApi } from './select'

/**
 * The single place transport is chosen, at startup. `createHttpApi(base)` when
 * `VITE_REVU_API` is set, otherwise the pure in-browser `createMockApi()`.
 *
 * `?mock=1` forces the mock even when a daemon URL is configured: the mock is
 * the permanent oracle and the demo mode, so it must always be reachable and
 * must never touch HTTP. See `selectApi` for the pure, unit-testable decision.
 */
export const api: RevuApi = selectApi(configuredBase(), forceMockFromLocation())

export type { RevuApi } from '@revu/shared'
