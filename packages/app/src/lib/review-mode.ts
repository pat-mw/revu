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
 * ## Three ways to reach the answer, chosen by what the caller already holds
 *
 * Most callers hold the review's number already — a route param, a listed row,
 * a query key — and simply call `reviewMode` with it. That is deliberately not
 * routed through a prop: a number a module is already holding is a smaller seam
 * than a prop every component between the layout and that module would have to
 * thread, and every one of those calls resolves through the same single reading
 * of the band, so they cannot disagree.
 *
 * A component that draws chrome for a review whose number it was never handed
 * takes the mode as a REQUIRED PROP instead. Required rather than defaulted,
 * because the alternative is a call site that never thought about the question
 * answering it by accident: a missing prop is then a compile error, though a
 * WRONG one is not, which is why the call sites that pass it are pinned to the
 * expression they derive it from.
 *
 * `useRouteReviewMode` is the third way and the narrowest. It reads the mode
 * off the current path, for a screen rendered under the router that is handed
 * neither the number nor the mode. Nothing above the router uses it: the chrome
 * that renders there holds the path itself and matches the number out of it
 * with `matchPrNumber`, which is the same derivation one step earlier.
 */
import { useLocation } from 'react-router'
import { isLocal } from './local-reviews'
// A type, and only a type: the state vocabulary is defined beside the chip
// that words it, and importing the shape here keeps one spelling of it. The
// import is erased, so the modules stay a one-way dependency at runtime.
import type { ReviewState } from './mode-copy'

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
 * opens no review at all — for a screen that is handed neither the review's
 * number nor its mode and can only ask where it is.
 *
 * The null is a real answer and not a degenerate one: a caller that renders
 * whether or not a review is open needs "none is" back rather than a guess, and
 * folding it into either mode would have a screen off the review routes
 * claiming to know which kind of review it is showing.
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

/**
 * What the archived gates read: which kind of review it is, and the state its
 * listed row reports.
 *
 * The state is `undefined` while that row has not been read — every review's
 * state on first paint, and any review's state for good after a list error.
 * Each gate below decides that case for itself rather than sharing an answer,
 * because the cost of guessing wrong is not the same for all of them.
 */
export interface ReviewArchivedInput {
  mode: ReviewMode
  /**
   * The state on the review's row. Typed as the header's three-way reading so
   * either a row's own `open`/`closed` or a derived state can be passed; the
   * type is imported for its shape alone and nothing at runtime crosses back.
   */
  state: ReviewState | undefined
}

/**
 * Whether this review has been superseded and is now read-only.
 *
 * A review of two local branches ends exactly one way: a pull request appears
 * covering the same branch pair, and the review is archived rather than
 * deleted — frozen at its last sync, every thread and draft kept. Its row
 * reports that as a closed state, which is the same word a pull request uses
 * for something else entirely, so the mode is half the question and not a
 * formality.
 *
 * "Not known yet" is not evidence of supersession, so an unread row reads as
 * live. Nothing here is a security boundary: the four write verbs are refused
 * where the review is held, and this decides what the screen SAYS.
 */
export function reviewArchived({ mode, state }: ReviewArchivedInput): boolean {
  return mode === 'local' && state === 'closed'
}

/**
 * Whether the review bar withholds every way of starting or sending a review.
 *
 * The same truth as `reviewArchived` today, under its own name because the two
 * answer different questions and can stop agreeing: one is a fact about the
 * review, the other is what a control does about it. Folding them into one
 * gate would mean the first surface that needs to draw an archived review with
 * some control still live has to unpick which of the two meanings each call
 * site wanted.
 *
 * An unread row leaves the controls up. A composer that vanished on every
 * first paint would be a worse screen than one offered on a review that then
 * refuses the write — and the refusal at the far end is what makes the
 * permissive reading safe rather than optimistic.
 */
export function reviewComposerHidden({ mode, state }: ReviewArchivedInput): boolean {
  return reviewArchived({ mode, state })
}

/** What a row knows when it decides whether to name what superseded it. */
export interface SupersededBadgeInput {
  mode: ReviewMode
  /**
   * The pull request that came to cover this review's branch pair, `null` while
   * it is live, and `undefined` while the annotations carrying it are unread.
   */
  archivedPr: number | null | undefined
}

/**
 * Whether a row names the pull request that superseded it.
 *
 * The mode is checked as well as the number, and that is the load-bearing
 * half: the annotation this reads is local-only, so a pull request should
 * never carry one — and a gate that trusted the number alone would start
 * labelling pull requests as superseded the moment anything upstream began
 * sending that field.
 *
 * Written as a type predicate so the one state it admits carries its number
 * out to whatever renders it, rather than leaving a cast behind that could
 * outlive the check it came from.
 */
export function supersededBadgeShown(
  input: SupersededBadgeInput,
): input is SupersededBadgeInput & { archivedPr: number } {
  return input.mode === 'local' && typeof input.archivedPr === 'number'
}

/** What the topbar knows about the shared read budget when it decides. */
export interface RateChipInput {
  /**
   * Whether this workspace has a shared read budget at all: `true` once one has
   * been read, `false` once the read has come back saying there is none, and
   * `null` while it has come back with neither.
   */
  rateAvailable: boolean | null
}

/**
 * Whether the topbar draws the shared-budget chip at all.
 *
 * The budget is a property of the WORKSPACE, not of whichever review happens to
 * be open: it is read once, globally, with no review to scope it to, and a
 * workspace wired to no upstream service has none to report on any screen. So
 * the chip is not suppressed while a branch pair is open and restored when a
 * pull request is — it is either a thing this workspace has or it is not.
 *
 * The answer must be OMISSION rather than a hidden or emptied chip, and that is
 * the whole reason this is a gate instead of a style. The chip stands in for an
 * unresolved read with a shimmer; a workspace that will never resolve one would
 * shimmer in its topbar for as long as it stayed open, which reads as a load
 * that never finishes rather than as a budget that does not exist.
 *
 * Which way the undecided answer falls is the other half, and it is why the
 * input is three-valued rather than a boolean. A read still in flight is not
 * evidence of absence, so it keeps the chip's place and its shimmer; only a
 * read that has come back with nothing takes the chip away. Answering "no"
 * while the question is open would blink the chip out of every topbar on every
 * load and back in a moment later.
 */
export function showRateChip({ rateAvailable }: RateChipInput): boolean {
  return rateAvailable !== false
}
