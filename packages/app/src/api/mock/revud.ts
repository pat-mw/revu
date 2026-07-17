/**
 * The mock's public surface for a durable host (the revu daemon). It re-exports
 * exactly what a server needs to serve the `RevuApi` contract over HTTP without
 * duplicating any mock logic: the adapter factory, the dev-panel controls, and
 * the store's public `flush` for on-shutdown durability.
 *
 * The browser app does NOT import this barrel — it keeps using the adapter and
 * devtools directly. This exists so the daemon can reuse the same modules
 * through the app package's `exports`, keeping the mock the single semantics
 * oracle rather than a second copy.
 */
export { createMockApi } from './adapter'
export { mockDev } from './devtools'
export type { DevState } from './devtools'
export { store } from './store'
