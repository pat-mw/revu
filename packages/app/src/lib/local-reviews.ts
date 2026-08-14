/**
 * Local reviews as the frontend sees them: which listed rows are local, how the
 * inbox splits, what a local row shows where a pull request shows its number,
 * and whether a branch pair is worth sending at all.
 *
 * A local review is a review of a branch pair that has no pull request behind
 * it. It has no GitHub number, so it takes a synthetic one from a reserved high
 * band — which is precisely what lets every `/pr/:n` route, every path parser
 * and every cache key stay a plain integer and stay unchanged. The synthetic id
 * is an internal key and **is never rendered**: a local row shows its
 * `base ← head` branch pair where a pull request shows `#347`. `rowIdentity`
 * exists so that rule is a property of a pure function the tests can hold,
 * rather than of a branch buried in a component.
 *
 * ## One call site, on purpose
 *
 * This module holds the ONLY call to the shared `isLocalReviewId` predicate on
 * the reading side of the transport seam. No component, page, view-model or
 * query layer imports that predicate, and none compares a review number to the
 * band's base constant — they ask `isLocal` or `isLocalReviewItem` here,
 * including modules that derive further vocabulary (a review "mode", say) from
 * the same answer. A source-scanning test enforces this and turns the suite red
 * the moment a second such call site appears.
 *
 * A transport adapter is the deliberate exception, not an oversight: it MINTS
 * ids in the band and routes on them, so it implements the boundary rather than
 * reading it, and it sits on the far side of the seam that keeps the UI
 * ignorant of which transport answered.
 *
 * The rule is not tidiness. Where the band begins is a decision about identity
 * that has to be revisable in one place: a second reader is a second opinion
 * that will be missed when the first one moves, and the failure it produces — a
 * review that is local to one surface and remote to another — is silent
 * everywhere except the one screen that renders the id it was never meant to
 * show.
 */
import type { PullListItem, PullSummary } from '@revu/shared'
import { isLocalReviewId, isValidRefName } from '@revu/shared'

/** Whether a review number falls in the reserved local band. */
export const isLocal = (n: number): boolean => isLocalReviewId(n)

/** Whether a listed row is a local review rather than a pull request. */
export const isLocalReviewItem = (item: PullListItem): boolean => isLocal(item.pull.number)

/** The inbox's rows, split by what kind of review each one is. */
export interface InboxPartition {
  local: PullListItem[]
  github: PullListItem[]
}

/**
 * Split listed rows into local reviews and pull requests, preserving the input
 * order within each side so the caller's sort survives the split.
 *
 * Total by construction: every input lands on exactly one side, so the two
 * lengths always sum to the input's and no row can be dropped or shown twice.
 */
export function partitionInbox(items: readonly PullListItem[]): InboxPartition {
  const local: PullListItem[] = []
  const github: PullListItem[] = []
  for (const item of items) {
    if (isLocalReviewItem(item)) local.push(item)
    else github.push(item)
  }
  return { local, github }
}

/** The two short branch names a local review is identified by. */
export interface LocalReviewLabel {
  head: string
  base: string
}

/**
 * The branch pair a local review renders in place of a number. Short display
 * names, exactly as the row carries them — this reads the pair, it does not
 * format it, so a caller is free to draw `base ← head` or anything else.
 */
export function localReviewLabel(pull: PullSummary): LocalReviewLabel {
  return { head: pull.head.ref, base: pull.base.ref }
}

/**
 * What belongs in a row's identity slot, as data rather than as markup: a pull
 * request's number, or a local review's branch pair. A caller renders this and
 * nothing else there, which is what keeps the synthetic id off the screen.
 */
export type RowIdentity =
  | { kind: 'github'; text: string }
  | { kind: 'local'; head: string; base: string }

/** The identity slot for one listed row. */
export function rowIdentity(item: PullListItem): RowIdentity {
  if (isLocalReviewItem(item)) return { kind: 'local', ...localReviewLabel(item.pull) }
  return { kind: 'github', text: `#${item.pull.number}` }
}

/** The two refs a create request is built from, as the picker holds them. */
export interface ReviewBranchPair {
  base: string
  head: string
}

/**
 * Why this branch pair cannot be turned into a review, as a sentence to show
 * the reader — or `null` when nothing is obviously wrong with it.
 *
 * This is a FAST FAIL FOR THE USER, never a security boundary. It runs on
 * whatever the pickers currently hold so a mistake is visible before a request
 * is made; it is not what makes a ref safe to hand to git. The authority is the
 * shared syntactic validator (which this calls, rather than restating its rule
 * table) and, on the server, `git check-ref-format` on the real repository —
 * which alone knows the rules that cannot be checked from the name. Neither of
 * those may be dropped on the grounds that the client already looked.
 */
export function createReviewIssue({ base, head }: ReviewBranchPair): string | null {
  if (base === '') return 'Choose a base branch.'
  if (head === '') return 'Choose a head branch.'
  if (base === head) {
    return `Base and head are both ${base} — a review compares two different branches.`
  }
  return refIssue('base', base) ?? refIssue('head', head) ?? null
}

/**
 * Why one side's ref is unusable. The leading-dash case gets its own sentence
 * because it is the one rejection whose reason is not about spelling: git reads
 * such a name as an option, so it is refused rather than escaped.
 */
function refIssue(side: 'base' | 'head', ref: string): string | null {
  if (ref.startsWith('-')) {
    return `A ${side} branch name cannot start with “-” — git would read it as an option.`
  }
  if (!isValidRefName(ref)) return `“${ref}” is not a usable ${side} branch name.`
  return null
}
