/**
 * The review header — its identity row and its tab strip — rendered as real
 * HTML in both kinds of review, plus the pure decision behind the one banner
 * the header hangs beneath them.
 *
 * A review of two local branches has no continuous integration behind it and no
 * body someone typed into a form, so a Checks tab and a Description tab there
 * lead to screens whose only content is a claim about a service this workspace
 * is not talking to. The strip omits them. That is an ABSENCE, and an absence
 * asserted against markup is satisfied for free by markup that rendered nothing
 * at all — so every `not.toContain` below is paired with the same string
 * asserted PRESENT in the other mode, from the same component and the same
 * harness.
 *
 * `PrTabs` and `PrIdentityRow` are props-only for exactly this reason: the
 * layout around them needs a query client, a session and a populated pull list
 * before it renders a single element, while the strip needs only the mode and
 * two counts and the identity row needs only the mode and the review itself.
 *
 * The reviews are read out of the fixture set rather than assembled here. What
 * is under test is what the header does with a real review — a branch pair
 * whose head is `release/0.41` is exactly the kind of name a careless identity
 * assertion mistakes for a leaked key — and a review built by the test would
 * prove only that the test built it that way.
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import type { PullDetail, PullSummary } from '@revu/shared'
import { fixtureDB } from '@/fixtures'
import { renderStatic } from '@/lib/render-test'
import { authorBannerVisible } from '@/components/author/author-banner'
import { PrIdentityRow, PrTabs } from './pr-layout'

/** The strip as HTML, with counts that make both count slots render. */
function strip(mode: 'github' | 'local'): string {
  return renderStatic(createElement(PrTabs, { mode, changedFiles: 12, unresolved: 3 }))
}

/** The nav's accessible name, or a sentence saying it has none. */
function navLabel(html: string): string {
  const match = /<nav[^>]*\saria-label="([^"]*)"/.exec(html)
  return match === null ? 'the tab strip has no accessible name' : match[1]
}

const GITHUB = strip('github')
const LOCAL = strip('local')

describe('which sections a review offers', () => {
  test('a pull request offers all five', () => {
    // The control for the two absences below: these exact strings do reach the
    // markup from this component, so their absence in the other mode is the
    // omission and not a component that rendered nothing.
    expect(GITHUB).toContain('Description')
    expect(GITHUB).toContain('Conversation')
    expect(GITHUB).toContain('Files')
    expect(GITHUB).toContain('Commits')
    expect(GITHUB).toContain('Checks')
  })

  test('a local review offers the three that mean something on a branch', () => {
    expect(LOCAL).toContain('Conversation')
    expect(LOCAL).toContain('Files')
    expect(LOCAL).toContain('Commits')
  })

  // The two absences are asserted one per test rather than together: a runner
  // stops a test at its first failure, so a pair in one body would let the
  // second tab's return go unreported behind the first.
  //
  // Both are searched over the WHOLE markup rather than over link labels, so a
  // tab reintroduced through a different element — a title, a heading, an
  // aria-label — is caught too. The hrefs are lowercase (`/checks`), so neither
  // string can be matched by a route that legitimately survives.
  test('and omits Checks', () => {
    expect(LOCAL).not.toContain('Checks')
  })

  test('and omits Description', () => {
    expect(LOCAL).not.toContain('Description')
  })
})

describe('what the tab strip is called', () => {
  test('a pull request names the pull request', () => {
    expect(navLabel(GITHUB)).toBe('Pull request sections')
  })

  test('a local review has a name, and it names no pull request', () => {
    // Both halves matter. Dropping the label entirely would satisfy the second
    // assertion while leaving the only landmark in the header unnamed.
    expect(navLabel(LOCAL)).not.toBe('the tab strip has no accessible name')
    expect(navLabel(LOCAL)).not.toMatch(/pull request/i)
  })
})

describe('the tabs that survive the omission', () => {
  test('each is a link, and none suppresses the global focus ring', () => {
    // Three anchors in the local strip is the count itself, read off the
    // markup rather than off the component's source. `outline-none` anywhere
    // in a tab's classes would remove the one focus indicator the stylesheet
    // gives every focusable thing, and a tab that cannot be seen when focused
    // is a tab a keyboard reader loses.
    expect(LOCAL.match(/<a\b/g)).toHaveLength(3)
    expect(GITHUB.match(/<a\b/g)).toHaveLength(5)
    expect(LOCAL).not.toContain('outline-none')
    expect(GITHUB).not.toContain('outline-none')
  })

  test('the counts still reach the tabs that carry them', () => {
    // Guards the extraction: the two counts were props of the layout before
    // the strip was lifted out, and a strip that quietly stopped drawing them
    // would pass every assertion above.
    expect(LOCAL).toContain('12')
    expect(LOCAL).toContain('3')
  })

  test('a count slot is omitted rather than drawn as zero', () => {
    const quiet = renderStatic(
      createElement(PrTabs, { mode: 'local', changedFiles: undefined, unresolved: 0 }),
    )
    expect(quiet).toContain('Conversation')
    expect(quiet).not.toContain('>0<')
  })
})

// ————————————————————————————————————————————————————————————————
// The identity row
// ————————————————————————————————————————————————————————————————

/** The seeded pull request with this number, or a failure naming it. */
function pullNumbered(n: number): PullDetail {
  const found = fixtureDB.pulls.find((p) => p.detail.number === n)
  if (found === undefined) throw new Error(`the fixture set holds no pull request ${n}`)
  return found.detail
}

const GITHUB_PULL = pullNumbered(347)
const LOCAL_PULL = fixtureDB.localReviews[0].snapshot.mutable.pull

/** One review's identity row as HTML. */
function identityRow(mode: 'github' | 'local', pull: PullSummary): string {
  return renderStatic(createElement(PrIdentityRow, { mode, pull }))
}

/** Rendered text with the markup taken out, so an assertion reads what a reader would. */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The identity slot's accessible name, or a sentence saying it has none. */
function identityLabel(markup: string): string {
  const match = /\saria-label="([^"]*)"/.exec(markup)
  return match === null ? 'the identity slot has no accessible name' : match[1]
}

const GITHUB_ROW = identityRow('github', GITHUB_PULL)
const LOCAL_ROW = identityRow('local', LOCAL_PULL)

describe('what a review is called in its own header', () => {
  test('a pull request is called by its number', () => {
    // The positive control for both absences below: this search does find a
    // number in this component's markup when there is one to find.
    expect(visibleText(GITHUB_ROW)).toContain('#347')
  })

  test('a branch pair is called by the two branches it compares', () => {
    expect(visibleText(LOCAL_ROW)).toContain(
      `${LOCAL_PULL.base.ref} ← ${LOCAL_PULL.head.ref}`,
    )
  })

  test('and renders no number anywhere in its markup', () => {
    // The rule as a regex over real markup rather than as a promise about one
    // element, so it stays true if a later edit reintroduces the number
    // through a different one — a heading, a title, an attribute. Searched
    // over the raw HTML for that reason, not over the visible text.
    expect(LOCAL_ROW).not.toMatch(/#\d+/)
  })

  test('nor the key itself, unadorned', () => {
    // Searched WHOLE. Hunting for digits of the key would collapse to "names
    // no 0 and no 1", which this fixture's own `release/0.41` trips with
    // nothing leaked at all.
    expect(LOCAL_ROW).not.toContain(String(LOCAL_PULL.number))
  })

  test('the pair is named as one thing, because an arrow has no spoken form', () => {
    expect(identityLabel(LOCAL_ROW)).toBe(
      `Local review of ${LOCAL_PULL.head.ref} against ${LOCAL_PULL.base.ref}`,
    )
  })

  test('a branch pair says where it came from, and a pull request does not', () => {
    // The marker is a provenance fact, so it is the quiet outline chip rather
    // than the violet reserved for pending work or the gold for a snapshot
    // time moved underneath.
    expect(LOCAL_ROW).toContain('>local<')
    expect(GITHUB_ROW).not.toContain('>local<')
  })

  test('both kinds of review still say what state they are in', () => {
    // Dropping the chip on one path would make a review still taking comments
    // look exactly like one that is finished with them.
    expect(visibleText(GITHUB_ROW)).toContain('open')
    expect(visibleText(LOCAL_ROW)).toContain('in review')
  })

  test('and both draw the title they were given', () => {
    expect(visibleText(GITHUB_ROW)).toContain(GITHUB_PULL.title)
    expect(visibleText(LOCAL_ROW)).toContain(LOCAL_PULL.title)
  })
})

// ————————————————————————————————————————————————————————————————
// The banner beneath the header
// ————————————————————————————————————————————————————————————————

describe('who the thread-queue banner is for', () => {
  test('a pull request shows it to the human who drove the identity that opened it', () => {
    // Pinned with an empty queue on purpose: this path shows the banner to its
    // author whether or not anything is waiting, and that is the rule the
    // local answer below must not leak into.
    expect(
      authorBannerVisible({
        mode: 'github',
        authorHumanId: 'h-1',
        humanId: 'h-1',
        state: 'open',
        unresolved: 0,
      }),
    ).toBe(true)
  })

  test('and to nobody else, however much is waiting', () => {
    expect(
      authorBannerVisible({
        mode: 'github',
        authorHumanId: 'h-2',
        humanId: 'h-1',
        state: 'open',
        unresolved: 3,
      }),
    ).toBe(false)
  })

  test('and not once the pull request is closed', () => {
    expect(
      authorBannerVisible({
        mode: 'github',
        authorHumanId: 'h-1',
        humanId: 'h-1',
        state: 'closed',
        unresolved: 3,
      }),
    ).toBe(false)
  })

  test('a branch pair shows it whenever threads are waiting, whoever is reading', () => {
    // Nobody drove a shared identity to open anything here, so there is no
    // authorship to match against — the banner is warranted by the trip it
    // offers, which is the only entry to the thread queue in the header.
    expect(
      authorBannerVisible({
        mode: 'local',
        authorHumanId: null,
        humanId: 'h-1',
        state: 'open',
        unresolved: 2,
      }),
    ).toBe(true)
  })

  test('and withholds it when the queue is empty and there is no trip to offer', () => {
    expect(
      authorBannerVisible({
        mode: 'local',
        authorHumanId: null,
        humanId: 'h-1',
        state: 'open',
        unresolved: 0,
      }),
    ).toBe(false)
  })

  test('and never on a review that has stopped taking comments', () => {
    expect(
      authorBannerVisible({
        mode: 'local',
        authorHumanId: null,
        humanId: 'h-1',
        state: 'closed',
        unresolved: 2,
      }),
    ).toBe(false)
  })
})
