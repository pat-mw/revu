/**
 * Contract for the local-review supersession predicate.
 *
 * A local review is superseded when an OPEN pull request names the same
 * repository and the same branch pair. Each row below moves exactly one of the
 * three comparisons away from a matching baseline, so a predicate that ignores
 * any one of them — or that compares nothing at all and answers true — is
 * distinguishable from the real thing.
 */
import { describe, expect, it } from 'bun:test'
import type { GhUser, PullSummary } from '../api/types'
import { archivedReviewRefusal, bareBranchName, supersedes, supersedingPull } from './local-archive'

const ACTOR: GhUser = {
  login: 'octocat',
  id: 1,
  node_id: 'U_1',
  avatar_url: '',
  html_url: '',
  type: 'User',
}

interface PullShape {
  number?: number
  state?: 'open' | 'closed'
  headRepo?: string
  headRef?: string
  baseRef?: string
}

/**
 * A `PullSummary` carrying only the fields the predicate reads, with everything
 * else filled in inertly. Built here rather than imported from the app so the
 * shared package keeps no test dependency on a consumer.
 */
function pull(shape: PullShape = {}): PullSummary {
  const headRepo = shape.headRepo ?? 'acme/widgets'
  return {
    id: 100,
    node_id: 'PR_100',
    number: shape.number ?? 12,
    state: shape.state ?? 'open',
    draft: false,
    merged_at: null,
    title: 'A pull request',
    body: null,
    user: ACTOR,
    labels: [],
    requested_reviewers: [],
    head: {
      ref: shape.headRef ?? 'feature/x',
      sha: 'a'.repeat(40),
      label: `${headRepo}:${shape.headRef ?? 'feature/x'}`,
      repo: { full_name: headRepo, default_branch: 'main' },
    },
    base: {
      ref: shape.baseRef ?? 'main',
      sha: 'b'.repeat(40),
      label: `acme/widgets:${shape.baseRef ?? 'main'}`,
      repo: { full_name: 'acme/widgets', default_branch: 'main' },
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  }
}

/** The review every row starts from: the branch pair the baseline pull names. */
const REVIEW = {
  repo: 'acme/widgets',
  baseRef: 'refs/heads/main',
  headRef: 'refs/heads/feature/x',
}

describe('bareBranchName', () => {
  it('strips refs/heads/ from a local branch', () => {
    expect(bareBranchName('refs/heads/topic')).toBe('topic')
  })

  it('keeps the slashes inside a nested branch name', () => {
    expect(bareBranchName('refs/heads/feature/nested/topic')).toBe('feature/nested/topic')
  })

  it('strips both the prefix and the remote from a remote-tracking ref', () => {
    expect(bareBranchName('refs/remotes/origin/main')).toBe('main')
  })

  it('keeps the slashes inside a nested remote-tracking branch name', () => {
    expect(bareBranchName('refs/remotes/upstream/feature/x')).toBe('feature/x')
  })

  it('returns a ref outside heads and remotes unchanged', () => {
    expect(bareBranchName('refs/tags/v1.0.0')).toBe('refs/tags/v1.0.0')
  })

  it('returns an already-bare name unchanged', () => {
    expect(bareBranchName('feature/x')).toBe('feature/x')
  })

  it('returns the empty string for the empty string', () => {
    expect(bareBranchName('')).toBe('')
  })
})

interface Row {
  readonly what: string
  readonly review: { repo: string; baseRef: string; headRef: string }
  readonly pull: PullSummary
  readonly expected: boolean
}

const ROWS: readonly Row[] = [
  {
    what: 'the same repository, head ref and base ref supersede',
    review: REVIEW,
    pull: pull(),
    expected: true,
  },
  {
    what: 'a fork whose head branch is named identically does not supersede',
    review: REVIEW,
    pull: pull({ headRepo: 'contributor/widgets' }),
    expected: false,
  },
  {
    what: 'a different base ref does not supersede',
    review: REVIEW,
    pull: pull({ baseRef: 'release/2' }),
    expected: false,
  },
  {
    what: 'a different head ref does not supersede',
    review: REVIEW,
    pull: pull({ headRef: 'feature/y' }),
    expected: false,
  },
  {
    what: 'a base stored as a remote-tracking ref supersedes a pull based on the bare name',
    review: { ...REVIEW, baseRef: 'refs/remotes/origin/main' },
    pull: pull(),
    expected: true,
  },
  {
    what: 'a head stored fully qualified supersedes a pull naming the bare branch',
    review: { ...REVIEW, headRef: 'refs/heads/feature/x' },
    pull: pull({ headRef: 'feature/x' }),
    expected: true,
  },
  {
    what: 'a blank repository identity on both sides does not supersede',
    review: { ...REVIEW, repo: '' },
    pull: pull({ headRepo: '' }),
    expected: false,
  },
  {
    what: 'a blank head ref on both sides does not supersede',
    review: { ...REVIEW, headRef: '' },
    pull: pull({ headRef: '' }),
    expected: false,
  },
  {
    what: 'a closed pull request that otherwise matches does not supersede',
    review: REVIEW,
    pull: pull({ state: 'closed' }),
    expected: false,
  },
]

describe('supersedes', () => {
  for (const row of ROWS) {
    it(row.what, () => {
      expect(supersedes(row.review, row.pull)).toBe(row.expected)
    })
  }
})

describe('supersedingPull', () => {
  it('answers null over an empty list', () => {
    expect(supersedingPull(REVIEW, [])).toBeNull()
  })

  it('answers null when nothing in the list matches', () => {
    expect(supersedingPull(REVIEW, [pull({ number: 4, headRef: 'feature/other' })])).toBeNull()
  })

  it('picks the lowest-numbered open match, ignoring closed pulls and forks', () => {
    const candidates = [
      pull({ number: 12 }),
      pull({ number: 7 }),
      pull({ number: 3, state: 'closed' }),
      pull({ number: 1, headRepo: 'contributor/widgets' }),
    ]
    expect(supersedingPull(REVIEW, candidates)?.number).toBe(7)
  })
})

describe('archivedReviewRefusal', () => {
  const reason = archivedReviewRefusal({
    archivedPr: 101,
    baseRef: 'refs/heads/main',
    headRef: 'refs/heads/feature/x',
  })

  it('names the pull request number and the bare branch pair', () => {
    expect(reason).toContain('#101')
    expect(reason).toContain('main \u2190 feature/x')
    expect(reason).not.toContain('refs/heads/')
  })

  it('says the review is read-only and that nothing reached the pull request', () => {
    expect(reason).toMatch(/read-only/)
    expect(reason).toMatch(/Nothing in it was sent to that pull request/)
  })

  it('shares no wording with the self-review refusal', () => {
    // The positive control: the sentence is not empty, so the absence below
    // is an absence from real text.
    expect(reason.length).toBeGreaterThan(40)
    expect(reason).not.toMatch(/approv|author|your own|installation/i)
  })
})
