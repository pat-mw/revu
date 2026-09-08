/**
 * The `RevuApi` conformance suite: a transport-agnostic entry point for runners
 * that drive a concrete adapter. Import `runConformanceSuite` from here in a
 * `*.test.ts` where the adapter is reachable, hand it a factory + scenario map +
 * restart hook, and the shared assertions run against that implementation.
 *
 * A runner may also declare how ITS transport surfaces a sync that dies
 * mid-transfer, using one of the `expectPartialSync*` builders. That is the one
 * assertion the contract leaves to the transport; everything else is shared.
 *
 * `runLocalReviewDeleteConformance` is the block for deleting a local review.
 * It is registered separately because it needs a branch pair the
 * implementation can review rather than a fixture pull number, so a runner
 * whose implementation serves local reviews adds it beside the main suite.
 */
export {
  expectPartialSyncResolves,
  expectPartialSyncSurfacedSomehow,
  expectPartialSyncThrows,
  runConformanceSuite,
} from './suite.ts'
export type {
  ConformanceConfig,
  ConformanceScenarios,
  PartialSyncOutcome,
  PartialSyncSurfacing,
} from './suite.ts'
export { runLocalReviewDeleteConformance } from './local-delete.ts'
export type {
  Lazy,
  LocalDeleteAnchor,
  LocalDeleteApi,
  LocalDeleteConformanceConfig,
  LocalDeletePair,
  LocalReviewRowCounts,
} from './local-delete.ts'
