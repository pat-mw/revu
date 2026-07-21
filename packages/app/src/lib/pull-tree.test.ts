import { describe, expect, test } from 'bun:test'
import type { PullListItem } from '@revu/shared'
import { fixtureDB } from '@/fixtures'
import type { PullTreeNode } from './pull-tree'
import { buildPullTree, flattenPullTree } from './pull-tree'

/**
 * A pull request reduced to what the tree actually reads: its number, the branch
 * it comes FROM, and the branch it points TO. Everything else is filler.
 */
function pr(
  number: number,
  head: string,
  base: string,
  state: 'open' | 'closed' = 'open',
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
      state,
      draft: false,
      merged_at: null,
      title: `PR ${number}`,
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
      head: ref(head),
      base: ref(base),
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    broker: {
      authorHumanId: null,
      canApprove: true,
      unresolvedThreads: 0,
      assignedReviewerHumanIds: [],
      compareKey: `${base}...${head}`,
      commitCount: 1,
    },
  } as PullListItem
}

/** Root branch -> the pull numbers directly on it, for terse assertions. */
function shape(items: PullListItem[]): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const root of buildPullTree(items)) {
    out[root.branch] = root.children.map((c) => c.item.pull.number)
  }
  return out
}

describe('arranging pull requests by what they are stacked on', () => {
  test('a pull request targeting a plain branch sits directly on it', () => {
    expect(shape([pr(1, 'feature', 'main')])).toEqual({ main: [1] })
  })

  test('a pull request whose base is another\'s head becomes its child', () => {
    const roots = buildPullTree([pr(1, 'a', 'main'), pr(2, 'b', 'a')])
    expect(roots).toHaveLength(1)
    expect(roots[0].branch).toBe('main')
    expect(roots[0].children.map((c) => c.item.pull.number)).toEqual([1])
    expect(roots[0].children[0].children.map((c) => c.item.pull.number)).toEqual([2])
  })

  test('a stack nests to its full depth, and depth counts from the branch', () => {
    const roots = buildPullTree([pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'b')])
    const one = roots[0].children[0]
    const two = one.children[0]
    const three = two.children[0]
    expect([one.depth, two.depth, three.depth]).toEqual([0, 1, 2])
    expect(three.item.pull.number).toBe(3)
  })

  // The case that motivates the whole view: a release branch is a second root,
  // with its own stack, and a flat list cannot tell the two trains apart.
  test('a second base branch is its own root', () => {
    expect(
      shape([
        pr(1, 'a', 'main'),
        pr(2, 'b', 'main'),
        pr(3, 'c', 'release/x'),
        pr(4, 'd', 'c'),
      ]),
    ).toEqual({ main: [1, 2], 'release/x': [3] })
  })

  test('roots are ordered by how much work hangs off them, counting the whole stack', () => {
    // `release/x` holds one direct child but three pull requests in total, so it
    // outranks a branch with two shallow ones.
    const roots = buildPullTree([
      pr(1, 'a', 'main'),
      pr(2, 'b', 'main'),
      pr(3, 'c', 'release/x'),
      pr(4, 'd', 'c'),
      pr(5, 'e', 'd'),
    ])
    expect(roots.map((r) => [r.branch, r.total])).toEqual([
      ['release/x', 3],
      ['main', 2],
    ])
  })

  test('closed pull requests are left out entirely', () => {
    expect(shape([pr(1, 'a', 'main'), pr(2, 'b', 'main', 'closed')])).toEqual({ main: [1] })
  })

  test('siblings read oldest first, so a stack reads in the order it was built', () => {
    expect(shape([pr(9, 'c', 'main'), pr(2, 'a', 'main'), pr(5, 'b', 'main')])).toEqual({
      main: [2, 5, 9],
    })
  })
})

describe('refusing to lose or hang on a malformed graph', () => {
  // Not producible through GitHub, but a stale or hand-edited payload can carry
  // it, and rendering it naively recurses forever.
  test('a cycle does not hang, and every pull request still appears', () => {
    const roots = buildPullTree([pr(1, 'a', 'b'), pr(2, 'b', 'a')])
    const seen = flattenPullTree(roots).map((n) => n.item.pull.number).sort()
    expect(seen).toEqual([1, 2])
  })

  test('a pull request whose base is its own head does not become its own parent', () => {
    const roots = buildPullTree([pr(1, 'a', 'a')])
    expect(flattenPullTree(roots).map((n) => n.item.pull.number)).toEqual([1])
  })

  test('two open pull requests from one branch both stay visible', () => {
    const roots = buildPullTree([pr(1, 'dup', 'main'), pr(2, 'dup', 'main')])
    expect(flattenPullTree(roots).map((n) => n.item.pull.number).sort()).toEqual([1, 2])
  })

  test('an empty list produces no roots rather than an empty root', () => {
    expect(buildPullTree([])).toEqual([])
  })
})

describe('flattening for keyboard navigation', () => {
  test('rows come out in the order they are drawn, parent before its stack', () => {
    const roots = buildPullTree([
      pr(1, 'a', 'main'),
      pr(2, 'b', 'a'),
      pr(3, 'c', 'main'),
    ])
    expect(flattenPullTree(roots).map((n) => n.item.pull.number)).toEqual([1, 2, 3])
  })

  test('every pull request appears exactly once across all roots', () => {
    const items = [
      pr(1, 'a', 'main'),
      pr(2, 'b', 'a'),
      pr(3, 'c', 'release/x'),
      pr(4, 'd', 'release/x'),
    ]
    const flat = flattenPullTree(buildPullTree(items)).map((n) => n.item.pull.number)
    expect(flat.sort()).toEqual([1, 2, 3, 4])
  })
})

/**
 * The same function over the SHIPPED fixtures — the list mock mode, the demo
 * and the end-to-end run all render.
 *
 * The synthetic cases above prove the algorithm; these prove the data still
 * feeds it something worth drawing. If every fixture targeted the default
 * branch the tree would collapse into one root of flat rows — correct by every
 * test above, and visually identical to the list it is an alternative to. So
 * these assertions are aimed at the fixtures, not at `buildPullTree`: they fail
 * when a fixture's base ref is flattened, which is a silent regression the
 * screen would otherwise have to reveal.
 *
 * The fixtures are plain data, so this reads them directly and never touches
 * the mock's persistent store.
 */
const fixtureItems: PullListItem[] = fixtureDB.pulls.map((remote) => ({
  pull: remote.detail,
  broker: remote.broker,
}))

describe('the shipped fixtures, arranged the way mock mode draws them', () => {
  test('they group under more than one base branch, biggest first', () => {
    const roots = buildPullTree(fixtureItems)
    expect(roots.length).toBeGreaterThan(1)
    // The default branch carries the bulk, so it leads; the release branch is a
    // genuine second root rather than a stray row under `main`.
    expect(roots.map((r) => r.branch)).toEqual(['main', 'release/0.41'])
    expect(roots[1].children.map((c) => c.item.pull.number)).toEqual([415])
  })

  test('a real stack runs three branches deep, so depth is not always zero', () => {
    const roots = buildPullTree(fixtureItems)
    const main = roots.find((r) => r.branch === 'main')
    expect(main).toBeDefined()

    const byHead = (nodes: readonly PullTreeNode[], head: string): PullTreeNode | undefined =>
      nodes.find((n) => n.item.pull.head.ref === head)

    const bump = byHead(main!.children, 'chore/node-22')
    expect(bump).toBeDefined()
    expect(bump!.depth).toBe(0)

    const pool = byHead(bump!.children, 'marcus/ingest-worker-pool')
    expect(pool).toBeDefined()
    expect(pool!.depth).toBe(1)

    const spans = byHead(pool!.children, 'alice/otel-ingest-spans')
    expect(spans).toBeDefined()
    expect(spans!.depth).toBe(2)
  })

  test('at least one pull request renders below the top of its stack', () => {
    const depths = flattenPullTree(buildPullTree(fixtureItems)).map((n) => n.depth)
    expect(Math.max(...depths)).toBeGreaterThanOrEqual(1)
  })

  test('one branch carries two stacked pull requests, ordered oldest first', () => {
    const roots = buildPullTree(fixtureItems)
    const main = roots.find((r) => r.branch === 'main')!
    const bump = main.children.find((c) => c.item.pull.head.ref === 'chore/node-22')!
    expect(bump.children.map((c) => c.item.pull.number)).toEqual([204, 362])
  })

  test('no fixture is lost or duplicated by the arrangement', () => {
    const open = fixtureItems.filter((it) => it.pull.state === 'open')
    const flat = flattenPullTree(buildPullTree(fixtureItems)).map((n) => n.item.pull.number)
    expect([...flat].sort((a, b) => a - b)).toEqual(
      open.map((it) => it.pull.number).sort((a, b) => a - b),
    )
  })
})
