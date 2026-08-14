/**
 * How the inbox sorts the rows it was handed.
 *
 * The inbox is a workspace tool for someone with a job today, not a generic
 * review list, so the derivation is intent-ordered: what is waiting on you,
 * what you owe a review, what you left half-written, and everything else. A
 * review can qualify for more than one intent bucket and appears in each; the
 * catch-all takes only what no earlier bucket claimed, so nothing is listed
 * twice there and nothing is dropped.
 *
 * Kept pure and out of the component on purpose. Which rows land in which
 * section — and in what order the sections come — is the part of the screen
 * worth holding assertions against, and a derivation that lives inside a hook
 * can only be checked by rendering.
 */
import type { PullListItem, ReviewDraft } from '@revu/shared'
import { parseCommentIdentity } from '@revu/shared'
import { partitionInbox, rowIdentity } from './local-reviews'
import { buildPullTree } from './pull-tree'
import type { PullTreeRoot } from './pull-tree'

/** A row as it will render, carrying the section it belongs to and any draft. */
export interface InboxRow {
  item: PullListItem
  draft?: ReviewDraft | null
}

export type SectionId = 'local' | 'waiting' | 'review' | 'drafts' | 'everything'

export interface Section {
  id: SectionId
  title: string
  rows: InboxRow[]
}

/**
 * Case-insensitive match over what a row is called: its title, its identity
 * slot, its author's display name, and the two branches it compares.
 *
 * The branch pair is searchable for every row, not only for the rows that need
 * it. Some rows have nothing else usable — a review with no pull request behind
 * it never shows a number, and its author is a stand-in for the workspace
 * rather than a person, so the only thing left is a title the reader chose and
 * may well have written in different words from the branch. But narrowing the
 * widening to those rows would mean the filter box searched different fields
 * depending on which row it was looking at, which is harder to explain than
 * "it searches the branch names" and no easier to predict.
 *
 * The NUMBER is the one field that does narrow, and for the opposite reason: it
 * is searched exactly where it is shown. A local review's number is a synthetic
 * key drawn nowhere, so a filter that matched it would hand the reader a hit
 * they cannot account for from anything on the screen — a row found by a string
 * it does not contain. Taking the token from the identity slot rather than from
 * the number directly is what keeps the two answers the same one.
 */
export function matchesFilter(
  item: PullListItem,
  needle: string,
  botLogin: string,
): boolean {
  if (!needle) return true
  const { identity } = parseCommentIdentity(
    {
      user: item.pull.user,
      body: item.pull.body ?? '',
    },
    botLogin,
  )
  const authorName =
    identity.kind === 'human' ? identity.name : item.pull.user.login
  const slot = rowIdentity(item)
  // A local slot's own text is the branch pair, which the haystack already
  // carries below — so the local arm contributes nothing rather than repeating
  // it, and the number never reaches the string at all.
  const numberToken = slot.kind === 'github' ? slot.text : ''
  const haystack =
    `${item.pull.title} ${numberToken} ${authorName} ${item.pull.head.ref} ${item.pull.base.ref}`.toLowerCase()
  return haystack.includes(needle)
}

/**
 * Whether the keyboard column is under something and must not act.
 *
 * The inbox's bare `j` / `k` / `enter` are global bindings, and the guard that
 * makes typed keys inert only exempts real text controls — a focused button, or
 * the body of a modal sitting over the inbox, is none of those. So a key press
 * meant for whatever is on top would otherwise also move the column behind it,
 * or navigate away from the screen the reader is looking at.
 */
export interface ColumnBlocked {
  /** Something is over the inbox, so its keys decide nothing. */
  blocked: boolean
}

/**
 * Where `enter` on the focused row goes, or `null` when it goes nowhere.
 *
 * The decision is data rather than a branch inside a handler, so that "the
 * column is inert while something covers it" is a property that holds on its
 * own. The registration that stops these keys from firing at all is the first
 * line of defence and cannot be observed without a renderer; this is the one
 * that can, and it stands even if that registration is later dropped.
 *
 * A held focus index can outlive the rows it pointed at — a filter narrowing
 * the column is enough — so an index outside the column is a miss rather than
 * an error.
 */
export function enterTarget(
  rows: readonly InboxRow[],
  index: number,
  { blocked }: ColumnBlocked,
): string | null {
  if (blocked) return null
  const row = index >= 0 && index < rows.length ? rows[index] : undefined
  return row ? `/pr/${row.item.pull.number}` : null
}

/**
 * Where the focus lands after a `j` / `k` step, clamped to the column.
 *
 * Blocked, the focus is exactly where it was: not clamped, not reset — a
 * reader who dismisses whatever is on top finds the column as they left it.
 * Otherwise the ends hold rather than wrap, so a long press stops at the last
 * row instead of cycling past it, and an empty column parks at the top.
 */
export function nextFocusIndex(
  index: number,
  delta: number,
  count: number,
  { blocked }: ColumnBlocked,
): number {
  if (blocked) return index
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, index + delta))
}

/**
 * The rows either arrangement is allowed to draw from.
 *
 * Shared by both on purpose. The arrangements are two ways of grouping one set
 * of reviews, never two selections of which reviews count — a reader switching
 * between them is re-sorting the screen, not re-querying it, and a row that
 * appeared in one and not the other would make the control a filter in
 * disguise.
 */
function visibleRows(
  items: readonly PullListItem[],
  needle: string,
  botLogin: string,
): PullListItem[] {
  return items.filter(
    (it) => it.pull.state === 'open' && matchesFilter(it, needle, botLogin),
  )
}

/** Everything the tree arrangement reads. */
export interface InboxTreeInput {
  /** Every listed row, of any state; only the open ones are arranged. */
  items: readonly PullListItem[]
  /** The filter box's contents, already trimmed and lowercased. */
  needle: string
  /** The broker bot's login, so a smuggled author name is read back out. */
  botLogin: string
}

/**
 * The other arrangement: pull requests grouped by what each one is stacked on.
 *
 * Local reviews are held back from it. A stack is a chain of pull requests each
 * opened against the one below it, and a review of two branches that were never
 * pushed is in no such chain — nothing points at it and it points at nothing.
 *
 * Holding them back is not tidiness. Parentage is read from branch names and
 * nothing else, so a pull request whose base branch happens to be a local
 * review's head branch would be drawn as stacked on it: a real pull request
 * filed under something that exists on one machine and nowhere else. The tree
 * builder is right to know nothing about where a review came from, so the rows
 * it should not see are taken out before it sees them rather than by teaching
 * it a distinction that is not its business.
 *
 * Held back is not dropped. The caller draws them as their own group, so the
 * two arrangements account for the same reviews and the control that switches
 * between them stays a re-sort rather than a filter.
 */
export function buildInboxTree({
  items,
  needle,
  botLogin,
}: InboxTreeInput): PullTreeRoot[] {
  return buildPullTree(partitionInbox(visibleRows(items, needle, botLogin)).github)
}

/** Everything the derivation reads. Nothing here is fetched — it is all in hand. */
export interface InboxSectionsInput {
  /** Every listed row, of any state; only the open ones are sorted. */
  items: readonly PullListItem[]
  /** The filter box's contents, already trimmed and lowercased. */
  needle: string
  /** The human driving the workspace, whose intent the ordering is about. */
  humanId: string
  /** The broker bot's login, so a smuggled author name is read back out. */
  botLogin: string
  /** Review number → the draft left on it, when one has pending comments. */
  draftByNumber: ReadonlyMap<number, ReviewDraft>
  /**
   * Whether this reader holds any local review at all, including ones no row
   * here can represent.
   *
   * A separate input rather than something read off `items`, and deliberately
   * so. The row source lists every local review whatever its state; callers
   * filter it to open reviews, and this function is one of those callers — so
   * a reader whose local reviews are all closed has no row for any of them
   * while still having them. Whether a closed local review reaches the row
   * source at all is a question this module must not depend on either way, and
   * a flag read alongside the local-only annotations is true under either
   * answer.
   *
   * It is a boolean about EXISTENCE and nothing more: no row, title, branch
   * pair or review metadata is ever taken from wherever it came from, so a
   * review is still described by exactly one source.
   */
  hasLocalReviews: boolean
}

/**
 * Sort the listed rows into the sections the inbox renders, in render order.
 *
 * Closed reviews are dropped here rather than by the caller, so "the inbox
 * shows open work" is a property of this function and not an assumption about
 * a component.
 *
 * Local reviews are pulled out before the intent buckets see them and given
 * their own section, so one is listed exactly once. Where that section sits
 * says what it is: work in hand goes to the top, above the pull requests;
 * with nothing open in it, it drops below every other section, present as a
 * reminder rather than as something to act on; and a reader who has never made
 * one is not shown a section about a feature they are not using.
 */
export function buildInboxSections({
  items,
  needle,
  humanId,
  botLogin,
  draftByNumber,
  hasLocalReviews,
}: InboxSectionsInput): Section[] {
  const filtered = visibleRows(items, needle, botLogin)

  // Every intent bucket derives from the pull requests alone. Excluding local
  // reviews only from the catch-all would not be enough: the catch-all takes
  // what no earlier bucket claimed, so a local review claimed by one of those
  // would be listed twice and dropped from the catch-all that was supposed to
  // stop it.
  const { local, github } = partitionInbox(filtered)

  const waiting = github.filter(
    (it) => it.broker.authorHumanId === humanId && it.broker.unresolvedThreads > 0,
  )
  const toReview = github.filter(
    (it) =>
      it.broker.authorHumanId !== humanId &&
      it.broker.assignedReviewerHumanIds.includes(humanId),
  )
  const drafts = github.filter((it) => draftByNumber.has(it.pull.number))

  // "Everything else" is what none of the intent buckets claimed. A PR can be
  // both a draft-in-progress and something you owe a review; it appears in
  // every bucket it qualifies for but is excluded from the catch-all once any
  // earlier bucket named it.
  const claimed = new Set<number>()
  for (const it of [...waiting, ...toReview, ...drafts]) {
    claimed.add(it.pull.number)
  }
  const everything = github.filter((it) => !claimed.has(it.pull.number))

  const toRow = (it: PullListItem): InboxRow => ({
    item: it,
    draft: draftByNumber.get(it.pull.number) ?? null,
  })

  const pullRequestSections: Section[] = [
    { id: 'waiting', title: 'Waiting on you', rows: waiting.map(toRow) },
    { id: 'review', title: 'To review', rows: toReview.map(toRow) },
    { id: 'drafts', title: 'Drafts in progress', rows: drafts.map(toRow) },
    { id: 'everything', title: 'Everything else', rows: everything.map(toRow) },
  ]

  const localSection: Section = {
    id: 'local',
    title: 'Local reviews',
    rows: local.map(toRow),
  }

  // Rows outrank the flag. The two arrive from different reads and can
  // disagree while one is still in flight, and suppressing the section on a
  // flag that has not caught up would drop a row that was handed over.
  if (local.length > 0) return [localSection, ...pullRequestSections]
  if (hasLocalReviews) return [...pullRequestSections, localSection]
  return pullRequestSections
}
