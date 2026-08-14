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
import { partitionInbox } from './local-reviews'

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

/** Case-insensitive match over a PR's title, number, and author display name. */
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
  const haystack = `${item.pull.title} #${item.pull.number} ${authorName}`.toLowerCase()
  return haystack.includes(needle)
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
  const open = items.filter((it) => it.pull.state === 'open')
  const filtered = open.filter((it) => matchesFilter(it, needle, botLogin))

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
