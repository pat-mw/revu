/**
 * The two kinds of name a local review hands out — the numeric id of a comment
 * or a submitted review summary, and the string id of a materialized thread —
 * and the properties each has to hold for the rest of the system to keep
 * working.
 *
 * The numeric half is a BAND argument. A locally minted id shares one integer
 * namespace with three other populations it must never collide with: the ids a
 * real forge assigns, the ids the in-browser mock adapter mints, and the
 * negative ids the client mints optimistically before a write lands and then
 * swaps by id. A collision in the last of those is the loud one — the
 * optimistic entry is orphaned and the reviewer watches their own comment
 * duplicate — and it is also the cheapest to prevent, because it is a property
 * of sign. The band assertions below sweep a long run of real mints against
 * every one of those separations at once.
 *
 * Not all six of those clauses are independently reachable, and this file says
 * which are not rather than presenting six checks as six checks. Three of them
 * are arithmetic consequences of one: the band floor sits above zero, above the
 * mock adapter's whole reachable range, and above the observed forge range, so
 * an id failing any of those three has already failed the floor clause and can
 * never be the sole cause of a red. They are kept in the sweep because the
 * subsumption is a property of today's constants rather than of the clauses,
 * and the three inequalities that establish it are themselves asserted, so
 * lowering the floor turns the subsumption red instead of silently making three
 * clauses matter again with nobody noticing.
 *
 * The string half is a CONFORMANCE argument, and it is the weaker of the two.
 * The mock adapter is the specification for thread-id shape, but its package
 * cannot be imported from here: its only export is the whole mock surface,
 * which installs a process-wide browser-storage stand-in that every suite
 * touching it has to reset, and taking an order-dependent dependency on that for
 * one string comparison is a bad trade. The shape is therefore pinned twice
 * over — by a predicate written out here, and by a golden thread id copied
 * verbatim out of the mock's own test file — so that a change to the shape on
 * EITHER side alone fails. What that does NOT cover is a change made to the mock
 * and to the golden fixture in the same commit: that is a deliberate move of the
 * contract, and catching it is a reviewer's job, not this file's.
 */
import { describe, expect, test } from 'bun:test'
import { LOCAL_ENTITY_ID_BASE, LOCAL_REVIEW_ID_BASE, ROUTES, fillPath } from '@revu/shared'
import { mintLocalEntityId, mintLocalThreadId } from './local-ids'
import { countingEntityIds } from './local-write-fakes'

// ————————————————————————————————————————————————————————————————
// The foreign populations the local entity band has to clear
// ————————————————————————————————————————————————————————————————

/**
 * The base the in-browser mock adapter mints its own entity ids from, and the
 * top of the range it can plausibly reach. Copied literals: the adapter lives in
 * the frontend package, which this one deliberately does not import, and the
 * assertion that fails when the adapter actually moves its base lives beside the
 * adapter where the real constant is in scope.
 */
const MOCK_ID_BASE = 700_000_000
const MOCK_BAND_TOP = MOCK_ID_BASE + 100_000_000

/**
 * The top of the range forge-assigned comment and review ids were observed in.
 * They are global and monotonic, so the guarantee has to be about a range rather
 * than about a single value.
 */
const FORGE_ENTITY_ID_HIGH = 3_000_000_000

// ————————————————————————————————————————————————————————————————
// The six band clauses, each separately reportable
// ————————————————————————————————————————————————————————————————

interface BandClause {
  readonly label: string
  /** Whether the clause holds over a whole minted sequence. */
  readonly holds: (ids: readonly number[]) => boolean
}

const POSITIVE = 'strictly positive'
const AT_OR_ABOVE_BAND = 'at or above the local entity band'
const SAFELY_INTEGRAL = 'safely integral'
const STRICTLY_INCREASING = 'strictly increasing'
const OUTSIDE_MOCK_BAND = 'outside the mock adapter band'
const ABOVE_FORGE_RANGE = 'above the observed forge entity id range'

const BAND_CLAUSES: readonly BandClause[] = [
  { label: POSITIVE, holds: (ids) => ids.every((id) => id > 0) },
  { label: AT_OR_ABOVE_BAND, holds: (ids) => ids.every((id) => id >= LOCAL_ENTITY_ID_BASE) },
  { label: SAFELY_INTEGRAL, holds: (ids) => ids.every((id) => Number.isSafeInteger(id)) },
  {
    label: STRICTLY_INCREASING,
    holds: (ids) => ids.every((id, index) => index === 0 || id > ids[index - 1]),
  },
  {
    label: OUTSIDE_MOCK_BAND,
    holds: (ids) => ids.every((id) => id < MOCK_ID_BASE || id > MOCK_BAND_TOP),
  },
  { label: ABOVE_FORGE_RANGE, holds: (ids) => ids.every((id) => id > FORGE_ENTITY_ID_HIGH) },
]

/** Every clause a sequence violates, by label, in declaration order. */
function clausesFailedBy(ids: readonly number[]): string[] {
  return BAND_CLAUSES.filter((clause) => !clause.holds(ids)).map((clause) => clause.label)
}

/**
 * Long enough that a sequence which drifts out of band, repeats, or loses
 * integral exactness only after a while is still caught, and short enough to
 * stay a fast assertion.
 */
const MINT_COUNT = 1000

describe('a long run of minted entity ids clears every band it has to', () => {
  test(`${MINT_COUNT} successive mints violate no clause`, () => {
    const next = countingEntityIds()
    const ids = Array.from({ length: MINT_COUNT }, () => mintLocalEntityId(next))
    // Every clause is a sweep, and every sweep is vacuously true over an empty
    // list — so the count is pinned first. Without it, a minter that returned
    // nothing at all would satisfy all six.
    expect(ids).toHaveLength(MINT_COUNT)
    expect(clausesFailedBy(ids)).toEqual([])
  })

  test('the mints are pairwise distinct, which strict increase is only one way to achieve', () => {
    const next = countingEntityIds()
    const ids = Array.from({ length: MINT_COUNT }, () => mintLocalEntityId(next))
    expect(new Set(ids).size).toBe(MINT_COUNT)
  })
})

// ————————————————————————————————————————————————————————————————
// Which of the six clauses can actually be the sole cause of a red
// ————————————————————————————————————————————————————————————————

describe('every band clause is proven able to fire, and three are proven unable to fire alone', () => {
  const B = LOCAL_ENTITY_ID_BASE

  /**
   * Fabricated sequences, each paired with the exact clause set it violates.
   * They are written out rather than produced by a minter: the point is to
   * exercise the clauses themselves, so a clause that stopped discriminating
   * fails here instead of quietly passing everything the real minter hands it.
   */
  const CLAUSE_FIXTURES: readonly (readonly [string, readonly number[], readonly string[]])[] = [
    ['a well-formed sequence at the band floor', [B, B + 1, B + 2], []],
    ['a sequence stuck at one value', [B, B, B], [STRICTLY_INCREASING]],
    ['a sequence running backwards', [B + 2, B + 1, B], [STRICTLY_INCREASING]],
    ['a sequence half a unit off the integers', [B + 0.5, B + 1.5, B + 2.5], [SAFELY_INTEGRAL]],
    [
      'a sequence in the empty gap between the forge range and the local band',
      [4_000_000_000, 4_000_000_001, 4_000_000_002],
      [AT_OR_ABOVE_BAND],
    ],
    ['a sequence counting up from one', [1, 2, 3], [AT_OR_ABOVE_BAND, ABOVE_FORGE_RANGE]],
    [
      'a sequence counting up from the mock adapter base',
      [MOCK_ID_BASE, MOCK_ID_BASE + 1, MOCK_ID_BASE + 2],
      [AT_OR_ABOVE_BAND, OUTSIDE_MOCK_BAND, ABOVE_FORGE_RANGE],
    ],
    [
      'a sequence counting up from the top of the forge range',
      [FORGE_ENTITY_ID_HIGH, FORGE_ENTITY_ID_HIGH + 1, FORGE_ENTITY_ID_HIGH + 2],
      [AT_OR_ABOVE_BAND, ABOVE_FORGE_RANGE],
    ],
    [
      'a rising sequence of negatives, the band the client mints optimistically in',
      [-3, -2, -1],
      [POSITIVE, AT_OR_ABOVE_BAND, ABOVE_FORGE_RANGE],
    ],
  ]

  for (const [name, ids, violated] of CLAUSE_FIXTURES) {
    test(`${name} violates exactly ${violated.length === 0 ? 'nothing' : violated.join(' + ')}`, () => {
      expect(clausesFailedBy(ids)).toEqual([...violated])
    })
  }

  /** The clauses some fixture above violates on its own, with nothing else red. */
  const SOLE_CAUSES = [
    ...new Set(
      CLAUSE_FIXTURES.filter(([, , violated]) => violated.length === 1).flatMap(
        ([, , violated]) => violated,
      ),
    ),
  ].sort()

  test('exactly three of the six clauses can be the sole cause of a red', () => {
    expect(SOLE_CAUSES).toEqual([AT_OR_ABOVE_BAND, SAFELY_INTEGRAL, STRICTLY_INCREASING].sort())
  })

  /**
   * The other three are subsumed, and these are the inequalities that make them
   * so — not an observation that no fixture happened to isolate them. Each is
   * live: moving the band floor below any of these boundaries would free the
   * corresponding clause to fire on its own, and would turn the assertion here
   * red rather than leaving a stale claim in a comment.
   */
  test('the band floor is above zero, so a non-positive id is always below the floor too', () => {
    expect(LOCAL_ENTITY_ID_BASE).toBeGreaterThan(0)
  })

  test('the band floor is above the mock adapter range, so an id in it is below the floor too', () => {
    expect(LOCAL_ENTITY_ID_BASE).toBeGreaterThan(MOCK_BAND_TOP)
  })

  test('the band floor is above the forge range, so an id in it is below the floor too', () => {
    expect(LOCAL_ENTITY_ID_BASE).toBeGreaterThan(FORGE_ENTITY_ID_HIGH)
  })
})

// ————————————————————————————————————————————————————————————————
// The minter refuses an allocator that would hand it a colliding id
// ————————————————————————————————————————————————————————————————

describe('an allocator answering outside the band is refused rather than minted', () => {
  test('an id from the mock adapter band is refused, naming the value', () => {
    expect(() => mintLocalEntityId(() => MOCK_ID_BASE + 42)).toThrow(/700000042/)
  })

  test('a non-positive id is refused', () => {
    expect(() => mintLocalEntityId(() => 0)).toThrow()
    expect(() => mintLocalEntityId(() => -1)).toThrow()
  })

  test('an id that is not safely integral is refused', () => {
    expect(() => mintLocalEntityId(() => LOCAL_ENTITY_ID_BASE + 0.5)).toThrow()
    expect(() => mintLocalEntityId(() => Number.NaN)).toThrow()
    expect(() => mintLocalEntityId(() => Number.POSITIVE_INFINITY)).toThrow()
    expect(() => mintLocalEntityId(() => Number.MAX_SAFE_INTEGER + 2)).toThrow()
  })

  /**
   * The positive control for the three refusals above: an allocator answering
   * inside the band is not refused, and the id that comes back is exactly the
   * one it issued. Without this, a minter that threw unconditionally would pass
   * every refusal assertion.
   */
  test('an allocator answering inside the band is minted through unchanged', () => {
    const issued = LOCAL_ENTITY_ID_BASE + 4_242
    expect(mintLocalEntityId(() => issued)).toBe(issued)
    expect(mintLocalEntityId(() => LOCAL_ENTITY_ID_BASE)).toBe(LOCAL_ENTITY_ID_BASE)
  })

  test('the allocator is called exactly once per mint', () => {
    let calls = 0
    const next = (): number => {
      calls += 1
      return LOCAL_ENTITY_ID_BASE + calls
    }
    mintLocalEntityId(next)
    mintLocalEntityId(next)
    expect(calls).toBe(2)
  })
})

// ————————————————————————————————————————————————————————————————
// Statelessness, asserted behaviourally
// ————————————————————————————————————————————————————————————————

/**
 * The minter keeps no counter, no cached high-water mark and no storage of its
 * own: the allocator it is handed is the single source of the sequence. That is
 * asserted by BEHAVIOUR rather than by scanning the source for a storage import,
 * because a counter can be introduced with no import at all — a bare
 * module-scope binding is enough, and a source scan looking for the wrong thing
 * would stay green over it.
 *
 * Durability across a restart of the daemon is a property of the real allocator
 * and is asserted where that allocator lives; simulating it here against a
 * counting fake would assert something about the fake.
 */
describe('the minter carries no counter of its own', () => {
  test('a fresh allocator restarts the sequence at its own base', () => {
    const allocatorA = countingEntityIds()
    const throughA = [
      mintLocalEntityId(allocatorA),
      mintLocalEntityId(allocatorA),
      mintLocalEntityId(allocatorA),
    ]

    const allocatorB = countingEntityIds()
    const throughB = [
      mintLocalEntityId(allocatorB),
      mintLocalEntityId(allocatorB),
      mintLocalEntityId(allocatorB),
    ]

    expect(throughA).toEqual([
      LOCAL_ENTITY_ID_BASE,
      LOCAL_ENTITY_ID_BASE + 1,
      LOCAL_ENTITY_ID_BASE + 2,
    ])
    // The second allocator's sequence starts where the second allocator starts,
    // not where the first one left off. A module-level counter, a memoized
    // high-water mark or any persistence of the minter's own makes this
    // continue the first sequence instead.
    expect(throughB[0]).toBe(LOCAL_ENTITY_ID_BASE)
    expect(throughB).toEqual(throughA)
  })

  test('two allocators used alternately keep separate sequences', () => {
    const allocatorA = countingEntityIds()
    const allocatorB = countingEntityIds()
    const interleaved = [
      mintLocalEntityId(allocatorA),
      mintLocalEntityId(allocatorB),
      mintLocalEntityId(allocatorA),
      mintLocalEntityId(allocatorB),
    ]
    expect(interleaved).toEqual([
      LOCAL_ENTITY_ID_BASE,
      LOCAL_ENTITY_ID_BASE,
      LOCAL_ENTITY_ID_BASE + 1,
      LOCAL_ENTITY_ID_BASE + 1,
    ])
  })

  test('an allocator answering one fixed id is answered with that id every time', () => {
    // A minter deriving its answer from a counter of its own would drift off the
    // allocator's constant answer on the second call.
    const fixed = LOCAL_ENTITY_ID_BASE + 77
    expect([mintLocalEntityId(() => fixed), mintLocalEntityId(() => fixed)]).toEqual([fixed, fixed])
  })
})

// ————————————————————————————————————————————————————————————————
// Thread ids: the mock adapter's shape, and surviving the wire
// ————————————————————————————————————————————————————————————————

/**
 * A thread id copied character for character out of the mock adapter's own test
 * suite, where it is passed to the reply and resolve verbs as a thread id. It is
 * a fixture, not a computation: a change to the minted shape on this side stops
 * it matching, and a change on the adapter's side leaves this copy behind.
 */
const GOLDEN_THREAD_ID = 'local:1:1'

/**
 * The shape the mock adapter mints: a fixed marker, the owning review's id, and
 * the root comment's id, joined by colons. Deliberately not forge-shaped, so an
 * id that strays into a forge-bound path is visibly local at a glance, and
 * self-describing, because it carries the review it belongs to.
 */
const MOCK_THREAD_ID_SHAPE = /^local:\d+:\d+$/

describe('the thread id shape predicate discriminates', () => {
  test('it accepts the golden thread id taken from the mock adapter suite', () => {
    expect(MOCK_THREAD_ID_SHAPE.test(GOLDEN_THREAD_ID)).toBe(true)
  })

  const REJECTED: readonly (readonly [string, string])[] = [
    ['a forge-shaped thread node id', 'PRRT_kwDOKq1aBc4AbCdEf'],
    ['a marker with no ids', 'local'],
    ['only one id', 'local:1'],
    ['a third id', 'local:1:1:1'],
    ['a non-numeric segment', 'local:one:1'],
    ['a path separator inside a segment', 'local:1/2:1'],
    ['a different marker', 'remote:1:1'],
    ['the empty string', ''],
    ['leading whitespace', ' local:1:1'],
  ]

  for (const [name, candidate] of REJECTED) {
    test(`it rejects ${name}`, () => {
      expect(MOCK_THREAD_ID_SHAPE.test(candidate)).toBe(false)
    })
  }
})

describe('minted thread ids match the shape the mock adapter mints', () => {
  test('the minter reproduces the golden thread id exactly', () => {
    // The one assertion that binds this minter to the adapter's shape. A change
    // to either alone breaks it.
    expect(mintLocalThreadId(1, 1)).toBe(GOLDEN_THREAD_ID)
  })

  test('a realistically banded thread id matches the shape', () => {
    const threadId = mintLocalThreadId(LOCAL_REVIEW_ID_BASE + 3, LOCAL_ENTITY_ID_BASE + 7)
    expect(threadId).toMatch(MOCK_THREAD_ID_SHAPE)
    expect(threadId).toBe('local:1000000003:9000000000007')
  })

  test('it carries no path separator', () => {
    const threadId = mintLocalThreadId(LOCAL_REVIEW_ID_BASE + 3, LOCAL_ENTITY_ID_BASE + 7)
    expect(threadId.includes('/')).toBe(false)
  })

  test('it survives a URL-component encode and decode unchanged', () => {
    const threadId = mintLocalThreadId(LOCAL_REVIEW_ID_BASE + 3, LOCAL_ENTITY_ID_BASE + 7)
    expect(decodeURIComponent(encodeURIComponent(threadId))).toBe(threadId)
    expect(decodeURIComponent(encodeURIComponent(GOLDEN_THREAD_ID))).toBe(GOLDEN_THREAD_ID)
  })

  test('distinct review and comment pairs mint distinct ids', () => {
    const minted = new Set<string>()
    for (const reviewId of [1, 2, LOCAL_REVIEW_ID_BASE, LOCAL_REVIEW_ID_BASE + 1]) {
      for (const commentId of [1, 2, LOCAL_ENTITY_ID_BASE, LOCAL_ENTITY_ID_BASE + 1]) {
        minted.add(mintLocalThreadId(reviewId, commentId))
      }
    }
    expect(minted.size).toBe(16)
  })

  /**
   * Non-integral and unsafely large inputs are refused rather than composed.
   * Composition alone would still produce a separator-free string, but not a
   * UNIQUE one: two distinct values above the safe-integer ceiling render
   * identically, so two different comments would name one thread.
   */
  test('an input that is not a safe non-negative integer is refused', () => {
    expect(() => mintLocalThreadId(1.5, 1)).toThrow()
    expect(() => mintLocalThreadId(1, 1.5)).toThrow()
    expect(() => mintLocalThreadId(Number.NaN, 1)).toThrow()
    expect(() => mintLocalThreadId(1, Number.POSITIVE_INFINITY)).toThrow()
    expect(() => mintLocalThreadId(Number.MAX_SAFE_INTEGER + 2, 1)).toThrow()
    expect(() => mintLocalThreadId(-1, 1)).toThrow()
    expect(() => mintLocalThreadId(1, -1)).toThrow()
  })

  test('the golden pair is not refused, so the refusals above are not universal', () => {
    expect(() => mintLocalThreadId(1, 1)).not.toThrow()
  })
})

// ————————————————————————————————————————————————————————————————
// The wire: a thread id is one path segment, there and back
// ————————————————————————————————————————————————————————————————

/**
 * The route matcher the daemon's request router runs, reproduced here because
 * the original is module-private and cannot be imported.
 *
 * It is copied rather than approximated on purpose. The whole claim being tested
 * is that a minted thread id comes back out of a real request path unchanged, so
 * a matcher that decoded differently, split differently, or aligned segments
 * differently would prove that claim about a matcher nothing runs. The two lines
 * that matter are the split-and-drop-empties of the incoming path and the
 * per-parameter `decodeURIComponent`; the surrounding length check and literal
 * comparison are carried along so the reproduction is the whole function rather
 * than the two lines lifted out of it.
 */
function matchRouteAsTheRouterDoes(
  template: string,
  pathname: string,
): Record<string, string> | null {
  const t = template.split('/').filter((s) => s.length > 0)
  const p = pathname.split('/').filter((s) => s.length > 0)
  if (t.length !== p.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith(':')) {
      params[t[i].slice(1)] = decodeURIComponent(p[i])
      continue
    }
    if (t[i] !== p[i]) return null
  }
  return params
}

describe('a minted thread id survives the reply route', () => {
  const LOCAL_ID = LOCAL_REVIEW_ID_BASE + 3

  /**
   * The reproduction is checked against a case whose answer is fixed by the
   * router's own documented behaviour before it is trusted with a thread id: a
   * matcher that had drifted would answer this wrongly too.
   */
  test('the reproduced matcher captures a simple numeric parameter', () => {
    expect(matchRouteAsTheRouterDoes('/api/pulls/:n/sync', '/api/pulls/204/sync')).toEqual({
      n: '204',
    })
  })

  test('the reproduced matcher rejects a path of the wrong length', () => {
    expect(matchRouteAsTheRouterDoes('/api/pulls/:n/sync', '/api/pulls/204')).toBeNull()
    expect(matchRouteAsTheRouterDoes('/api/pulls/:n/sync', '/api/pulls/204/sync/extra')).toBeNull()
  })

  test('the reproduced matcher rejects a mismatched literal segment', () => {
    expect(matchRouteAsTheRouterDoes('/api/pulls/:n/sync', '/api/pulls/204/snyc')).toBeNull()
  })

  test('a minted thread id comes back out of a filled reply path unchanged', () => {
    const threadId = mintLocalThreadId(LOCAL_ID, LOCAL_ENTITY_ID_BASE + 7)
    const filled = fillPath(ROUTES.replyToThread.path, { n: LOCAL_ID, threadId })
    const params = matchRouteAsTheRouterDoes(ROUTES.replyToThread.path, filled)
    expect(params).not.toBeNull()
    expect(params?.threadId).toBe(threadId)
    expect(params?.n).toBe(String(LOCAL_ID))
  })

  test('the golden thread id comes back out of a filled reply path unchanged', () => {
    const filled = fillPath(ROUTES.replyToThread.path, { n: LOCAL_ID, threadId: GOLDEN_THREAD_ID })
    expect(matchRouteAsTheRouterDoes(ROUTES.replyToThread.path, filled)?.threadId).toBe(
      GOLDEN_THREAD_ID,
    )
  })

  test('a minted thread id occupies exactly one path segment of the filled path', () => {
    const threadId = mintLocalThreadId(LOCAL_ID, LOCAL_ENTITY_ID_BASE + 7)
    const filled = fillPath(ROUTES.replyToThread.path, { n: LOCAL_ID, threadId })
    expect(filled.split('/')).toHaveLength(ROUTES.replyToThread.path.split('/').length)
  })

  /**
   * Why the absence of a path separator is asserted on the ID rather than only
   * through the round trip: the encode on the way out and the decode on the way
   * back are a matched pair, so a separator-bearing id survives THIS route
   * intact. It is any path built by joining strings — a hand-assembled URL, a
   * log line parsed back, a proxy that normalizes an encoded separator before
   * the daemon sees it — that the separator breaks, by turning one segment into
   * two and taking the path's length with it.
   */
  test('the encoded round trip alone would survive a separator, which is why the id itself is checked', () => {
    const filled = fillPath(ROUTES.replyToThread.path, { n: LOCAL_ID, threadId: 'local/1' })
    expect(matchRouteAsTheRouterDoes(ROUTES.replyToThread.path, filled)?.threadId).toBe('local/1')
  })

  test('a separator-bearing thread id breaks a path assembled by joining, where a minted one does not', () => {
    const naivePath = (threadId: string): string =>
      `/api/pulls/${LOCAL_ID}/threads/${threadId}/reply`
    const minted = mintLocalThreadId(LOCAL_ID, LOCAL_ENTITY_ID_BASE + 7)
    expect(matchRouteAsTheRouterDoes(ROUTES.replyToThread.path, naivePath(minted))?.threadId).toBe(
      minted,
    )
    expect(matchRouteAsTheRouterDoes(ROUTES.replyToThread.path, naivePath('local/1'))).toBeNull()
  })
})
