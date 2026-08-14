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

/**
 * The screen a review that is not in the list lands on.
 *
 * Both readings are the same fact — the path names a review this workspace
 * does not hold — but the pull-request one explains it by an installation the
 * app can see through, and a review of two local branches passes through no
 * installation at all: it exists only where it was created. Saying otherwise
 * would send a reader to check a setting that has nothing to do with what went
 * wrong.
 *
 * `review` is the review as the path named it, and it is interpolated on the
 * pull-request path ONLY. A local review is keyed by a synthetic integer that
 * exists so routes and cache keys can stay plain numbers; repeating it back at
 * a reader names nothing they could look up.
 */
export function notFoundCopy(mode: ReviewMode, review: string | number): EmptyStateCopy {
  const action = 'Back to inbox'
  if (mode === 'local') {
    return {
      title: "This local review isn't in this workspace",
      hint: 'Reviews of two local branches live only in the workspace that created them — this one was deleted, or was never here.',
      action,
    }
  }
  return {
    title: `PR #${review} isn't in this installation`,
    hint: 'The broker only sees pull requests in repos this GitHub App is installed on.',
    action,
  }
}

/** Which state a review is in, as the chip in its header reports it. */
export type ReviewState = 'open' | 'closed' | 'merged'

/**
 * The word in the state chip beside a review's title.
 *
 * The chip renders on both kinds of review: a review still taking comments and
 * one that is finished with them look identical without it. But "open" is a
 * state a pull request is in, and a branch pair has none — it is simply under
 * review until something ends that.
 *
 * The one thing that ends it is a pull request coming to cover the same branch
 * pair, at which point the review is kept and archived rather than deleted.
 * The surface that explains that supersession to a reader extends this
 * function rather than growing a second one beside it, so the header and that
 * surface cannot come to different conclusions about the same review.
 */
export function stateChipCopy(mode: ReviewMode, state: ReviewState): string {
  if (mode === 'local') {
    return state === 'open' ? 'in review' : 'archived'
  }
  // A pull request's chip says what GitHub calls the state, so the word is the
  // state itself.
  return state
}

/** The lines of the banner that leads into the thread queue. */
export interface AuthorBannerCopy {
  /**
   * Whose work the review is, or absent when nothing about the review supports
   * the claim.
   */
  lead?: string
  /** What is waiting, following the count the banner draws in its own element. */
  waiting: string
  /** The label on the control that walks the queue. */
  action: string
}

/**
 * The banner over the thread queue, for a review with `unresolved` threads
 * still open.
 *
 * The action is the same on both paths and deliberately so: it is the only
 * entry to the thread queue anywhere in the header, and walking a reviewer's
 * feedback on your own branch is what a review of two local branches is for.
 *
 * What does not survive is the authorship claim. Every mediated pull request
 * is opened by one shared identity on behalf of a human, and the lead line is
 * the broker-side attribution that says which human — a fact with no local
 * counterpart, because nothing was opened anywhere. So the lead is absent
 * rather than reworded, and the count line names the branch the threads are on
 * instead of the person they are waiting on.
 */
export function authorBannerCopy(mode: ReviewMode, unresolved: number): AuthorBannerCopy {
  const action = 'Walk threads'
  const plural = unresolved === 1 ? '' : 's'
  if (mode === 'local') {
    return {
      waiting:
        unresolved > 0
          ? `unresolved thread${plural} on this branch`
          : 'no unresolved threads — clear',
      action,
    }
  }
  return {
    lead: 'You authored this PR',
    waiting:
      unresolved > 0
        ? `unresolved thread${plural} waiting on you`
        : 'no unresolved threads — clear',
    action,
  }
}
