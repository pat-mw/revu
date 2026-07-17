/**
 * The `RevuApi` conformance suite: a transport-agnostic entry point for runners
 * that drive a concrete adapter. Import `runConformanceSuite` from here in a
 * `*.test.ts` where the adapter is reachable, hand it a factory + scenario map +
 * restart hook, and the shared assertions run against that implementation.
 */
export { runConformanceSuite } from './suite.ts'
export type { ConformanceConfig, ConformanceScenarios } from './suite.ts'
