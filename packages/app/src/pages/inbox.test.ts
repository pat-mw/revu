/**
 * What the inbox puts on screen for a review that has no pull request behind
 * it, and what it must never put there.
 *
 * A local review's number is a synthetic key from a reserved band — an
 * internal identifier that exists so every route and cache key can stay a
 * plain integer. It is not a pull request number and there is nothing on
 * github.com it refers to, so rendering it would be showing the reader a
 * fiction. Three of the four claims below are therefore ABSENCES: no number,
 * no CI verdict, no fork. Each one carries its positive control in this file,
 * because a search that matches nothing and a render that produced nothing
 * both satisfy an absence for free.
 *
 * The local row is read out of the pull list rather than assembled here: that
 * the list item carries no checks rollup is the property under test, and a row
 * built by the test would prove only that the test built it that way. The mock
 * store is one process-wide document shared across every test file, so this
 * suite resets it before and after itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PullListItem } from '@revu/shared'
import { createMockApi } from '@/api/mock/adapter'
import { mockDev } from '@/api/mock/devtools'
import { fixtureDB } from '@/fixtures'
import { buildPullTooltip, checksSummary } from '@/lib/pull-tooltip'
import { InboxZeroState, RowIdentity } from './inbox'

const api = createMockApi()
const fixture = fixtureDB.localReviews[0]

/** The seeded local review's row, exactly as the pull list hands it over. */
let localRow: PullListItem

beforeAll(async () => {
  mockDev.reset()
  // Latency is simulated per call; the zero profile keeps the walk quick.
  mockDev.setLatency('zero')
  const list = await api.listPulls()
  const row = list.items.find((i) => i.pull.number === fixture.id)
  if (row === undefined) throw new Error('the seeded local review is not in the pull list')
  localRow = row
})

afterAll(() => {
  mockDev.reset()
})

/** The same row renumbered below the reserved band — a pull request in every other respect. */
function asPullRequest(row: PullListItem, number: number): PullListItem {
  return { ...row, pull: { ...row.pull, number } }
}

/** Rendered text with the markup taken out, so an assertion reads what a reader would. */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

describe('the identity slot on a local review row', () => {
  test('names both branches', () => {
    const text = visibleText(renderToStaticMarkup(createElement(RowIdentity, { item: localRow })))
    expect(text).toContain(fixture.snapshot.mutable.pull.base.ref)
    expect(text).toContain(fixture.snapshot.mutable.pull.head.ref)
  })

  test('never renders the synthetic id', () => {
    // Searched as a whole. Looking for any DIGIT of the id would collapse to
    // "contains no 0 and no 1", which a branch named `release/0.41` trips with
    // nothing leaked at all.
    const markup = renderToStaticMarkup(createElement(RowIdentity, { item: localRow }))
    expect(markup).not.toContain(String(fixture.id))
  })

  test('a pull request row does render its number', () => {
    // The positive control: the same row below the band, proving the search
    // above finds a number in this markup when one is there to find.
    const markup = renderToStaticMarkup(
      createElement(RowIdentity, { item: asPullRequest(localRow, 482) }),
    )
    expect(markup).toContain('#482')
  })
})

describe('the hover card over a local review', () => {
  test('claims no CI, because nothing reported on a branch never pushed', () => {
    expect(localRow.broker.checks).toBeUndefined()
    expect(buildPullTooltip(localRow).checks).toBeNull()
  })

  test('a rollup that summarises nothing would still have claimed a verdict', () => {
    // The positive control: the null above comes from an ABSENT rollup, not
    // from a phrasing function that stopped phrasing. A rollup over zero checks
    // reads as a pass, which is exactly the false claim absence avoids.
    expect(checksSummary({ state: 'success', total: 0 })).toEqual({
      state: 'success',
      text: 'Checks passed',
    })
  })

  test('is not a fork — both refs name the same repository', () => {
    expect(buildPullTooltip(localRow).branches.crossRepo).toBe(false)
  })

  test('a head in another repository does report a fork', () => {
    // The positive control for the absence above: cross-repo detection is live,
    // so `false` is a fact about this row and not a disabled check.
    const forked: PullListItem = {
      ...localRow,
      pull: {
        ...localRow.pull,
        head: { ...localRow.pull.head, repo: { full_name: 'someone/fork', default_branch: 'main' } },
      },
    }
    expect(buildPullTooltip(forked).branches.crossRepo).toBe(true)
  })
})

describe('the inbox with nothing open in it', () => {
  const markup = renderToStaticMarkup(
    createElement(InboxZeroState, { onCreate: () => {} }),
  )

  test('offers a way to start a review', () => {
    expect(markup).toContain('New local review')
  })

  test('does not promise a contractor who may never arrive', () => {
    expect(markup).not.toContain('contractor pushes a branch')
  })

  test('says what is actually possible here instead', () => {
    // The positive control for the absence above: an empty render would satisfy
    // it too, so the replacement copy has to be found in the same markup.
    expect(markup).toContain('a review can compare any two branches in this workspace')
  })
})
