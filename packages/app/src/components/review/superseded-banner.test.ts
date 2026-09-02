/**
 * The banner over a review a pull request has taken over from — its decision as
 * a pure function, and its markup in every state that decision has.
 *
 * ## Why the invisible states are asserted as the EMPTY STRING
 *
 * Most of the states here must draw nothing, and "draws nothing" is the whole
 * point of them: a banner that rendered an empty shell would satisfy a
 * `not.toContain(...)` of its own copy while leaving a permanent gap under the
 * header of every live review. So each invisible state is pinned as `toBe('')`
 * — the component returned null and its element never existed — rather than as
 * an absence of its wording.
 *
 * That assertion means what it says only because the static render harness
 * THROWS on a component it cannot render: a missing provider aborts the render
 * with an error instead of returning an empty string, so an empty result can
 * only be a component that chose to draw nothing.
 *
 * ## One absence per test body, each with its own control
 *
 * A runner stops a body at its first failure, so two absences in one body would
 * leave the second never independently falsifiable. Where a body holds one
 * absence it also holds the positive control that absence rests on, because an
 * empty string — and a markup with no anchor in it — is equally what a
 * component that draws for NOBODY produces.
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderStatic } from '@/lib/render-test'
import type { ReviewMode } from '@/lib/review-mode'
import { SupersededBanner, supersededBannerVisible } from './superseded-banner'

/** The repository identity of a workspace that has a remote to point at. */
const REMOTE_REPO = 'meridian-labs/atlas'

/**
 * The identity a workspace with no remote records: an absolute path, which is
 * not an owner and a name and can never be made into one.
 */
const PATH_REPO = '/Users/x/atlas'

/** The pull request that came to cover the branch pair. */
const SUPERSEDING_PR = 101

/** The banner's markup for one review, rendered exactly as a browser receives it. */
function banner(
  mode: ReviewMode,
  archivedPr: number | null | undefined,
  repo: string | undefined,
): string {
  return renderStatic(createElement(SupersededBanner, { mode, archivedPr, repo }))
}

describe('whether the banner has anything to say', () => {
  test('a local review carrying the number of what superseded it gets one', () => {
    // The positive leg. Every other case is a refusal, and a predicate that
    // refused everything would satisfy all of them at once.
    expect(supersededBannerVisible({ mode: 'local', archivedPr: SUPERSEDING_PR })).toBe(true)
  })

  test('and a live one does not', () => {
    expect(supersededBannerVisible({ mode: 'local', archivedPr: null })).toBe(false)
  })

  test('and neither does one whose annotations have not been read yet', () => {
    // The state this predicate exists for. "Not known yet" is not a reason to
    // tell a reader their review has been superseded, and there is no third
    // answer it could give: the banner is drawn on an affirmative reading and
    // on nothing else.
    expect(supersededBannerVisible({ mode: 'local', archivedPr: undefined })).toBe(false)
  })

  test('a pull request never gets it, even holding a number', () => {
    // The annotation this is drawn from is local-only, so a pull request should
    // never carry one — and a gate that trusted the number alone would announce
    // a supersession on a pull request the moment anything upstream sent that
    // field.
    expect(supersededBannerVisible({ mode: 'github', archivedPr: SUPERSEDING_PR })).toBe(false)
  })
})

describe('what the banner puts on the screen', () => {
  test('an archived review names the pull request and links to it', () => {
    // The control for every empty below: this component does produce markup
    // from this harness when it has something to say, so their emptiness is a
    // decision rather than a component that draws for nobody.
    const html = banner('local', SUPERSEDING_PR, REMOTE_REPO)
    expect(html).toContain('#101')
    expect(html).toContain('href="https://github.com/meridian-labs/atlas/pull/101"')
    // The link opens a site away from the app, so the page it opens is denied
    // any handle back on the one that opened it.
    expect(html).toContain('rel="noreferrer"')
  })

  test('and a live review draws no element at all', () => {
    // `toBe('')`, not "does not contain the notice": a banner that returned an
    // empty wrapper would pass the weaker assertion while every live review
    // carried a permanent gap under its header. The control is the case above,
    // which renders from the same component through the same harness.
    expect(banner('local', null, REMOTE_REPO)).toBe('')
  })

  test('and one whose annotations have not arrived draws no element either', () => {
    // The flicker this component is shaped to make impossible. A loading branch
    // that drew anything would put a supersession notice, or the gap where one
    // goes, under every local review for as long as the read took.
    expect(banner('local', undefined, REMOTE_REPO)).toBe('')
  })

  test('and a pull request draws none whatever number it carries', () => {
    expect(banner('github', SUPERSEDING_PR, REMOTE_REPO)).toBe('')
  })

  test('a workspace with no remote still says which number, without linking', () => {
    // The half that must survive the refusal: the number is the reader's only
    // way to find the work that took over, and dropping it with the link would
    // leave the banner saying a review is archived and nothing about why.
    //
    // The control is in this body rather than in another, because the absence
    // it guards — no anchor in the markup — is also what a banner that renders
    // nothing at all produces, and the two must be told apart by the same
    // reading of the same component.
    const noRemote = banner('local', SUPERSEDING_PR, PATH_REPO)
    expect(noRemote).toContain('#101')
    expect(banner('local', SUPERSEDING_PR, REMOTE_REPO)).toContain('<a')
    expect(noRemote).not.toContain('<a')
  })

  test('and a review whose repository is not known yet does not link either', () => {
    // The annotations arrive as one record; a banner reached without them has
    // no identity to derive a link from, and a link built from a guess is worse
    // than none.
    const unknownRepo = banner('local', SUPERSEDING_PR, undefined)
    expect(unknownRepo).toContain('#101')
    expect(banner('local', SUPERSEDING_PR, REMOTE_REPO)).toContain('<a')
    expect(unknownRepo).not.toContain('<a')
  })
})
