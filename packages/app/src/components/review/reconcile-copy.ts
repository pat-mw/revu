import type { CommitInfo } from '@revu/shared'
import { shortSha } from '@/lib/time'

/**
 * Whether the branch was rewritten out from under the draft — a rebase, an
 * amend, or any force-push that REPLACED the commits instead of adding to them.
 *
 * `commits` is the whole base…head compare, not the reconcile report's
 * `newCommits`, and the distinction is the entire correctness of this function.
 * `newCommits` is by construction the slice AFTER the draft head, so the draft
 * head is never a member of it — a membership test over that list would return
 * "rewritten" for every ordinary fast-forward as well, which is every case.
 * Asked of the FULL compare the test is exact: the head the draft's anchors
 * were captured against is either still somewhere in the range, or it is gone,
 * and gone means every commit now in the range carries a SHA the draft never
 * saw.
 *
 * An EMPTY list answers `true`, and that is the honest answer rather than an
 * edge case slipped past: an empty compare really does not contain the draft
 * head. It is not the same as the question being unanswerable — a compare that
 * has not loaded yet is null, which this function refuses to accept at all so
 * it can never be pushed into inventing a verdict. `compareChangeLine` owns
 * that degradation.
 */
export function isRewritten(commits: CommitInfo[], draftHeadSha: string): boolean {
  return !commits.some((commit) => commit.sha === draftHeadSha)
}

/** Everything the compare-change line reads. */
export interface CompareChange {
  /** The head the draft's anchors were captured against. */
  draftHeadSha: string
  /** The head the branch is on now. */
  currentHeadSha: string
  /**
   * The full base…head compare — every commit in the range, in order — or null
   * when it has not been loaded yet.
   *
   * Carried alongside `newCommits` rather than derived from it because the two
   * lists answer different questions and neither can stand in for the other.
   * This one says WHETHER the draft's head still exists in the range, which is
   * the rewrite test. `newCommits` says HOW MANY commits the human is being
   * asked to reconcile against. A rewrite makes the second list the whole of
   * the first, so a line built from `newCommits` alone can count correctly and
   * still describe the wrong event.
   *
   * Nullable because the snapshot behind it is a query result that is absent
   * while it settles. "Not loaded" is NOT "the draft head is missing": a line
   * that read the two the same way would accuse the branch of a rewrite for as
   * long as a fetch took, on every reconcile.
   */
  commits: CommitInfo[] | null | undefined
  /**
   * The commits this reconcile is against — the slice of the compare after the
   * draft head, or the whole compare when that head is gone.
   */
  newCommits: CommitInfo[]
}

/**
 * The line under the reconcile dialog's title: which head the draft was written
 * against, which one it is being moved to, and what happened in between.
 *
 * Two phrasings, because there are two genuinely different events and counting
 * them the same way tells a lie in one of them. Commits landing ON TOP of the
 * draft's head are new work, and "N new commits" is exactly right. A REWRITE
 * replaces the head the draft was written against, which leaves every commit in
 * the range unrecognized — so the count is the size of the whole compare, and
 * calling ten rewritten commits "10 new commits" reports ten pieces of new work
 * where there may be none. The same ten commits under new SHAs is a different
 * thing to be told, and it is the thing that explains why the anchors moved.
 *
 * Falls back to the plain count in the two cases where a rewrite cannot be
 * claimed honestly:
 *
 * - The compare has not loaded. Unknown is not an accusation.
 * - The compare is EMPTY, so there are no commits to have been rewritten. Head
 *   unchanged with an advanced base reaches exactly this state, and the commit
 *   list beneath this line already explains it.
 */
export function compareChangeLine({
  draftHeadSha,
  currentHeadSha,
  commits,
  newCommits,
}: CompareChange): string {
  const range = `${shortSha(draftHeadSha)} → ${shortSha(currentHeadSha)}`
  const count = newCommits.length
  const known = commits !== null && commits !== undefined
  if (known && count > 0 && isRewritten(commits, draftHeadSha)) {
    const noun = count === 1 ? 'commit' : 'commits'
    const shas = count === 1 ? 'a new SHA' : 'all new SHAs'
    return `${range} · the branch was rewritten — ${count} ${noun}, ${shas}`
  }
  return `${range} · ${count} new ${count === 1 ? 'commit' : 'commits'}`
}
