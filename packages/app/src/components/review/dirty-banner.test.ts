/**
 * The banner that says a review does not cover everything on disk — its
 * decision as a pure function, and its markup in every state that decision has.
 *
 * ## Why the invisible states are asserted as the EMPTY STRING
 *
 * Three of the four states must draw nothing, and "draws nothing" is the whole
 * point of them: a banner that rendered an empty shell would satisfy a
 * `not.toContain(...)` of its own copy while leaving a permanent gap in the
 * header of every review that has nothing to warn about. So each invisible
 * state is pinned as `toBe('')` — the component returned null and its element
 * never existed — rather than as an absence of its wording.
 *
 * That assertion means what it says only because the static render harness
 * THROWS on a component it cannot render: a missing provider aborts the render
 * with an error instead of returning an empty string, so an empty result can
 * only be a component that chose to draw nothing. Without that, `''` and "the
 * render blew up" would be the same observation.
 *
 * ## One absence per test body
 *
 * A runner stops a body at its first failure, so two `toBe('')` assertions in
 * one body would leave the second never independently falsifiable — its control
 * would only look like it bit. Each invisible state gets its own test.
 *
 * ## The visible state is the control the other three rest on
 *
 * An empty string is also what a component that renders nothing for ANYBODY
 * produces, which is a different defect wearing the same green. The fourth
 * state renders the sentence from the same component through the same harness,
 * so the three empties are an omission rather than a component that never draws.
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderStatic } from '@/lib/render-test'
import { dirtyWorktreeCopy } from '@/lib/mode-copy'
import type { ReviewMode } from '@/lib/review-mode'
import { DirtyWorktreeBanner, dirtyWorktreeBannerVisible } from './dirty-banner'

/** The banner's markup for one review, rendered exactly as a browser receives it. */
function banner(mode: ReviewMode, dirty: boolean | undefined): string {
  return renderStatic(createElement(DirtyWorktreeBanner, { mode, dirty }))
}

/**
 * The headline the banner draws on a branch pair, or a sentence saying it has
 * none.
 *
 * Never the empty string, and that is the whole reason this is not read
 * inline: every markup contains the empty one, so copy reduced to blanks would
 * satisfy a search for it and report a banner drawing nothing as a banner
 * drawing its sentence.
 */
function headline(): string {
  return dirtyWorktreeCopy('local')?.title || 'the banner draws no headline on a branch pair'
}

describe('whether the banner has anything to say', () => {
  test('a branch pair whose working tree held uncommitted changes gets it', () => {
    // The positive leg. Every other case below is a refusal, and a predicate
    // that refused everything would satisfy all of them at once.
    expect(dirtyWorktreeBannerVisible({ mode: 'local', dirty: true })).toBe(true)
  })

  test('and a branch pair with a clean working tree does not', () => {
    expect(dirtyWorktreeBannerVisible({ mode: 'local', dirty: false })).toBe(false)
  })

  test('and neither does one whose annotations have not been read yet', () => {
    // The state this predicate exists for. "Not known yet" is not a reason to
    // claim uncommitted changes, and there is no third answer it could give:
    // the banner is drawn on an affirmative reading and on nothing else.
    expect(dirtyWorktreeBannerVisible({ mode: 'local', dirty: undefined })).toBe(false)
  })

  test('a pull request never gets it, however dirty the machine is', () => {
    // A review mediated elsewhere is built from what was pushed, so a working
    // tree on this machine bears on nothing in it. Asserted across all three
    // readings of the flag, because a gate that tested only the flag would pass
    // the first of them.
    expect(dirtyWorktreeBannerVisible({ mode: 'github', dirty: true })).toBe(false)
    expect(dirtyWorktreeBannerVisible({ mode: 'github', dirty: false })).toBe(false)
    expect(dirtyWorktreeBannerVisible({ mode: 'github', dirty: undefined })).toBe(false)
  })
})

describe('what the banner puts on the screen', () => {
  test('a branch pair with uncommitted changes is told so, and told what covers it', () => {
    // The control for the three empties below: this component does produce
    // markup from this harness when it has something to say, so their emptiness
    // is a decision rather than a component that draws for nobody.
    //
    // Both halves are asserted — the sentence the copy module owns reaches the
    // markup, AND the rule itself is present as a literal. The first alone
    // would be satisfied by a copy function reduced to empty strings, since
    // every string contains the empty one.
    const html = banner('local', true)
    expect(html).toContain(headline())
    expect(html).toContain('covers committed content only')
  })

  test('and a clean one draws no element at all', () => {
    // `toBe('')`, not "does not contain the warning": a banner that returned an
    // empty wrapper would pass the weaker assertion while every clean review
    // carried a permanent gap under its header.
    expect(banner('local', false)).toBe('')
  })

  test('and one whose annotations have not arrived draws no element either', () => {
    // The flicker this component is shaped to make impossible. A loading branch
    // that drew anything — a skeleton, an optimistic "clean" line, an empty box
    // holding the space — would put an uncommitted-changes claim, or a gap
    // where one goes, on every review for as long as the read took.
    expect(banner('local', undefined)).toBe('')
  })

  test('and a pull request draws no element whatever the flag says', () => {
    // This one state is held by TWO independent decisions — the predicate
    // refuses it, and the copy module has no sentence for that reading either —
    // so breaking one alone leaves this green while the predicate case above
    // goes red. That is the intended redundancy rather than a gap: the mode
    // read is separately falsifiable one block up, and a banner reaching a
    // mediated review would have to survive both a wrong gate and an invented
    // sentence.
    expect(banner('github', true)).toBe('')
  })
})
