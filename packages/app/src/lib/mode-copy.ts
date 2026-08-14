/**
 * The sentences the chrome says, where they differ by the kind of review.
 *
 * A review of two local branches has no pull request behind it, so a good deal
 * of the app's copy — written when every review was one — would assert a fact
 * that is not true of it. The wording is kept here rather than inline in the
 * components for the reason the review error copy already is: a string with one
 * source of truth is a string a component renders and a test pins, and the two
 * cannot drift.
 *
 * ## Why a module and not just careful components
 *
 * Much of this copy never reaches markup a test can read. Tooltip bodies,
 * popover bodies and dialog bodies are rendered through a portal, and a portal
 * has no target during static rendering — so a closed tooltip serialises as its
 * trigger and nothing else. An assertion that a portalled sentence does NOT
 * name a pull request, written against that markup, passes without ever having
 * seen the sentence. Calling the function directly is the only form of that
 * assertion which can fail, and it is the reason even one-line strings live
 * here.
 *
 * ## The shape every export takes
 *
 * A pure function of the review's mode, plus whatever it interpolates, that
 * returns strings — a bare one where the copy is a single sentence, a record of
 * named lines where a component renders several. No JSX, no hooks, and nothing
 * imported from a component: a copy function a test cannot call without a
 * renderer defeats the point of the module.
 */
import type { ReviewMode } from './review-mode'

/** The lines an empty state renders: a heading, a next move, and its control. */
export interface EmptyStateCopy {
  title: string
  /** One line pointing at the next action. */
  hint: string
  /** The label on the control that takes the reader there. */
  action: string
}

/**
 * The Conversation tab with nothing on it yet.
 *
 * Both readings are invitations rather than shrugs — they name where the first
 * comment is written and offer the trip in one click — because an empty
 * conversation is the ordinary state of a review nobody has commented on, not a
 * failure to report. The branch-pair title says branch instead of discussion
 * because on that path this state is the entire page: no description block
 * renders above it to supply the context the shorter heading leans on.
 */
export function conversationEmptyCopy(mode: ReviewMode): EmptyStateCopy {
  const hint = 'Open Files and leave the first comment (c on any line).'
  const action = 'Open files'
  if (mode === 'local') {
    return { title: 'No comments on this branch yet', hint, action }
  }
  return { title: 'No discussion yet', hint, action }
}
