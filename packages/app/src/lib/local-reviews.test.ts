import { describe, expect, test } from 'bun:test'
import type { PullListItem } from '@revu/shared'
import { LOCAL_REVIEW_ID_BASE } from '@revu/shared'
import type { RowIdentity } from './local-reviews'
import {
  createReviewIssue,
  isLocal,
  isLocalReviewItem,
  localReviewLabel,
  partitionInbox,
  rowIdentity,
} from './local-reviews'

/**
 * A listed review reduced to what this module reads: its number, the branch it
 * comes FROM, and the branch it points TO. Everything else is filler.
 *
 * The band is what decides local from remote, so the same helper builds both
 * kinds — a local review is a pull-shaped row with a number above the base, not
 * a differently shaped object.
 */
function pr(number: number, head: string, base: string): PullListItem {
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
      state: 'open',
      draft: false,
      merged_at: null,
      title: `Review ${number}`,
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

/** Review numbers, in the order they came out. */
const numbers = (items: readonly PullListItem[]) => items.map((it) => it.pull.number)

/** Review numbers, ascending — order-independent, for a set comparison. */
const sorted = (items: readonly PullListItem[]) => [...numbers(items)].sort((a, b) => a - b)

describe('telling a local review from a pull request', () => {
  test('the reserved band begins exactly at its base', () => {
    expect(isLocal(LOCAL_REVIEW_ID_BASE)).toBe(true)
    expect(isLocal(LOCAL_REVIEW_ID_BASE - 1)).toBe(false)
    expect(isLocal(482)).toBe(false)
  })

  test('a listed row is judged by the same band', () => {
    expect(isLocalReviewItem(pr(LOCAL_REVIEW_ID_BASE, 'release/0.41', 'main'))).toBe(true)
    expect(isLocalReviewItem(pr(482, 'feature/y', 'main'))).toBe(false)
  })
})

describe('splitting the inbox into its two kinds', () => {
  // Interleaved on purpose, and with the local pair DESCENDING, so a result
  // that merely happens to be sorted cannot pass for one that preserved order.
  const items = [
    pr(482, 'feature/y', 'main'),
    pr(LOCAL_REVIEW_ID_BASE + 1, 'feature/x', 'main'),
    pr(347, 'feature/z', 'main'),
    pr(LOCAL_REVIEW_ID_BASE, 'release/0.41', 'main'),
  ]

  test('each side keeps the order it arrived in', () => {
    const { local, github } = partitionInbox(items)
    expect(numbers(local)).toEqual([LOCAL_REVIEW_ID_BASE + 1, LOCAL_REVIEW_ID_BASE])
    expect(numbers(github)).toEqual([482, 347])
  })

  test('the split is total — nothing is dropped and nothing is counted twice', () => {
    const { local, github } = partitionInbox(items)
    expect(local.length + github.length).toBe(items.length)
    expect(sorted([...local, ...github])).toEqual(sorted(items))
  })

  test('an empty inbox yields two empty sides rather than a missing one', () => {
    expect(partitionInbox([])).toEqual({ local: [], github: [] })
  })
})

/**
 * Everything the identity slot would draw, whichever variant it is — the one
 * extraction both the absence assertion below and its positive control search,
 * so neither can be looking at a different string from the other.
 */
function renderedIdentity(identity: RowIdentity): string[] {
  return identity.kind === 'local' ? [identity.head, identity.base] : [identity.text]
}

/** Every contiguous run of characters in `s`, including the whole of it. */
function substrings(s: string): string[] {
  const out: string[] = []
  for (let start = 0; start < s.length; start++) {
    for (let end = start + 1; end <= s.length; end++) out.push(s.slice(start, end))
  }
  return out
}

/** The pieces of `number` that appear in `text`; empty means none of it leaked. */
function idTraces(number: number, text: string): string[] {
  return substrings(String(number)).filter((piece) => text.includes(piece))
}

describe('the identity a row renders', () => {
  test('a local review shows its branch pair and no fragment of its number', () => {
    const item = pr(LOCAL_REVIEW_ID_BASE + 1, 'feature/x', 'main')
    const identity = rowIdentity(item)
    expect(identity.kind).toBe('local')

    for (const text of renderedIdentity(identity)) {
      expect(idTraces(item.pull.number, text)).toEqual([])
    }

    // The exact pair, not "a string with no `#` in it" — an empty string would
    // satisfy that and render an identity slot with nothing in it.
    expect(localReviewLabel(item.pull)).toEqual({ head: 'feature/x', base: 'main' })
  })

  test('a pull request shows its number — the control that the search finds digits', () => {
    const item = pr(482, 'feature/y', 'main')
    const identity = rowIdentity(item)
    expect(identity).toEqual({ kind: 'github', text: '#482' })

    const found = renderedIdentity(identity).flatMap((text) => idTraces(item.pull.number, text))
    expect(found).toContain('482')
  })
})

/**
 * The pre-flight's complaint about `pair`, asserted to be real text: a non-null
 * empty string would satisfy "returns something" while telling the reader
 * nothing.
 */
function refusal(pair: { base: string; head: string }): string {
  const issue = createReviewIssue(pair)
  expect(typeof issue).toBe('string')
  expect((issue ?? '').trim().length).toBeGreaterThan(0)
  return issue ?? ''
}

describe('refusing a branch pair before it is sent', () => {
  test('one branch cannot be reviewed against itself', () => {
    refusal({ base: 'main', head: 'main' })
  })

  test('a missing side is refused', () => {
    refusal({ base: '', head: 'f' })
  })

  test('a ref git would read as an option is refused', () => {
    refusal({ base: '--upload-pack=x', head: 'f' })
  })

  // Without this the whole describe passes against a `() => 'no'` stub: it is
  // what separates a pre-flight from a refusal of everything.
  test('a valid pair passes', () => {
    expect(createReviewIssue({ base: 'main', head: 'feature/x' })).toBeNull()
  })

  test('each refused shape gets its own sentence', () => {
    const said = [
      refusal({ base: 'main', head: 'main' }),
      refusal({ base: '', head: 'f' }),
      refusal({ base: '--upload-pack=x', head: 'f' }),
    ]
    expect(new Set(said).size).toBe(said.length)
  })
})
