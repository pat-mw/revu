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
