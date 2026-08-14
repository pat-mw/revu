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
import { conversationEmptyCopy } from './mode-copy'
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
