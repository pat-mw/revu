/**
 * Public surface of the shared contract: the GitHub- and broker-shaped types,
 * the `RevuApi` transport interface, the pure re-anchoring helpers, and the
 * identity-smuggling helpers. Both the frontend and the future daemon import
 * everything they need from this single entry point.
 */
export * from './api/types'
export * from './api/client'
export * from './lib/anchor'
export * from './lib/identity'
