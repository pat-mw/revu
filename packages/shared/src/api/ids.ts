/**
 * Reserved numeric bands for locally created reviews and the entities inside
 * them.
 *
 * A local review is a review of a branch that has no pull request, so there is
 * no GitHub number to identify it by. Rather than widening review identity to a
 * string — which would touch every route, every integer gate, every `/pr/:n`
 * path parser and every React Query key — a local review takes a synthetic
 * positive integer from a band high enough that nothing else can reach it. Every
 * signature stays a `number`, and the only new knowledge in the system is where
 * the band starts.
 *
 * These constants live in the shared leaf so the frontend, the daemon and the
 * mock adapter cannot hold different opinions about the boundary. The full
 * disjointness argument — against real PR numbers, GitHub's entity ids, the
 * mock adapter's minting base and the UI's optimistic negative ids — is
 * asserted in `ids.test.ts` and, for the constants this package cannot import,
 * in `packages/app/src/api/mock/id-bands.test.ts`.
 */

/**
 * Review ids at or above this are local-only. Three orders of magnitude above
 * the largest plausible GitHub PR number, so no real pull request approaches
 * it.
 */
export const LOCAL_REVIEW_ID_BASE = 1_000_000_000

/**
 * Base for locally minted comment and review-summary ids. Disjoint from
 * GitHub's entity ids (observed in the low billions) and from the mock
 * adapter's own band, and far enough below `Number.MAX_SAFE_INTEGER` that no
 * plausible amount of minting reaches an inexactly representable id.
 *
 * Positive on purpose: negative ids are reserved for the optimistic entries the
 * UI mints before a write lands, and a locally minted id colliding with one
 * would orphan the optimistic entry it was meant to replace.
 */
export const LOCAL_ENTITY_ID_BASE = 9_000_000_000_000

/**
 * Whether a REVIEW id identifies a local review.
 *
 * Namespace-scoped, and that is not a formality: the entity band sits above the
 * review band, so a locally minted comment id — and a real GitHub comment id —
 * both satisfy this predicate. It answers a question about review identity
 * only, and applying it to any other kind of id yields a confidently wrong
 * answer. The integer check is as load-bearing as the threshold: a review id
 * that came from parsing text is not guaranteed to be one.
 */
export const isLocalReviewId = (n: number): boolean =>
  Number.isInteger(n) && n >= LOCAL_REVIEW_ID_BASE
