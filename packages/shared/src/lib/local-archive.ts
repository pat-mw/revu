/**
 * When a pull request supersedes a local review.
 *
 * A local review names a branch PAIR inside one repository. Once a pull request
 * exists for that same pair, the review is no longer the place feedback belongs,
 * so it is archived against that pull request's number. Deciding which pull
 * request that is has to be answered identically by the in-browser mock — whose
 * semantics are the specification — and by the daemon, so the comparison lives
 * here, in the package both import, rather than twice.
 *
 * THREE COMPARISONS, ALL REQUIRED, AND NEVER A SHA. Repository identity, head
 * branch, base branch. SHAs are deliberately not compared: a review and a pull
 * request over the same branches are the same work whether or not either side
 * has advanced, and a SHA comparison would un-match on every new commit.
 *
 * ONLY AN OPEN PULL REQUEST SUPERSEDES. A closed pull request on a reused branch
 * name must not archive a review that has nothing to do with it. Archival itself
 * is sticky — a pull request closed after detection leaves the review archived —
 * but that stickiness is the store's, not this predicate's.
 */
import type { PullSummary } from '../api/types'

/** The prefix a local branch ref carries. */
const HEADS_PREFIX = 'refs/heads/'

/** The prefix a remote-tracking ref carries, ahead of its remote's name. */
const REMOTES_PREFIX = 'refs/remotes/'

/**
 * The bare branch name a ref denotes: `refs/heads/feature/x` and
 * `refs/remotes/origin/feature/x` both yield `feature/x`, and a name that is
 * already bare is returned unchanged. A ref under neither prefix (a tag, say)
 * has no branch name and is returned as-is, which no branch can equal.
 *
 * DISTINCT FROM THE DISPLAY FORM, which keeps a remote-tracking ref's remote
 * (`origin/main`) because that is what tells it apart from the local branch of
 * the same name. Here the remote must go: the comparison is against a pull
 * request, and a pull request names the branch on the repository, with no
 * remote in the name at all.
 */
export function bareBranchName(ref: string): string {
  if (ref.startsWith(HEADS_PREFIX)) return ref.slice(HEADS_PREFIX.length)
  if (ref.startsWith(REMOTES_PREFIX)) {
    const withoutPrefix = ref.slice(REMOTES_PREFIX.length)
    const firstSlash = withoutPrefix.indexOf('/')
    return firstSlash === -1 ? withoutPrefix : withoutPrefix.slice(firstSlash + 1)
  }
  return ref
}

/** The parts of a local review the predicate reads: its repository and its pair. */
export interface ArchivableLocalReview {
  /** The repository identity the review is scoped to, `owner/name`-shaped. */
  repo: string
  baseRef: string
  headRef: string
}

/**
 * Whether `pull` supersedes `review`: an open pull request on the same
 * repository, from the same head branch onto the same base branch.
 *
 * A FORK IS REJECTED HERE AS WELL AS BY THE QUERY THAT FOUND IT. The head
 * repository comparison is the only thing separating a fork's identically named
 * branch from the branch under review, and a caller that widened its query would
 * otherwise archive a review against a stranger's pull request.
 *
 * A BLANK ON EITHER SIDE NEVER MATCHES, for any of the three values. Blank is
 * what an absent field maps to — a pull request whose head repository has been
 * deleted reports `full_name: ''` — and what a workspace with no origin can hold
 * for a repository identity. Two absences are not an agreement, and letting them
 * compare equal would archive every such review against the first pull request
 * listed.
 */
export function supersedes(review: ArchivableLocalReview, pull: PullSummary): boolean {
  if (pull.state !== 'open') return false

  const headRepo = pull.head.repo.full_name
  if (review.repo === '' || headRepo === '' || headRepo !== review.repo) return false

  const headRef = bareBranchName(review.headRef)
  const pullHeadRef = bareBranchName(pull.head.ref)
  if (headRef === '' || pullHeadRef === '' || pullHeadRef !== headRef) return false

  const baseRef = bareBranchName(review.baseRef)
  const pullBaseRef = bareBranchName(pull.base.ref)
  if (baseRef === '' || pullBaseRef === '' || pullBaseRef !== baseRef) return false

  return true
}

/**
 * The pull request that supersedes `review`, or null when none does.
 *
 * The LOWEST number wins when several match, so two runs over the same list
 * archive against the same pull request whatever order the listing arrived in.
 * Several open pull requests over one branch pair is unusual but reachable, and
 * an undefined choice between them would make the archived number depend on
 * GitHub's sort order.
 */
export function supersedingPull(
  review: ArchivableLocalReview,
  pulls: readonly PullSummary[],
): PullSummary | null {
  let winner: PullSummary | null = null
  for (const candidate of pulls) {
    if (!supersedes(review, candidate)) continue
    if (winner === null || candidate.number < winner.number) winner = candidate
  }
  return winner
}

/**
 * The one sentence every transport answers when a write reaches an archived
 * local review. `submitReview` returns it as the reason of its `forbidden`
 * result; the other write verbs carry it as the message of a `forbidden`
 * error. It names the pull request that superseded the review and the branch
 * pair in bare form, says the review is read-only, and states that nothing in
 * the review reached that pull request — the fact a reader is most likely to
 * doubt at that moment. It deliberately shares no wording with the
 * self-review refusal, which is about who may approve, not about whether the
 * review still accepts writes.
 */
export function archivedReviewRefusal(review: {
  archivedPr: number
  baseRef: string
  headRef: string
}): string {
  const base = bareBranchName(review.baseRef)
  const head = bareBranchName(review.headRef)
  return (
    `This local review of ${base} \u2190 ${head} is archived: pull request ` +
    `#${review.archivedPr} now covers the same branches, so it is read-only. ` +
    `Nothing in it was sent to that pull request.`
  )
}
