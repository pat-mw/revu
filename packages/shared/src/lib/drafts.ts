/**
 * The one definition of a draft that holds something a human wrote.
 *
 * Every draft-preserving rule in this product ("drafts survive everything")
 * turns on this question, and the question has one answer in one place because
 * two answers are one future divergence: the in-browser adapter that is the
 * contract's oracle and the daemon transport that must match it both import
 * this and nothing else decides it.
 */
import type { ReviewDraft } from '../api/types'

/**
 * Whether a draft carries user-written text: at least one pending comment, or a
 * body with any character in it.
 *
 * The threshold is deliberately zero characters, not "non-blank". A body a
 * human typed a single newline into is still theirs to discard, and the cost of
 * refusing on it is one explicit discard, whereas the cost of treating it as
 * empty is text destroyed without a word. The one shape that MUST come back
 * `false` is the draft an editor creates on its own the moment a review is
 * opened — an empty body and no comments — because a check that counted that
 * as text would make every review a human had merely looked at undeletable.
 */
export function draftHoldsText(draft: Pick<ReviewDraft, 'body' | 'comments'>): boolean {
  return draft.comments.length > 0 || draft.body.length > 0
}
