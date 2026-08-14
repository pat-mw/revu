import { describe, expect, test } from 'bun:test'
import type { PullListItem, ReviewDraft } from '@revu/shared'
import { LOCAL_REVIEW_ID_BASE } from '@revu/shared'
import type { InboxRow, InboxSectionsInput, Section } from './inbox-sections'
import {
  buildInboxSections,
  buildInboxTree,
  enterTarget,
  matchesFilter,
  nextFocusIndex,
} from './inbox-sections'
import { buildPullTree, flattenPullTree } from './pull-tree'
import type { PullTreeNode } from './pull-tree'
import { isLocal, partitionInbox } from './local-reviews'

/**
 * How the inbox sorts what it was handed: which section a row lands in, how
 * many sections it lands in, and what order the sections come in.
 *
 * Every assertion here is about a function rather than a screen. The sections
 * are the inbox's whole editorial claim — this is the work waiting on you, and
 * this is everything else — so they are worth holding to a total-ness property
 * (nothing input is lost, nothing appears that was not input) rather than to
 * spot checks on one bucket at a time.
 */

const HUMAN = 'human-1'
const OTHER = 'human-2'
const BOT = 'revu-bot[bot]'

/** A listed row reduced to what the derivation reads. Everything else is filler. */
function item(
  number: number,
  overrides: {
    state?: 'open' | 'closed'
    title?: string
    authorHumanId?: string | null
    unresolvedThreads?: number
    reviewers?: string[]
    head?: string
    base?: string
  } = {},
): PullListItem {
  const ref = (r: string) => ({
    ref: r,
    sha: `sha-${r}`,
    label: `o:${r}`,
    repo: { full_name: 'o/r', default_branch: 'main' },
  })
  return {
    pull: {
      id: number,
      node_id: `n${number}`,
      number,
      state: overrides.state ?? 'open',
      draft: false,
      merged_at: null,
      title: overrides.title ?? `Review ${number}`,
      body: null,
      user: {
        login: 'someone',
        id: 1,
        node_id: '',
        avatar_url: '',
        html_url: '',
        type: 'User',
      },
      labels: [],
      requested_reviewers: [],
      head: ref(overrides.head ?? `head-${number}`),
      base: ref(overrides.base ?? 'main'),
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    broker: {
      authorHumanId: overrides.authorHumanId ?? null,
      canApprove: true,
      unresolvedThreads: overrides.unresolvedThreads ?? 0,
      assignedReviewerHumanIds: overrides.reviewers ?? [],
      compareKey: `base...head-${number}`,
      commitCount: 1,
    },
  } as PullListItem
}

/** A local review's row: the same shape, carrying an id from the reserved band. */
function localItem(
  offset: number,
  overrides: Parameters<typeof item>[1] = {},
): PullListItem {
  return item(LOCAL_REVIEW_ID_BASE + offset, overrides)
}

function draft(prNumber: number): ReviewDraft {
  return {
    humanId: HUMAN,
    prNumber,
    headSha: 'sha',
    compareKey: 'base...head',
    body: '',
    event: 'COMMENT',
    comments: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

function build(overrides: Partial<InboxSectionsInput> = {}): Section[] {
  return buildInboxSections({
    items: [],
    needle: '',
    humanId: HUMAN,
    botLogin: BOT,
    draftByNumber: new Map(),
    hasLocalReviews: false,
    ...overrides,
  })
}

/** Section id → the review numbers it lists, for terse assertions. */
function shape(sections: Section[]): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const section of sections) {
    out[section.id] = section.rows.map((r) => r.item.pull.number)
  }
  return out
}

describe('filtering a row by what the reader typed', () => {
  test('an empty needle matches everything', () => {
    expect(matchesFilter(item(1), '', BOT)).toBe(true)
  })

  test('the title, the number and the author login are all searchable', () => {
    const row = item(482, { title: 'Cache TTL' })
    expect(matchesFilter(row, 'cache', BOT)).toBe(true)
    expect(matchesFilter(row, '482', BOT)).toBe(true)
    expect(matchesFilter(row, 'someone', BOT)).toBe(true)
    expect(matchesFilter(row, 'nothing here', BOT)).toBe(false)
  })

  // A local review has no number on screen and its author is a stand-in, so
  // its title is the only token the reader could have typed — and the title is
  // whatever they called it, which need not be the branch. Searching the pair
  // of branch names is what makes one findable by the thing it actually is.
  const sweep = localItem(0, { title: 'Local sweep', head: 'feature/x', base: 'main' })

  test('a review is found by either of the branches it compares', () => {
    expect(matchesFilter(sweep, 'feature/x', BOT)).toBe(true)
    expect(matchesFilter(sweep, 'main', BOT)).toBe(true)
  })

  test('a branch it does not compare does not find it', () => {
    // The control for the two above: a haystack that had quietly become
    // "everything" would satisfy them and fail here. The needle is a real
    // branch name from another row, so this is a miss rather than a nonsense
    // string no haystack could hold.
    expect(matchesFilter(sweep, 'feature/y', BOT)).toBe(false)
  })

  test('a pull request is found by its branch too', () => {
    // Branch names became searchable for every row, not only for the rows that
    // needed it. Asserted rather than left as an accident of where the widening
    // was written.
    expect(matchesFilter(item(482, { head: 'feature/y' }), 'feature/y', BOT)).toBe(true)
  })

  test('and never by the synthetic number it does not show', () => {
    // A token nobody can see is a way to find a row by a string it does not
    // contain: the reader gets a hit they cannot explain from anything on
    // screen. Both the whole id and a run of it, because a value carrying only
    // the id's tail would satisfy a search for the whole of it.
    expect(matchesFilter(sweep, String(LOCAL_REVIEW_ID_BASE), BOT)).toBe(false)
    expect(matchesFilter(sweep, '00000', BOT)).toBe(false)
  })

  test('while a pull request is still found by its number, however long', () => {
    // The control for the absence above, which dropping the number token from
    // every row would otherwise satisfy. The second needle is a genuine pull
    // request number with as many digits as a synthetic one has zeros, so the
    // rule cannot have degenerated into "long numbers are not searchable".
    expect(matchesFilter(item(482), '482', BOT)).toBe(true)
    expect(matchesFilter(item(1_000_000), '1000000', BOT)).toBe(true)
  })
})

describe('sorting reviews into the intent buckets', () => {
  test('your own review with unresolved comments is waiting on you', () => {
    const sections = build({
      items: [item(1, { authorHumanId: HUMAN, unresolvedThreads: 2 })],
    })
    expect(shape(sections).waiting).toEqual([1])
    expect(shape(sections).everything).toEqual([])
  })

  test("someone else's review assigned to you is one you owe", () => {
    const sections = build({
      items: [item(2, { authorHumanId: OTHER, reviewers: [HUMAN] })],
    })
    expect(shape(sections).review).toEqual([2])
    expect(shape(sections).everything).toEqual([])
  })

  test('a review you left a draft on is a draft in progress', () => {
    const sections = build({
      items: [item(3, { authorHumanId: OTHER })],
      draftByNumber: new Map([[3, draft(3)]]),
    })
    expect(shape(sections).drafts).toEqual([3])
    expect(shape(sections).everything).toEqual([])
  })

  test('a review no bucket claimed falls to the catch-all', () => {
    expect(shape(build({ items: [item(4, { authorHumanId: OTHER })] })).everything).toEqual([4])
  })

  test('a review can be in two intent buckets but never also in the catch-all', () => {
    const sections = build({
      items: [item(5, { authorHumanId: OTHER, reviewers: [HUMAN] })],
      draftByNumber: new Map([[5, draft(5)]]),
    })
    expect(shape(sections)).toEqual({
      waiting: [],
      review: [5],
      drafts: [5],
      everything: [],
    })
  })

  test('the sections come in intent order', () => {
    expect(build().map((s) => s.id)).toEqual(['waiting', 'review', 'drafts', 'everything'])
  })

  test('order within a section follows input order', () => {
    const sections = build({
      items: [item(9, { authorHumanId: OTHER }), item(3, { authorHumanId: OTHER })],
    })
    expect(shape(sections).everything).toEqual([9, 3])
  })

  test('the filter narrows every bucket at once', () => {
    const sections = build({
      items: [
        item(1, { authorHumanId: HUMAN, unresolvedThreads: 1, title: 'Cache TTL' }),
        item(2, { authorHumanId: OTHER, title: 'Rate limiting' }),
      ],
      needle: 'cache',
    })
    expect(shape(sections)).toEqual({
      waiting: [1],
      review: [],
      drafts: [],
      everything: [],
    })
  })
})

describe('what the inbox refuses to show', () => {
  test('a closed review appears in no section at all', () => {
    // The open-only rule is a property of this function, not an assumption
    // about the component that calls it: a later exemption for one kind of
    // review has to prove the filter still drops everything else, and this is
    // the row that proves it.
    const sections = build({ items: [item(6, { state: 'closed' })] })
    expect(sections.flatMap((s) => s.rows)).toEqual([])
  })
})

describe('where the local reviews section sits', () => {
  const GITHUB_SECTIONS = ['waiting', 'review', 'drafts', 'everything']

  test('open local reviews put the section first, above everything else', () => {
    const sections = build({
      items: [item(1, { authorHumanId: OTHER }), localItem(1)],
      hasLocalReviews: true,
    })
    expect(sections.map((s) => s.id)).toEqual(['local', ...GITHUB_SECTIONS])
  })

  test('with none open but some held, the section sits below every other', () => {
    const sections = build({
      items: [item(1, { authorHumanId: OTHER })],
      hasLocalReviews: true,
    })
    expect(sections.map((s) => s.id)).toEqual([...GITHUB_SECTIONS, 'local'])
    expect(sections[sections.length - 1].rows).toEqual([])
  })

  test('a reader who holds no local reviews gets no section', () => {
    const sections = build({ items: [item(1, { authorHumanId: OTHER })] })
    expect(sections.map((s) => s.id)).toEqual(GITHUB_SECTIONS)
  })

  test('a filter that hides every local row sends the section to the bottom', () => {
    const sections = build({
      items: [item(1, { title: 'Cache TTL', authorHumanId: OTHER }), localItem(1)],
      needle: 'cache',
      hasLocalReviews: true,
    })
    expect(sections.map((s) => s.id)).toEqual([...GITHUB_SECTIONS, 'local'])
  })

  test('a local row present is enough — the section never loses a row it holds', () => {
    // The existence flag and the rows come from two different reads, so they
    // can disagree while one of them is still in flight. Rows win: a section
    // suppressed on a stale flag would drop a row the caller handed over.
    const sections = build({ items: [localItem(1)], hasLocalReviews: false })
    expect(sections[0].id).toBe('local')
    expect(sections[0].rows.map((r) => r.item.pull.number)).toEqual([LOCAL_REVIEW_ID_BASE + 1])
  })

  test('order within the section follows input order', () => {
    const sections = build({ items: [localItem(9), localItem(2)], hasLocalReviews: true })
    expect(shape(sections).local).toEqual([
      LOCAL_REVIEW_ID_BASE + 9,
      LOCAL_REVIEW_ID_BASE + 2,
    ])
  })
})

describe('a local review is listed once and only once', () => {
  /** How many sections list this number, and which one of them did. */
  function placement(sections: Section[], number: number) {
    const holders = sections.filter((s) => s.rows.some((r) => r.item.pull.number === number))
    return { count: holders.length, ids: holders.map((s) => s.id) }
  }

  const overrides = { authorHumanId: OTHER } as const

  test('a local review the catch-all would otherwise claim is only in local', () => {
    const number = LOCAL_REVIEW_ID_BASE + 1
    const sections = build({ items: [localItem(1, overrides)], hasLocalReviews: true })
    expect(placement(sections, number)).toEqual({ count: 1, ids: ['local'] })
  })

  test('the same row below the band lands in the catch-all instead', () => {
    // The positive control for the exclusion above: identical in every respect
    // but its number, so the section it lands in is the id band's doing and not
    // a fixture that would have reached no bucket either way.
    const sections = build({ items: [item(482, overrides)], hasLocalReviews: true })
    expect(placement(sections, 482)).toEqual({ count: 1, ids: ['everything'] })
  })

  test('an intent bucket cannot claim a local review either', () => {
    // The catch-all excludes whatever an earlier bucket named, so it would hide
    // a double listing rather than show one — the intent buckets have to refuse
    // a local review themselves.
    const number = LOCAL_REVIEW_ID_BASE + 1
    const sections = build({
      items: [localItem(1, { authorHumanId: HUMAN, unresolvedThreads: 4, reviewers: [HUMAN] })],
      draftByNumber: new Map([[number, draft(number)]]),
      hasLocalReviews: true,
    })
    expect(placement(sections, number)).toEqual({ count: 1, ids: ['local'] })
  })

  test('the same intents on a pull request still fill three buckets', () => {
    // The control for the refusal above: without the id band, this row is in
    // every bucket it qualifies for, so the exclusion is not a fixture that
    // qualified for nothing.
    const sections = build({
      items: [item(482, { authorHumanId: HUMAN, unresolvedThreads: 4, reviewers: [HUMAN] })],
      draftByNumber: new Map([[482, draft(482)]]),
      hasLocalReviews: true,
    })
    expect(placement(sections, 482)).toEqual({ count: 2, ids: ['waiting', 'drafts'] })
  })
})

describe('what the keyboard column does while something is over it', () => {
  /** The flat keyboard column, as the inbox assembles it from its sections. */
  function column(...numbers: number[]): InboxRow[] {
    return numbers.map((n) => ({ item: item(n), draft: null }))
  }

  const rows = column(482, 483, 484)

  test('opening the focused row is refused while the column is blocked', () => {
    expect(enterTarget(rows, 0, { blocked: true })).toBeNull()
  })

  test('and is the focused row itself when it is not', () => {
    // The positive control for the refusal above: without it, a helper that
    // had been reduced to `return null` would satisfy the block forever.
    expect(enterTarget(rows, 0, { blocked: false })).toBe('/pr/482')
  })

  test('an empty column has nothing to open', () => {
    expect(enterTarget([], 0, { blocked: false })).toBeNull()
  })

  test('an index past the end of the column has nothing to open', () => {
    // The focused index is held across re-derivations, so it can outlive the
    // rows it pointed at — a filter narrowing the column is enough.
    expect(enterTarget(rows, 3, { blocked: false })).toBeNull()
    expect(enterTarget(rows, -1, { blocked: false })).toBeNull()
  })

  test('the focus does not move while the column is blocked', () => {
    expect(nextFocusIndex(2, 1, 5, { blocked: true })).toBe(2)
    expect(nextFocusIndex(2, -1, 5, { blocked: true })).toBe(2)
  })

  test('and moves by the step when it is not', () => {
    expect(nextFocusIndex(2, 1, 5, { blocked: false })).toBe(3)
    expect(nextFocusIndex(2, -1, 5, { blocked: false })).toBe(1)
  })

  test('the focus stops at both ends rather than wrapping', () => {
    expect(nextFocusIndex(4, 1, 5, { blocked: false })).toBe(4)
    expect(nextFocusIndex(0, -1, 5, { blocked: false })).toBe(0)
  })

  test('an empty column parks the focus at the top', () => {
    expect(nextFocusIndex(3, 1, 0, { blocked: false })).toBe(0)
  })
})

describe('the derivation loses nothing and invents nothing', () => {
  const items = [
    item(1, { authorHumanId: HUMAN, unresolvedThreads: 3 }),
    item(2, { authorHumanId: OTHER, reviewers: [HUMAN] }),
    item(3, { authorHumanId: OTHER }),
    localItem(1),
    localItem(2),
    item(7, { state: 'closed' }),
  ]
  const sections = build({
    items,
    draftByNumber: new Map([[3, draft(3)]]),
    hasLocalReviews: true,
  })
  const listed = new Set(sections.flatMap((s) => s.rows.map((r) => r.item.pull.number)))

  test('every open row reaches at least one section', () => {
    for (const it of items.filter((i) => i.pull.state === 'open')) {
      expect(listed.has(it.pull.number)).toBe(true)
    }
  })

  test('no section lists a review that was never input', () => {
    const input = new Set(items.map((i) => i.pull.number))
    for (const number of listed) expect(input.has(number)).toBe(true)
  })
})

describe('arranging reviews by what they are stacked on', () => {
  /**
   * The exact collision the arrangement exists to prevent: a local review whose
   * head branch is the base branch of a real pull request. Stacking is read from
   * branch names alone, so on names alone these two look like a stack.
   *
   * A third row that collides with nothing is here so the counts below are not
   * satisfied by a fixture of one row per side.
   */
  const LOCAL = LOCAL_REVIEW_ID_BASE
  const STACKED = 482
  const UNRELATED = 347

  const collision = [
    item(UNRELATED, { head: 'feature/z', base: 'main' }),
    localItem(0, { head: 'feature/x', base: 'main' }),
    item(STACKED, { head: 'feature/y', base: 'feature/x' }),
  ]

  const input = { items: collision, needle: '', botLogin: BOT }

  const nodes = (roots: ReturnType<typeof buildInboxTree>): PullTreeNode[] =>
    flattenPullTree(roots)
  const numbersIn = (roots: ReturnType<typeof buildInboxTree>): number[] =>
    nodes(roots).map((n) => n.item.pull.number)
  const nodeFor = (
    roots: ReturnType<typeof buildInboxTree>,
    number: number,
  ): PullTreeNode | undefined => nodes(roots).find((n) => n.item.pull.number === number)

  test('handed every row, the tree files a real pull request under a local review', () => {
    // Not a regression to fix — a statement of what the tree builder does, and
    // the reason the rows are separated before it runs. It reads parentage from
    // branch names and nothing else, which is the right thing for it to know;
    // this assertion is what proves the fixture above genuinely collides, so
    // the exclusion below cannot pass because the collision was never there.
    const roots = buildPullTree(collision)
    expect(nodeFor(roots, LOCAL)?.children.map((c) => c.item.pull.number)).toEqual([
      STACKED,
    ])
  })

  test('the arrangement keeps local reviews out of the tree entirely', () => {
    expect(numbersIn(buildInboxTree(input)).filter((n) => isLocal(n))).toEqual([])
  })

  test('so the pull request it would have parented stands on its own base branch', () => {
    expect(nodeFor(buildInboxTree(input), STACKED)?.depth).toBe(0)
  })

  test('and no row is lost between the tree and the group beside it', () => {
    const open = collision.filter((it) => it.pull.state === 'open')
    const { local } = partitionInbox(open)
    expect(numbersIn(buildInboxTree(input)).length + local.length).toBe(open.length)
  })

  test('both arrangements account for exactly the same reviews', () => {
    // The promise the List/Tree control makes: it re-sorts the screen, it does
    // not narrow it. The rows the tree does not draw are exactly the rows the
    // local group does, so switching arrangement can never hide a review.
    const sections = build({ items: collision, hasLocalReviews: true })
    const listed = sections.flatMap((s) => s.rows.map((r) => r.item.pull.number))
    const localGroup = shape(sections).local ?? []
    const arranged = [...numbersIn(buildInboxTree(input)), ...localGroup]
    expect([...new Set(arranged)].sort()).toEqual([...new Set(listed)].sort())
  })
})
