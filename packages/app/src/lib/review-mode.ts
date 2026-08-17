/**
 * Which kind of review is open, derived in exactly one place.
 *
 * A local review reviews a branch pair that has no pull request behind it, but
 * it still carries a positive-integer id taken from a reserved high band — and
 * that is what lets the whole `/pr/:n` route family, every path parser and
 * every cache key stay untouched. The entire remaining variance collapses to
 * this one word: chrome that would otherwise assert a GitHub fact branches on
 * `ReviewMode` and on nothing else.
 *
 * The mode is derived from the app's single reading-side call to the band
 * predicate, which `lib/local-reviews.ts` holds. Never from a re-spelled
 * comparison against the band's base, and never from a second direct call to
 * the shared predicate — not even here. Where the band begins is a decision
 * about identity that has to stay revisable in one place; a second reader is a
 * second opinion that will be missed when the first one moves, and the failure
 * it produces is a review that is local to one surface and remote to another.
 *
 * Inside the review subtree the mode is threaded as a REQUIRED PROP, derived
 * once by the layout and passed down, so no descendant can disagree with its
 * siblings. `useRouteReviewMode` exists for the two consumers that render ABOVE
 * the router — the app shell and the command palette — which have no layout to
 * hand them a prop and can only read the path.
 */
import { useLocation } from 'react-router'
import { isLocal } from './local-reviews'

/** Which kind of review a number, a route or a rendered page is about. */
export type ReviewMode = 'github' | 'local'

/** The mode a review number is in. */
export function reviewMode(n: number): ReviewMode {
  return isLocal(n) ? 'local' : 'github'
}

/**
 * Match `/pr/:n` at the head of a path, returning the review number or null.
 *
 * The digits-only capture is load-bearing rather than incidental: a review with
 * no pull request behind it is identified by a synthetic positive integer
 * precisely so this matcher, and every route and cache key built on it, need no
 * new shape. Widening it to admit non-digits would make paths that open no
 * review look like they open one, which silently breaks the tab-switch key
 * sequences and the palette's current-review group — each reads a null here as
 * "no review is open".
 */
export function matchPrNumber(pathname: string): number | null {
  const m = /^\/pr\/(\d+)(?:\/|$)/.exec(pathname)
  return m ? Number(m[1]) : null
}

/**
 * The mode of the review the current path has open, or null when the path
 * opens no review at all — for chrome that renders above the router and so
 * cannot be handed the mode as a prop.
 */
export function useRouteReviewMode(): ReviewMode | null {
  const { pathname } = useLocation()
  const n = matchPrNumber(pathname)
  return n === null ? null : reviewMode(n)
}

// ————————————————————————————————————————————————————————————————
// Which chrome a review carries — as data, so gates read a table.
// ————————————————————————————————————————————————————————————————

/** One section of a review, named by the path segment that opens it. */
export type ReviewTab = 'description' | 'conversation' | 'files' | 'commits' | 'checks'

/**
 * The tab a review opens on when the path names none, and the tab an omitted
 * one falls back to. Files is where the work is.
 */
const DEFAULT_TAB: ReviewTab = 'files'

/** Every section, in the order the strip draws them. */
const GITHUB_TABS: readonly ReviewTab[] = [
  'description',
  'conversation',
  'files',
  'commits',
  'checks',
]

/**
 * The sections a branch pair has. Checks and Description are absent because
 * nothing behind a local review can fill them: no continuous integration runs
 * against a branch pair, and there is no body someone typed into a form. The
 * screens exist and would render — each one's entire content would be a claim
 * about a service this workspace is not talking to.
 */
const LOCAL_TABS: readonly ReviewTab[] = ['conversation', 'files', 'commits']

/**
 * The sections a review of this kind offers, in draw order.
 *
 * Returned as data rather than decided inside the strip so the omission is a
 * value a test reads, and so the route guard and the tab strip cannot come to
 * different conclusions about the same review.
 */
export function reviewTabs(mode: ReviewMode): readonly ReviewTab[] {
  return mode === 'local' ? LOCAL_TABS : GITHUB_TABS
}

/**
 * Where a request for `tab` should land instead, or null to render it.
 *
 * Omitting a link does not omit its route: every tab path stays typeable and
 * bookmarkable whatever the strip draws, so the sections a review does not
 * offer are answered here rather than left to render. Total over the tab set —
 * a tab the review offers is always rendered, so this cannot quietly flatten a
 * review to one screen.
 */
export function redirectTargetFor(mode: ReviewMode, tab: ReviewTab): string | null {
  return reviewTabs(mode).includes(tab) ? null : DEFAULT_TAB
}

/** One block of the Conversation tab, named for what it holds. */
export type ConversationSection = 'description' | 'timeline' | 'threads'

/** Every block, in the order the tab stacks them down the page. */
const GITHUB_CONVERSATION: readonly ConversationSection[] = [
  'description',
  'timeline',
  'threads',
]

/**
 * The blocks a branch pair's conversation has.
 *
 * The description block is the one that would say something false: it names an
 * author who "opened this pull request" above a body nobody ever typed into a
 * form. The timeline is different — it is fed by issue comments and submitted
 * reviews, and a branch pair accumulates neither, because a review submitted
 * against one is persisted to its own record rather than appended to the
 * snapshot it was read from. So it is inert by construction rather than by
 * policy, and omitting it states that fact instead of relying on it.
 */
const LOCAL_CONVERSATION: readonly ConversationSection[] = ['threads']

/**
 * The blocks the Conversation tab renders for a review of this kind, in stack
 * order.
 *
 * Returned as data for the same reason the tab list is: the page would
 * otherwise carry one inline mode test per block, and three conditionals can
 * disagree with each other in a way one table cannot. It also makes "threads
 * only" a value a test reads, so re-adding the description block to the local
 * path turns a suite red instead of shipping a pull request that does not
 * exist onto a branch.
 */
export function conversationSections(mode: ReviewMode): readonly ConversationSection[] {
  return mode === 'local' ? LOCAL_CONVERSATION : GITHUB_CONVERSATION
}

/** One action the palette offers for the review that is currently open. */
export type PrPaletteCommand =
  | 'files'
  | 'conversation'
  | 'commits'
  | 'checks'
  | 'resync'
  | 'walk-threads'

/**
 * The actions the palette's current-review group offers, in the order it lists
 * them.
 *
 * Pure and separate from the palette because the palette is a dialog: it
 * renders through a portal and serializes to nothing, so "the Checks command is
 * not offered on a local review" is assertable here and nowhere in its markup.
 */
export function prPaletteCommands(mode: ReviewMode): PrPaletteCommand[] {
  const commands: PrPaletteCommand[] = ['files', 'conversation', 'commits']
  if (reviewTabs(mode).includes('checks')) commands.push('checks')
  commands.push('resync', 'walk-threads')
  return commands
}

/** What the verdict picker knows when it decides whether to lock. */
export interface SelfReviewLockInput {
  mode: ReviewMode
  /** Whether the review's list entry says this identity may approve it. */
  canApprove: boolean
}

/**
 * Whether the verdict picker locks its approving segments and offers the
 * explanation behind them.
 *
 * The lock exists for one situation: a pull request opened by the single shared
 * identity every contractor here writes through cannot be approved by that same
 * identity, so two of the three segments would silently do nothing. The
 * explanation behind the lock says who can approve it instead, and where. None
 * of that has a counterpart on a review of two local branches — nothing was
 * opened anywhere, there is no shared identity in the way, and there is no site
 * to send anyone to — so the segments are simply live.
 *
 * The approval flag alone is not a safe gate, and the reason is a DEFAULT
 * rather than a value: it is read off the review's list entry and falls back to
 * "may not approve" whenever that entry is missing, which is every review's
 * state on first paint and any review's state for good after a list error. A
 * lock gated on the flag alone therefore shows the mediated-pull-request
 * explanation on a branch pair no matter what the entry eventually says.
 */
export function showSelfReviewLock({ mode, canApprove }: SelfReviewLockInput): boolean {
  return mode === 'github' && !canApprove
}
