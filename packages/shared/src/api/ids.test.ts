/**
 * The disjointness argument for the reserved local id bands, written as
 * executable assertions rather than prose.
 *
 * Local reviews reuse the existing positive-integer review identity, so the
 * only thing keeping a local id from colliding with a real GitHub PR number,
 * a GitHub comment/review id, the mock adapter's minted-entity band, or the
 * app's optimistic synthetic ids is the arithmetic pinned here. Each fact
 * below is one of those separations.
 *
 * Two of the facts concern constants owned by other packages. `@revu/shared`
 * is a dependency-free leaf and cannot import them, so asserting them here
 * against copied literals would pin the copy rather than the constant — the
 * precise drift these tests exist to prevent. The mock's band is therefore
 * asserted against its real exported value in the app package
 * (`packages/app/src/api/mock/id-bands.test.ts`), and the optimistic-id fact
 * is stated here as a property of sign (no negative number is in any band),
 * which holds for every value that generator can ever produce.
 */
import { describe, expect, it } from 'bun:test'
import { LOCAL_ENTITY_ID_BASE, LOCAL_REVIEW_ID_BASE, isLocalReviewId } from './ids'

/**
 * The largest PR number GitHub plausibly reaches. Six digits is already an
 * order of magnitude past the busiest public repository, and the band sits
 * three orders of magnitude above it.
 */
const MAX_PLAUSIBLE_PR_NUMBER = 999_999

/**
 * Observed range of GitHub comment / review ids: they are global, monotonic,
 * and were in the low billions when the bands were chosen.
 */
const GITHUB_ENTITY_ID_LOW = 1_000_000_000
const GITHUB_ENTITY_ID_HIGH = 3_000_000_000

/** The mock adapter's own minted-entity base, copied — see the file docstring. */
const MOCK_ID_BASE_LITERAL = 700_000_000

describe('isLocalReviewId', () => {
  it('rejects review numbers below the band', () => {
    expect(isLocalReviewId(415)).toBe(false)
    expect(isLocalReviewId(1)).toBe(false)
    expect(isLocalReviewId(MAX_PLAUSIBLE_PR_NUMBER)).toBe(false)
    expect(isLocalReviewId(LOCAL_REVIEW_ID_BASE - 1)).toBe(false)
  })

  it('accepts the band floor and everything above it', () => {
    expect(isLocalReviewId(LOCAL_REVIEW_ID_BASE)).toBe(true)
    expect(isLocalReviewId(1_000_000_001)).toBe(true)
  })

  it('rejects an id minted in the mock adapter band', () => {
    expect(isLocalReviewId(700_000_042)).toBe(false)
  })

  it('rejects zero and negatives', () => {
    expect(isLocalReviewId(-1)).toBe(false)
    expect(isLocalReviewId(0)).toBe(false)
  })

  /**
   * The integer half of the predicate. A `>=`-only implementation passes every
   * assertion above, so these are the cases that distinguish it — and they are
   * not academic: a number parsed out of a URL or JSON is not necessarily an
   * integer, and a non-integer review id would hash to its own React Query
   * cache entry while addressing nothing.
   */
  it('rejects non-integers, including ones inside the numeric band', () => {
    expect(isLocalReviewId(1_000_000_000.5)).toBe(false)
    expect(isLocalReviewId(414.5)).toBe(false)
    expect(isLocalReviewId(Number.NaN)).toBe(false)
    expect(isLocalReviewId(Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('band disjointness', () => {
  it('puts every plausible GitHub PR number below the review band', () => {
    for (const n of [1, 415, 12_345, MAX_PLAUSIBLE_PR_NUMBER]) {
      expect(n).toBeLessThan(LOCAL_REVIEW_ID_BASE)
      expect(isLocalReviewId(n)).toBe(false)
    }
  })

  it('puts GitHub comment and review ids below the local entity band', () => {
    expect(GITHUB_ENTITY_ID_HIGH).toBeLessThan(LOCAL_ENTITY_ID_BASE)
    for (const n of [GITHUB_ENTITY_ID_LOW, 2_147_483_647, GITHUB_ENTITY_ID_HIGH]) {
      expect(n).toBeLessThan(LOCAL_ENTITY_ID_BASE)
    }
  })

  /**
   * The mock's band clears both local bands with room for the mock to mint for
   * as long as anyone will run it. Asserted here against a copied literal only
   * to record the intended relation; the assertion that actually fails when the
   * mock moves lives in the app package, against the imported constant.
   */
  it('puts the mock adapter band below both local bands', () => {
    expect(MOCK_ID_BASE_LITERAL).toBeLessThan(LOCAL_REVIEW_ID_BASE)
    expect(MOCK_ID_BASE_LITERAL).toBeLessThan(LOCAL_ENTITY_ID_BASE)
    expect(MOCK_ID_BASE_LITERAL + 100_000_000).toBeLessThan(LOCAL_REVIEW_ID_BASE)
  })

  /**
   * Optimistic entries in the UI carry strictly decreasing negative ids so a
   * synthetic comment can never collide with a server id. That separation is a
   * property of sign, not of a threshold, so it holds for every id that
   * generator can ever produce without this file knowing its counter.
   */
  it('puts every negative optimistic id below both bands', () => {
    for (const n of [-1, -2, -1_000, -Number.MAX_SAFE_INTEGER]) {
      expect(n).toBeLessThan(LOCAL_REVIEW_ID_BASE)
      expect(n).toBeLessThan(LOCAL_ENTITY_ID_BASE)
      expect(isLocalReviewId(n)).toBe(false)
    }
  })

  it('orders the two local bands', () => {
    expect(LOCAL_REVIEW_ID_BASE).toBeLessThan(LOCAL_ENTITY_ID_BASE)
  })
})

describe('safe-integer headroom', () => {
  it('keeps both bases exactly representable', () => {
    expect(Number.isSafeInteger(LOCAL_REVIEW_ID_BASE)).toBe(true)
    expect(Number.isSafeInteger(LOCAL_ENTITY_ID_BASE)).toBe(true)
  })

  /**
   * A million locally minted entities is far past any plausible amount of
   * review activity on one machine; the band still has three orders of
   * magnitude of headroom left before ids stop being exactly representable and
   * two distinct entities could compare equal.
   */
  it('leaves room for a plausible mint count above the entity band', () => {
    expect(LOCAL_ENTITY_ID_BASE + 1_000_000).toBeLessThan(Number.MAX_SAFE_INTEGER)
    expect(Number.isSafeInteger(LOCAL_ENTITY_ID_BASE + 1_000_000)).toBe(true)
  })
})

/**
 * The bands are NOT mutually exclusive by value: the entity band sits above the
 * review band, so a locally minted comment id satisfies `isLocalReviewId`, and
 * so does a real GitHub comment id. The predicate is namespace-scoped — it
 * answers "is this REVIEW id local?" and is meaningless applied to anything
 * else. Routing a comment id through it produces a wrong answer that reads like
 * data corruption rather than like a type error, which is why the trap is
 * pinned here instead of described in a comment alone.
 */
describe('namespace caveat', () => {
  it('answers true for entity ids, which is why it may only be applied to review ids', () => {
    expect(isLocalReviewId(LOCAL_ENTITY_ID_BASE)).toBe(true)
    expect(isLocalReviewId(LOCAL_ENTITY_ID_BASE + 42)).toBe(true)
  })

  it('answers true for a real GitHub comment id, which is not a review id either', () => {
    expect(isLocalReviewId(GITHUB_ENTITY_ID_HIGH)).toBe(true)
  })
})
