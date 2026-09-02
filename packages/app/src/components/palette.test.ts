/**
 * What the command palette offers for a review that has no pull request behind
 * it, and what it must never offer.
 *
 * A local review's number is a synthetic key from a reserved band. Nothing on
 * github.com answers to it, so the palette neither draws it nor matches typed
 * text against it: a reader who opens the palette sees a branch pair, and a
 * reader who types the id finds nothing. Both claims are ABSENCES, and each
 * carries its positive control here — an item that rendered nothing, and a
 * search over an empty string, satisfy an absence for free.
 *
 * The rows are read out of the pull list rather than assembled here. The
 * seeded local review is open and therefore lands in exactly the list the
 * palette reads, which is the condition a leak needs. The mock store is one
 * process-wide document shared across every test file, so this suite resets it
 * before and after itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PullListItem } from '@revu/shared'
import { LOCAL_REVIEW_ID_BASE } from '@revu/shared'
import { createMockApi } from '@/api/mock/adapter'
import { mockDev } from '@/api/mock/devtools'
import { fixtureDB } from '@/fixtures'
import { PaletteReviewLabel, paletteReviews } from './palette'
import type { PaletteReview } from './palette'

const api = createMockApi()
const fixture = fixtureDB.localReviews[0]

/** Every row the pull list hands over, exactly as the palette receives them. */
let listed: PullListItem[]
/** The seeded local review's row. */
let localRow: PullListItem

beforeAll(async () => {
  mockDev.reset()
  // Latency is simulated per call; the zero profile keeps the walk quick.
  mockDev.setLatency('zero')
  const list = await api.listPulls()
  listed = [...list.items]
  const row = listed.find((i) => i.pull.number === fixture.id)
  if (row === undefined) throw new Error('the seeded local review is not in the pull list')
  localRow = row
})

afterAll(() => {
  mockDev.reset()
})

/** The same row under a different number — the band alone decides what it is. */
function renumber(row: PullListItem, number: number): PullListItem {
  return { ...row, pull: { ...row.pull, number } }
}

/** Rendered text with the markup taken out, so an assertion reads what a reader would. */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function label(review: PaletteReview): string {
  return renderToStaticMarkup(createElement(PaletteReviewLabel, { review }))
}

describe('which group a review is offered in', () => {
  test('the seeded local review is offered, and never among the pull requests', () => {
    const { pulls, local } = paletteReviews(listed)
    expect(local.map((r) => r.number)).toContain(fixture.id)
    expect(pulls.map((r) => r.number)).not.toContain(fixture.id)
  })

  test('the pull requests group is not simply empty', () => {
    // The control for the absence above: real pull requests are still offered,
    // so "not among the pull requests" is a partition and not a blank group.
    expect(paletteReviews(listed).pulls.length).toBeGreaterThan(0)
  })

  test('a closed review is offered in neither group', () => {
    const closed: PullListItem = {
      ...localRow,
      pull: { ...localRow.pull, number: 482, state: 'closed' },
    }
    const { pulls, local } = paletteReviews([closed])
    expect(pulls).toEqual([])
    expect(local).toEqual([])
  })
})

describe('what a typed query can find a local review by', () => {
  test('its branches and its title, and no part of its number', () => {
    const review = paletteReviews(listed).local.find((r) => r.number === fixture.id)
    expect(review).toBeDefined()

    // Pinned whole rather than probed for absences: an exact value is the only
    // form in which "nothing else is searchable here" can be read off, and it
    // makes any later addition to the search vocabulary a deliberate edit.
    expect(review!.value).toBe(
      `local review ${localRow.pull.base.ref} ${localRow.pull.head.ref} ${localRow.pull.title}`,
    )
    expect(review!.value).not.toContain(String(fixture.id))
    // A run of the id long enough to be typed as a search on its own. Stated
    // separately because it is the shape of the leak, not a restatement: a
    // value carrying only the id's tail would satisfy the whole-id search.
    expect(review!.value).not.toContain('00000')
  })

  test('every local review the list carries, not only the seeded one', () => {
    const { local } = paletteReviews(listed)
    expect(local.length).toBeGreaterThan(0)
    for (const review of local) {
      expect(review.value).not.toContain(String(review.number))
    }
  })

  test('a pull request is still found by its number — the control', () => {
    // Without this, the absences above are satisfied by a palette that dropped
    // the number from every value and made no review findable by one.
    const review = paletteReviews([renumber(localRow, 482)]).pulls[0]
    expect(review.value).toContain('482')
  })
})

describe('what a local review draws in the palette', () => {
  test('its branch pair, and no part of its number', () => {
    const review = paletteReviews(listed).local.find((r) => r.number === fixture.id)!
    const markup = label(review)
    // Searched as a whole. Looking for any DIGIT of the id would collapse to
    // "contains no 0 and no 1", which a branch named `release/0.41` trips with
    // nothing leaked at all.
    expect(markup).not.toContain(String(fixture.id))

    const text = visibleText(markup)
    expect(text).toContain(localRow.pull.base.ref)
    expect(text).toContain(localRow.pull.head.ref)
    expect(text).toContain(localRow.pull.title)
  })

  test('a pull request draws its number — the control that the search finds one', () => {
    const review = paletteReviews([renumber(localRow, 482)]).pulls[0]
    expect(label(review)).toContain('#482')
  })

  test('the branch pair is named for a reader who cannot see the arrow', () => {
    const review = paletteReviews(listed).local.find((r) => r.number === fixture.id)!
    expect(label(review)).toContain(
      `aria-label="Local review of ${localRow.pull.head.ref} against ${localRow.pull.base.ref}"`,
    )
  })
})

describe('the cap on how many reviews the palette lists', () => {
  /** `count` rows numbered from `first` upwards, all open, all distinct. */
  function rows(first: number, count: number): PullListItem[] {
    return Array.from({ length: count }, (_, i) => renumber(localRow, first + i))
  }

  test('each kind is capped on its own', () => {
    const { pulls, local } = paletteReviews([
      ...rows(100, 12),
      ...rows(LOCAL_REVIEW_ID_BASE + 500, 12),
    ])
    // Literal on both sides: a cap compared against the constant it is derived
    // from would hold for any value that constant took.
    expect(pulls).toHaveLength(10)
    expect(local).toHaveLength(10)
  })

  test('a wall of local reviews cannot push a pull request off the list', () => {
    // The rows are ordered local-first, so under one cap over one undivided
    // list the pull request is the thirty-first item and never offered.
    const { pulls } = paletteReviews([...rows(LOCAL_REVIEW_ID_BASE + 500, 30), renumber(localRow, 482)])
    expect(pulls.map((r) => r.number)).toEqual([482])
  })

  test('and a wall of pull requests cannot push a local review off it either', () => {
    const { local } = paletteReviews([...rows(100, 30), renumber(localRow, LOCAL_REVIEW_ID_BASE + 7)])
    expect(local.map((r) => r.number)).toEqual([LOCAL_REVIEW_ID_BASE + 7])
  })
})
