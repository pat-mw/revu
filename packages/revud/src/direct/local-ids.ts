/**
 * Names for the things a local review creates: the numeric id of a comment or a
 * submitted review summary, and the string id of a materialized thread.
 *
 * THIS MODULE HOLDS NO STATE. It has no counter, no cached high-water mark and
 * no storage of any kind, and that is a requirement rather than an
 * implementation detail. Numeric ids have to keep rising across restarts of the
 * daemon, so the high-water mark has to be durable, so it has to live where
 * durable things live — read and bumped inside one transaction by the store that
 * owns it. A counter here would be a second opinion about the same number: it
 * would restart at zero on every boot, hand out ids the store had already
 * issued, and the collision would surface much later as one comment quietly
 * standing in for another. The allocator is therefore injected on every call and
 * this module is a pure function of what it answers.
 *
 * What is left once the counting is somebody else's is the part worth having in
 * one place: the BAND ARGUMENT. A locally minted numeric id shares an integer
 * namespace with three other populations, and has to be disjoint from all of
 * them.
 *
 *   - The ids a remote forge assigns. Those were observed in the low billions
 *     and are global and monotonic, so the separation has to clear a range
 *     rather than a value.
 *   - The ids the in-browser mock adapter mints for its own fixtures, which sit
 *     in their own reserved band well below this one.
 *   - The NEGATIVE ids the client mints optimistically, before a write has
 *     landed, for the entry it draws immediately and then swaps for the real one
 *     by id. This is the separation that fails loudest: a minted id colliding
 *     with an optimistic one orphans the entry it was meant to replace, and the
 *     reviewer watches their own comment appear twice.
 *
 * All three are cleared by one floor, because the reserved local band sits above
 * every one of those populations — which is exactly why the allocator's answer
 * is CHECKED here rather than trusted. The allocator is injected, so the wrong
 * one can be wired in: a store whose counter row was never seeded answers from
 * zero, and a fixture allocator answers from the mock adapter's band. Neither
 * mistake is visible at the point it is made. Checking at the mint turns both
 * into a loud failure naming the offending value, at the moment the bad id is
 * produced rather than at the moment something downstream trips over it.
 *
 * Monotonicity is deliberately NOT checked here, and the reason is the same one
 * that keeps the counter out: comparing an id against the previous one would
 * require remembering the previous one. That property belongs to the allocator
 * and is asserted against the durable allocator, over a real restart, where it
 * actually means something.
 *
 * Thread ids are strings, and their shape is not a free choice: the in-browser
 * mock adapter is the specification every transport conforms to, and it already
 * mints them. The shape is a marker, the owning review's id and the root
 * comment's id joined by colons. Two properties of it are load-bearing rather
 * than cosmetic. It contains no path separator, because a thread id travels as a
 * single URL path segment and a separator inside one turns a path into a longer
 * path that matches no route. And it is visibly unlike a forge-assigned id, so
 * one that strays into a forge-bound code path is recognizable at a glance
 * instead of being taken for a real remote object.
 *
 * Failures here are plain errors rather than the product's typed API errors, and
 * that is deliberate: every one of them means a caller was assembled wrongly, not
 * that a reviewer asked for something that cannot be done. Dressing a wiring
 * defect up in a product error code would put a false explanation in front of
 * someone who cannot act on it.
 */
import { LOCAL_ENTITY_ID_BASE } from '@revu/shared'

/**
 * Whether a value can name something without ambiguity. Integrality is the real
 * requirement: two distinct values above the safe-integer ceiling can compare
 * equal and render identically, so ids drawn from up there would silently
 * collapse two entities onto one name.
 */
function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Take the next id for a locally created comment or review summary from the
 * injected allocator, refusing anything outside the reserved local band.
 *
 * The allocator is called exactly once and its answer is returned unchanged, so
 * the sequence a caller sees is the allocator's own sequence and nothing else.
 */
export function mintLocalEntityId(nextEntityId: () => number): number {
  const id = nextEntityId()
  if (!isSafeNonNegativeInteger(id) || id < LOCAL_ENTITY_ID_BASE) {
    throw new Error(
      `revud: the injected local entity id allocator answered ${id}, which is not a safe ` +
        `integer at or above the reserved local entity band floor of ${LOCAL_ENTITY_ID_BASE}. ` +
        `Minting it would risk colliding with an id assigned elsewhere, or with the negative ` +
        `ids the client reserves for the entries it draws before a write lands.`,
    )
  }
  return id
}

/**
 * The id of a locally materialized review thread, in the shape the mock adapter
 * mints.
 *
 * Both parts are required to be safe non-negative integers, which the adapter's
 * own composition does not check. That is the one intentional difference, and it
 * is additive: every input either side can legitimately produce passes it, and
 * the values it rejects are ones neither could name a thread with anyway. It
 * exists because uniqueness — one id per review-and-root-comment pair — is a
 * property of the composition only while the two numbers render distinctly, and
 * above the safe-integer ceiling they stop doing so.
 */
export function mintLocalThreadId(localReviewId: number, rootCommentId: number): string {
  if (!isSafeNonNegativeInteger(localReviewId) || !isSafeNonNegativeInteger(rootCommentId)) {
    throw new Error(
      `revud: a local thread id needs a safe non-negative integer review id and root comment ` +
        `id, and was given ${localReviewId} and ${rootCommentId}. Anything else renders into a ` +
        `name that two different threads could share.`,
    )
  }
  return `local:${localReviewId}:${rootCommentId}`
}
