/**
 * The half of the id-band disjointness argument that spans two packages.
 *
 * `@revu/shared` is a dependency-free leaf: it declares the reserved local
 * bands but cannot import the mock adapter's own minting base, so its tests can
 * only pin a copy of that number. This file closes the gap by importing the
 * real constant, so raising the mock's band into a local one fails here instead
 * of silently making every mock-minted id answer `true` to `isLocalReviewId`
 * and be routed as a local review.
 *
 * These are pure arithmetic assertions on module constants; the store is a
 * process-wide singleton, but nothing here reads or mutates its state.
 */
import { describe, expect, it } from 'bun:test'
import { LOCAL_ENTITY_ID_BASE, LOCAL_REVIEW_ID_BASE, isLocalReviewId } from '@revu/shared'
import { ID_BASE } from './store'

describe('the mock band clears both local bands', () => {
  it('sits below the local review band', () => {
    expect(ID_BASE).toBeLessThan(LOCAL_REVIEW_ID_BASE)
  })

  it('sits below the local entity band', () => {
    expect(ID_BASE).toBeLessThan(LOCAL_ENTITY_ID_BASE)
  })

  /**
   * The mock mints by incrementing from its base, so the guarantee has to cover
   * the whole reachable range, not just the floor. A hundred million ids is far
   * more than any browser session accumulates.
   */
  it('leaves the whole reachable mock range below the local review band', () => {
    expect(ID_BASE + 100_000_000).toBeLessThan(LOCAL_REVIEW_ID_BASE)
  })

  it('mints ids that are never mistaken for local review ids', () => {
    for (const offset of [1, 42, 1_000, 100_000_000]) {
      expect(isLocalReviewId(ID_BASE + offset)).toBe(false)
    }
  })

  /** Mock ids are positive, so they also clear the optimistic negative space. */
  it('mints positive ids', () => {
    expect(ID_BASE).toBeGreaterThan(0)
  })
})
