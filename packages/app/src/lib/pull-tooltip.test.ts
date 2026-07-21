import { describe, expect, test } from 'bun:test'
import type { ChecksRollup, PullListItem } from '@revu/shared'
import {
  SNIPPET_MAX_LENGTH,
  bodySnippet,
  branchPair,
  buildPullTooltip,
  checksSummary,
} from './pull-tooltip'

/**
 * A pull request reduced to what the hover card reads: a title, a body, the two
 * ends of the change, and the optional checks rollup. Everything else is filler.
 */
function item(over: {
  title?: string
  body?: string | null
  headRepo?: string
  baseRepo?: string
  headRef?: string
  baseRef?: string
  checks?: ChecksRollup
}): PullListItem {
  const ref = (r: string, repo: string) => ({
    ref: r,
    sha: `sha-${r}`,
    label: `${repo}:${r}`,
    repo: { full_name: repo, default_branch: 'main' },
  })
  return {
    pull: {
      id: 1,
      node_id: 'n1',
      number: 1,
      state: 'open',
      draft: false,
      merged_at: null,
      title: over.title ?? 'Tighten the poll loop',
      body: over.body === undefined ? null : over.body,
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
      head: ref(over.headRef ?? 'feature', over.headRepo ?? 'org/repo'),
      base: ref(over.baseRef ?? 'main', over.baseRepo ?? 'org/repo'),
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    broker: {
      authorHumanId: null,
      canApprove: true,
      unresolvedThreads: 0,
      assignedReviewerHumanIds: [],
      compareKey: 'a...b',
      commitCount: 1,
      ...(over.checks === undefined ? {} : { checks: over.checks }),
    },
  } as PullListItem
}

describe('extracting a readable snippet from a body', () => {
  test('plain prose comes through as written', () => {
    expect(bodySnippet('Drops the retry that double-counted a 304.')).toBe(
      'Drops the retry that double-counted a 304.',
    )
  })

  test('a missing body yields no snippet rather than an empty one', () => {
    expect(bodySnippet(null)).toBeNull()
  })

  test('an empty and a whitespace-only body both yield no snippet', () => {
    expect(bodySnippet('')).toBeNull()
    expect(bodySnippet('   \n\n\t  ')).toBeNull()
  })

  // Showing markup the reader cannot see in the rendered body is worse than
  // showing nothing at all, and template bodies routinely open with one.
  test('a body that is only an HTML comment yields no snippet', () => {
    expect(bodySnippet('<!-- Describe your change below. -->')).toBeNull()
  })

  test('a comment that is never closed does not leak into the snippet', () => {
    expect(bodySnippet('<!-- Describe your change below.')).toBeNull()
  })

  test('prose after a comment survives, and the comment does not', () => {
    const snippet = bodySnippet('<!-- template header -->\nFixes the crash on load.')
    expect(snippet).toBe('Fixes the crash on load.')
  })

  test('prose between two comments survives on its own', () => {
    expect(bodySnippet('<!-- a -->Real words.<!-- b -->')).toBe('Real words.')
  })

  test('a body that is only a template checklist yields no snippet', () => {
    const body = [
      '<!-- Thanks for contributing! -->',
      '## Checklist',
      '',
      '- [ ] Tests added',
      '- [x] Docs updated',
      '- [ ] Changelog entry',
    ].join('\n')
    expect(bodySnippet(body)).toBeNull()
  })

  test('a heading labels a section and never becomes the snippet', () => {
    expect(bodySnippet('## Summary\n\nMakes the sync idempotent.')).toBe(
      'Makes the sync idempotent.',
    )
  })

  test('a real bullet list is prose; its markers are not', () => {
    expect(bodySnippet('- Adds a cache\n- Removes the retry')).toBe(
      'Adds a cache Removes the retry',
    )
  })

  test('a fenced code block is skipped, and prose around it is kept', () => {
    const body = ['Reproduces with:', '```sh', 'bun run sync --force', '```', 'Fixed now.'].join(
      '\n',
    )
    expect(bodySnippet(body)).toBe('Reproduces with: Fixed now.')
  })

  test('a body that is only a code block yields no snippet', () => {
    expect(bodySnippet('```\nconst x = 1\n```')).toBeNull()
  })

  test('a body that is only rules and punctuation yields no snippet', () => {
    expect(bodySnippet('---\n\n***\n\n|---|---|')).toBeNull()
  })

  test('a body that is only an image yields no snippet', () => {
    expect(bodySnippet('![screenshot](https://example.test/a.png)')).toBeNull()
  })

  test('a link reads as its text, not its URL', () => {
    expect(bodySnippet('See [the write-up](https://example.test/x) for why.')).toBe(
      'See the write-up for why.',
    )
  })

  test('emphasis and code punctuation are removed but identifiers are not', () => {
    expect(bodySnippet('**Important:** `merge_base` now wins.')).toBe(
      'Important: merge_base now wins.',
    )
  })

  test('newlines, tabs and runs of spaces collapse to single spaces', () => {
    expect(bodySnippet('One\n\n\ttwo   three\r\nfour')).toBe('One two three four')
  })

  test('a quoted line still reads as prose without its marker', () => {
    expect(bodySnippet('> Reported upstream as a regression.')).toBe(
      'Reported upstream as a regression.',
    )
  })
})

describe('capping the snippet', () => {
  test('a body at the cap is not cut and carries no ellipsis', () => {
    const body = 'x'.repeat(SNIPPET_MAX_LENGTH)
    expect(bodySnippet(body)).toBe(body)
  })

  test('a long body is cut on a word boundary, never mid-word', () => {
    const body = `${'word '.repeat(80)}end`
    const snippet = bodySnippet(body)
    expect(snippet).not.toBeNull()
    expect(snippet?.endsWith('…')).toBe(true)
    expect(snippet?.length).toBeLessThanOrEqual(SNIPPET_MAX_LENGTH + 1)
    expect(snippet?.slice(0, -1).endsWith('word')).toBe(true)
  })

  // A minified blob or a very long URL has no boundary to cut on; a naive
  // word-boundary cut would return an ellipsis and nothing else.
  test('a single unbroken token is cut hard rather than collapsing to nothing', () => {
    const snippet = bodySnippet('a'.repeat(400))
    expect(snippet).toBe(`${'a'.repeat(SNIPPET_MAX_LENGTH)}…`)
  })

  test('a lone short word before a very long token does not become the whole snippet', () => {
    const snippet = bodySnippet(`hi ${'b'.repeat(400)}`)
    expect(snippet?.length).toBe(SNIPPET_MAX_LENGTH + 1)
    expect(snippet?.startsWith('hi b')).toBe(true)
  })
})

describe('naming both ends of the change', () => {
  test('a branch inside the same repository is shown bare', () => {
    expect(branchPair(item({ headRef: 'fix/poll', baseRef: 'main' }).pull)).toEqual({
      head: 'fix/poll',
      base: 'main',
      crossRepo: false,
    })
  })

  test('a fork head is qualified with its repository and flagged', () => {
    const pull = item({
      headRepo: 'contractor/repo',
      baseRepo: 'org/repo',
      headRef: 'main',
      baseRef: 'main',
    }).pull
    expect(branchPair(pull)).toEqual({
      head: 'contractor/repo:main',
      base: 'main',
      crossRepo: true,
    })
  })
})

describe('phrasing the checks rollup', () => {
  // Absent means nothing has reported. A pull request with no CI configured and
  // one whose checks have not started are the same fact here, and neither is a
  // failure — so there is nothing to say.
  test('an absent rollup produces no summary at all', () => {
    expect(checksSummary(undefined)).toBeNull()
  })

  test('a passing rollup counts what it summarises', () => {
    expect(checksSummary({ state: 'success', total: 3 })).toEqual({
      state: 'success',
      text: '3 checks passed',
    })
  })

  test('a single check is not pluralised', () => {
    expect(checksSummary({ state: 'success', total: 1 })?.text).toBe('1 check passed')
    expect(checksSummary({ state: 'failure', total: 1 })?.text).toBe('1 check failing')
    expect(checksSummary({ state: 'pending', total: 1 })?.text).toBe('1 check running')
  })

  test('a failing rollup does not invent a count it was not given', () => {
    expect(checksSummary({ state: 'failure', total: 5 })).toEqual({
      state: 'failure',
      text: '5 checks, some failing',
    })
  })

  test('a pending rollup reads as in flight, not as a verdict', () => {
    expect(checksSummary({ state: 'pending', total: 4 })?.text).toBe('4 checks running')
  })

  test('a rollup summarising no checks drops the count instead of saying zero', () => {
    expect(checksSummary({ state: 'pending', total: 0 })?.text).toBe('Checks running')
    expect(checksSummary({ state: 'success', total: 0 })?.text).toBe('Checks passed')
    expect(checksSummary({ state: 'failure', total: 0 })?.text).toBe('Checks failing')
  })
})

describe('the whole hover card', () => {
  test('the full title survives, so a truncated row can be read in full', () => {
    const title = `Rework ${'the sync loop '.repeat(12)}end`
    expect(buildPullTooltip(item({ title })).title).toBe(title)
  })

  test('a title broken across lines is normalised to one', () => {
    expect(buildPullTooltip(item({ title: 'Fix   the\nsync' })).title).toBe('Fix the sync')
  })

  test('the common case: prose body, same-repo branches, no rollup yet', () => {
    const tip = buildPullTooltip(
      item({
        title: 'Tighten the poll loop',
        body: 'Halves the list request budget.',
        headRef: 'fix/poll',
        baseRef: 'main',
      }),
    )
    expect(tip).toEqual({
      title: 'Tighten the poll loop',
      snippet: 'Halves the list request budget.',
      branches: { head: 'fix/poll', base: 'main', crossRepo: false },
      checks: null,
    })
  })

  test('a bot pull request with a template body and a failing rollup still renders', () => {
    const tip = buildPullTooltip(
      item({
        title: 'Bump the lockfile',
        body: '<!-- generated -->\n- [ ] reviewed',
        checks: { state: 'failure', total: 2 },
      }),
    )
    expect(tip.snippet).toBeNull()
    expect(tip.checks).toEqual({ state: 'failure', text: '2 checks, some failing' })
  })
})
