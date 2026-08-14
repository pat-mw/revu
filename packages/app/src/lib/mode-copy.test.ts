/**
 * The chrome's per-mode copy, asserted by calling it.
 *
 * Every case here reads a string straight out of the module rather than out of
 * rendered markup, which is the whole reason the module exists: much of this
 * copy lands in a tooltip, a popover or a dialog body, all of which Radix
 * renders through a portal and static rendering therefore drops entirely. A
 * `not.toMatch` written against that markup passes vacuously.
 *
 * Absences get one test body each. Two `not.toMatch` assertions in one body
 * abort at the first, so the second is never independently falsifiable and its
 * control only looks like it bites.
 */
import { describe, expect, test } from 'bun:test'
import {
  authorBannerCopy,
  conversationEmptyCopy,
  notFoundCopy,
  stateChipCopy,
} from './mode-copy'
import type { ReviewMode } from './review-mode'

/**
 * Every line of the empty state as one string, so a field added to the copy
 * later is swept by the assertions below without editing them.
 */
function emptyStateText(mode: ReviewMode): string {
  return Object.values(conversationEmptyCopy(mode)).join(' ')
}

describe('the conversation tab with nothing on it yet', () => {
  test('a branch pair is invited to comment, and told where', () => {
    // An empty state is an invitation, not a shrug: without a next action a
    // later sweep could reduce this to a bare noun and still satisfy both
    // absences below.
    expect(emptyStateText('local')).toMatch(/files/i)
  })

  test('and is not told it has a pull request', () => {
    expect(emptyStateText('local')).not.toMatch(/pull request/i)
  })

  test('and is not told anything about github', () => {
    expect(emptyStateText('local')).not.toMatch(/github/i)
  })

  test('each kind of review gets its own sentence', () => {
    // The control for the three assertions above. Today's pull-request copy
    // already happens to name neither banned word, so a copy function that
    // ignored its argument would satisfy all three and prove nothing. Pinning
    // both titles is what makes them bite — and pins the sentence a reader
    // actually sees, which is the point of keeping copy in a module at all.
    expect(conversationEmptyCopy('local').title).toBe('No comments on this branch yet')
    expect(conversationEmptyCopy('github').title).toBe('No discussion yet')
  })
})

/** A review key from the reserved band, spelled out so a search can find it whole. */
const LOCAL_KEY = 1_000_000_001

/** Every line of the not-found screen as one string, swept the same way. */
function notFoundText(mode: ReviewMode, review: string | number): string {
  return Object.values(notFoundCopy(mode, review)).join(' ')
}

describe('the screen a review that is not in the list lands on', () => {
  test('a pull request is named by the number that was asked for', () => {
    // The current literal, pinned character for character: this path is
    // reached by a real mistyped pull request number and its wording is not
    // this module's to reword.
    expect(notFoundCopy('github', 415).title).toBe("PR #415 isn't in this installation")
    expect(notFoundCopy('github', 415).hint).toBe(
      'The broker only sees pull requests in repos this GitHub App is installed on.',
    )
  })

  test('a branch pair gets its own two sentences', () => {
    // The control for the four absences below. Both sentences above name an
    // installation and a pull request, so a function that ignored its mode
    // would fail every one of them — but only because these two literals are
    // pinned to be different sentences rather than assumed to be.
    expect(notFoundCopy('local', LOCAL_KEY).title).toBe(
      "This local review isn't in this workspace",
    )
    expect(notFoundCopy('local', LOCAL_KEY).hint).toBe(
      'Reviews of two local branches live only in the workspace that created them — this one was deleted, or was never here.',
    )
  })

  // One absence per test: a runner stops at the first failure in a body, so a
  // pair of them would leave the second never independently falsifiable.
  test('and names no installation, which may not exist', () => {
    expect(notFoundText('local', LOCAL_KEY)).not.toMatch(/installation/i)
  })

  test('and claims no pull request', () => {
    expect(notFoundText('local', LOCAL_KEY)).not.toMatch(/pull request/i)
  })

  test('and points at nothing on github.com', () => {
    expect(notFoundText('local', LOCAL_KEY)).not.toMatch(/github\.com/i)
  })

  test('and never repeats the key it was routed by', () => {
    // Searched whole. Hunting for digits OF the key would collapse to "names
    // no 0 and no 1", which an ordinary branch name trips with nothing leaked.
    expect(notFoundText('local', LOCAL_KEY)).not.toContain(String(LOCAL_KEY))
  })
})

describe('what the state chip says a review is', () => {
  test('a pull request is in the state GitHub calls it', () => {
    expect(stateChipCopy('github', 'open')).toBe('open')
    expect(stateChipCopy('github', 'closed')).toBe('closed')
    expect(stateChipCopy('github', 'merged')).toBe('merged')
  })

  test('a branch pair is in review rather than open', () => {
    // The chip keeps rendering on a branch pair — a review that is still
    // taking comments looks exactly like one that is finished with them if the
    // chip is simply dropped — but "open" is a state a pull request is in.
    expect(stateChipCopy('local', 'open')).toBe('in review')
  })

  test('and is archived once it is no longer taking comments', () => {
    // The word the chip falls back to for a branch pair that has left the open
    // state. There is one way that happens — a pull request now covers the same
    // branch pair — and the surface that explains the supersession extends this
    // function rather than growing a second one beside it.
    expect(stateChipCopy('local', 'closed')).toBe('archived')
    expect(stateChipCopy('local', 'merged')).toBe('archived')
  })
})

/** Every line of the author banner as one string. */
function bannerText(mode: ReviewMode, unresolved: number): string {
  return Object.values(authorBannerCopy(mode, unresolved)).join(' ')
}

describe('the banner over the thread queue', () => {
  test('a pull request tells its author the work is theirs', () => {
    expect(authorBannerCopy('github', 3).lead).toBe('You authored this PR')
  })

  test('and counts what is waiting, singular or plural or none', () => {
    expect(authorBannerCopy('github', 3).waiting).toBe('unresolved threads waiting on you')
    expect(authorBannerCopy('github', 1).waiting).toBe('unresolved thread waiting on you')
    expect(authorBannerCopy('github', 0).waiting).toBe('no unresolved threads — clear')
  })

  test('a branch pair claims no authorship', () => {
    // The control for the two absences below sits in the same fact: the
    // pull-request lead is the sentence carrying the banned words, so its
    // absence here is the suppression and not an empty record.
    expect(authorBannerCopy('local', 3).lead).toBeUndefined()
    expect(authorBannerCopy('local', 3).waiting).toBe('unresolved threads on this branch')
  })

  test('but keeps the trip into the queue, which is the whole point of it', () => {
    // The action survives on a branch pair: it is the only entry to the thread
    // queue anywhere in the header, and walking feedback on your own branch is
    // the flow this kind of review exists for.
    expect(authorBannerCopy('local', 3).action).toBe('Walk threads')
    expect(authorBannerCopy('github', 3).action).toBe('Walk threads')
  })

  test('and mentions no pull request', () => {
    expect(bannerText('local', 3)).not.toMatch(/pull request/i)
  })

  test('and does not abbreviate one either', () => {
    expect(bannerText('local', 3)).not.toMatch(/\bPR\b/)
  })
})
