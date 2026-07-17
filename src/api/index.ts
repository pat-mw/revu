import type { RevuApi } from './client'
import { createMockApi } from './mock/adapter'

/**
 * The single place transport is chosen. A real implementation would be
 * `createBrokerApi()` from `./broker/adapter` — same interface, nothing else
 * in the app changes.
 */
export const api: RevuApi = createMockApi()

export type { RevuApi } from './client'
