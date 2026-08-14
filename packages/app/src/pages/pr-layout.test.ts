/**
 * The review header's tab strip, rendered as real HTML in both kinds of review.
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
 * `PrTabs` is props-only for exactly this reason: the layout around it needs a
 * query client, a session and a populated pull list before it renders a single
 * element, while the strip needs only the mode and two counts.
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderStatic } from '@/lib/render-test'
import { PrTabs } from './pr-layout'

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
