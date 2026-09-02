/**
 * Detecting the pull request that supersedes a local review, and recording it.
 *
 * A local review exists so that feedback on a branch never reaches the hosted
 * repository. Once a pull request is opened for the same branch pair, the review
 * has been overtaken: it goes read-only against that pull request's number.
 * Nothing is copied anywhere. Detection is a READ of GitHub; archival is a WRITE
 * to the local store; there is no third step, and there is no path from here to
 * a pull request.
 *
 * WHAT THIS MODULE MAY IMPORT IS PART OF ITS CONTRACT. Only `@revu/shared`. The
 * listing seam and the store port below are declared here and satisfied by the
 * caller, so this module names no GitHub client and no store implementation — a
 * structural absence a test asserts by reading this file's own imports, not a
 * convention. The predicate itself lives in the shared package because the
 * in-browser mock, whose semantics are the specification, must reach the same
 * verdict from the same code.
 *
 * A GITHUB FAILURE NEVER FAILS A SYNC. The archive check is an extra a sync does
 * on the way past; a workspace with no origin, no token, or no network still
 * syncs its local reviews. So the seam is optional, its rejection is caught, and
 * the answer in every degraded case is "not archived" — never a thrown error and
 * never a guess.
 *
 * A SERVER THAT NEVER ANSWERS IS ONE OF THOSE FAILURES. Syncing a local review
 * is otherwise entirely local work, so a host that accepts the connection and
 * then says nothing would hold open a call that touches no network at all
 * without this: no rejection ever arrives to be caught. The read therefore
 * carries its own deadline, and expiring it is treated as the rejection that
 * never came.
 */
import type { LocalReviewSummary, PullSummary } from '@revu/shared'
import { bareBranchName, supersedingPull } from '@revu/shared'

/**
 * The one read this module makes of the hosted repository: the open pull
 * requests for a single branch pair, as GitHub lists them.
 *
 * ABSENT-TOLERANT BY DESIGN — a workspace with no origin and no token has no
 * seam to inject, and the detector must be constructible without one.
 *
 * The pair arrives as BARE branch names, because that is what a pull request
 * carries on both of its sides and what GitHub's own `head=owner:branch` filter
 * expects. Qualifying refs is the local store's business and stops here.
 */
export interface SupersedingPullSource {
  /** Open pull requests for one branch pair, as GitHub lists them. */
  listOpenPullsForPair(pair: { headRef: string; baseRef: string }): Promise<PullSummary[]>
}

/**
 * The store, narrowed to the two operations archival needs: record the number,
 * then read back what stands.
 *
 * `markLocalReviewArchived` is WRITE-ONCE. Two syncs racing over one review, or
 * a re-detection after the pull request list changed, must not move a number
 * that a reader has already been shown — so the first number recorded is the
 * one that stays, and the read-back is how this module learns which that was
 * rather than assuming its own write won.
 */
export interface ArchiveStore {
  markLocalReviewArchived(localId: number, prNumber: number): void
  getLocalReview(localId: number): LocalReviewSummary | null
}

/** What one archive check concluded. */
export interface ArchiveDetection {
  /** The pull request the review now stands archived against; null while live. */
  archivedPr: number | null
  /**
   * Whether the listing seam was consulted. Distinguishes "asked, and there is
   * no pull request" from "never asked" — the two collapse into one answer
   * otherwise, and only the first is evidence about the hosted repository.
   */
  requested: boolean
}

export interface LocalArchiveDetector {
  /**
   * Run the check for one review, ahead of its sync. Never throws for a GitHub
   * reason, and never for the one store refusal that is really a disagreement
   * about a number — a `RangeError` from the mark. Every other store failure is
   * a real failure and is left to propagate.
   */
  detect(review: LocalReviewSummary): Promise<ArchiveDetection>
}

export interface LocalArchiveDetectorDeps {
  /** Absent in a workspace with no origin or no credential; then nothing is asked. */
  source?: SupersedingPullSource
  store: ArchiveStore
  /** Where a failed check is reported; defaults to `console.warn`. */
  warn?: (line: string) => void
  /**
   * How long the listing seam is given to answer, in milliseconds; defaults to
   * `DEFAULT_ARCHIVE_DEADLINE_MS`.
   *
   * Injectable so a test can prove the deadline exists in milliseconds instead
   * of in seconds of waiting. A caller with a slow link may raise it; the cost
   * of raising it is the length of time a sync of purely local work can be held
   * open by a host that has stopped answering.
   */
  deadlineMs?: number
}

/**
 * How long the one hosted read is given before the check gives up on it.
 *
 * Long enough that an ordinary listing over a slow link answers well inside it,
 * and short enough that a human waiting on a sync of local work notices a hung
 * host as a pause rather than as a hang.
 */
export const DEFAULT_ARCHIVE_DEADLINE_MS = 10_000

/**
 * The expiry of that deadline, raised as an error so the check's one failure
 * path handles a silent host and a rejecting one identically.
 *
 * The name is what a warning reports, and it is fixed text: the duration is not
 * folded into it, because the warning is written by a sink that has no bound on
 * what it does with the line.
 */
class ArchiveCheckTimeout extends Error {
  constructor() {
    super('the archive check deadline expired')
    this.name = 'ArchiveCheckTimeout'
  }
}

/**
 * `work`, or a rejection once `deadlineMs` has passed.
 *
 * The timer is cleared on BOTH outcomes. An armed timer keeps the process alive
 * until it fires, so a deadline left running behind a fast answer would turn
 * every check into a delay of its own length at exit — and a rejection that
 * arrives after the race has settled is already handled, because the race
 * itself subscribed to both sides.
 */
async function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ArchiveCheckTimeout()), deadlineMs)
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether a repository identity is `owner/name`-shaped: exactly one separator,
 * both halves non-empty.
 *
 * A workspace with no origin records a PATH as its identity, and a path can
 * never equal a pull request's `full_name` — so asking about one spends a
 * request that is guaranteed to answer nothing, and the shape check is what
 * turns that guarantee into silence rather than traffic.
 */
function isOwnerNameShaped(repo: string): boolean {
  const parts = repo.split('/')
  return parts.length === 2 && parts[0] !== '' && parts[1] !== ''
}

/**
 * The kind of a thrown value, with none of its content.
 *
 * A GitHub error's MESSAGE can quote the request URL, and a request URL is one
 * refactor away from carrying a credential; a warning line is written to a log
 * that outlives the process. The name alone says what went wrong in a category
 * an operator can act on, and cannot say anything else.
 */
function errorKind(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause
}

export function createLocalArchiveDetector(
  deps: LocalArchiveDetectorDeps,
): LocalArchiveDetector {
  const { source, store } = deps
  const warn = deps.warn ?? ((line: string) => console.warn(line))
  const deadlineMs = deps.deadlineMs ?? DEFAULT_ARCHIVE_DEADLINE_MS

  return {
    async detect(review: LocalReviewSummary): Promise<ArchiveDetection> {
      // Archival is sticky and terminal: a review that already names a pull
      // request is not re-checked, so a pull request closed after detection
      // cannot un-archive anything, and a second one cannot replace the first.
      if (review.archivedPr !== null) {
        return { archivedPr: review.archivedPr, requested: false }
      }
      if (source === undefined) return { archivedPr: null, requested: false }
      if (!isOwnerNameShaped(review.repo)) return { archivedPr: null, requested: false }

      let pulls: PullSummary[]
      try {
        pulls = await withDeadline(
          source.listOpenPullsForPair({
            headRef: bareBranchName(review.headRef),
            baseRef: bareBranchName(review.baseRef),
          }),
          deadlineMs,
        )
      } catch (cause) {
        warn(
          `local review #${review.id}: the archive check could not read the ` +
            `repository (${errorKind(cause)}); the review stays live`,
        )
        return { archivedPr: null, requested: true }
      }

      const match = supersedingPull(review, pulls)
      if (match === null) return { archivedPr: null, requested: true }

      try {
        store.markLocalReviewArchived(review.id, match.number)
      } catch (cause) {
        // DEFENCE IN DEPTH, and only against the one refusal the store makes on
        // the number itself. The predicate above already rejects every value the
        // store would refuse, so a `RangeError` here means the two disagree — and
        // the cost of that disagreement must be a review that stays live, not a
        // sync of local work failing over a malformed row in somebody else's
        // listing. Every OTHER store failure is a real one and propagates: a data
        // directory that cannot be written to is not something this check may
        // decide to keep quiet about.
        if (!(cause instanceof RangeError)) throw cause
        warn(
          `local review #${review.id}: the store refused the pull request number ` +
            `the archive check found (${errorKind(cause)}); the review stays live`,
        )
        return { archivedPr: null, requested: true }
      }
      // Re-read rather than report `match.number`: the write is write-once, so
      // the number that stands may be one an earlier writer recorded, and the
      // caller must be told what the review actually says.
      return { archivedPr: store.getLocalReview(review.id)?.archivedPr ?? null, requested: true }
    },
  }
}
