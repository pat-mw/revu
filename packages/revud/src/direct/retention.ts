/**
 * Retention: the only path that drops a local review's pinned refs.
 *
 * A local review is built from one clone and nothing else. Its diff and its
 * blob bytes were read out of a single object database, and there is no second
 * tier to read them from again — so the objects a synced snapshot rests on stay
 * reachable only because a ref holds them. Writing those refs is one module's
 * job; taking them away is this one's, and there is exactly one implementation
 * of it. Two deletion paths would be one deletion path and one piece of dead
 * code, and the dead one is the one that stops matching how names are spelled.
 *
 * ## Refs are discovered, never reconstructed
 *
 * The tempting implementation rebuilds the ref name from the review id and the
 * compare key it was pinned under. It cannot work, and it fails in the worst
 * possible way. A compare key is `<mergeBase>...<head>`, and git refuses any ref
 * name containing two consecutive dots: `check-ref-format` exits non-zero on it
 * and `update-ref` answers "refusing to update ref with bad name". But deleting
 * a ref that does not exist is not an error — git exits zero for it — so a drop
 * built on reconstructed names deletes nothing at all and reports success while
 * every object stays pinned forever. The refs are therefore listed out of the
 * repository and the names git gives back are the names that are deleted.
 *
 * Listing by prefix is safe under any future name encoding because the pin
 * writer keeps both the review id and the pin key in *directory* position: a
 * ref sitting at `refs/revu/reviews/<id>` would make every child of that path
 * unwritable, so the prefix always names a directory and never a ref. The
 * prefix is restated here rather than imported, and the real-repository legs of
 * the test suite pin the two spellings together by writing with the pin module
 * and discovering with this one — a divergence turns those legs red instead of
 * turning a drop into a silent no-op.
 *
 * ## Why an empty namespace is a clean zero
 *
 * A review that has never been synced has nothing pinned, and `for-each-ref`
 * over an empty namespace exits zero with no output. That is the ordinary case,
 * not a failure: eviction of a review that was never pinned has nothing to do
 * and has done it. The count reports zero and the caller carries on.
 *
 * ## Why deletion is one command per ref and pinning is one batch
 *
 * The pin writer uses a single batched invocation because git applies a batch
 * as a transaction, and a half-written pin is a correctness bug: the base held
 * and the head not means the objects one side of a reviewed range rests on are
 * collectable while the review still claims a snapshot. Deletion's failure
 * direction is the opposite. A ref that could not be deleted leaves its objects
 * pinned for longer than intended, which costs disk and loses nothing, whereas
 * a batch that aborts on one locked ref would drop none of the others. So this
 * path prefers progress over atomicity and reports exactly which refs went,
 * which is also what makes a partial failure actionable rather than opaque.
 *
 * ## What never happens here
 *
 * No object is ever reclaimed. Dropping a ref makes objects collectable; it is
 * git's own schedule, or the user's own command, that decides when the space
 * comes back. This module never runs a garbage collection, never touches the
 * working tree, and never writes a ref — the whole of its effect is the removal
 * of names it discovered under one review's own prefix. Nor does it issue any
 * storage statement: pins are refs in an object database rather than rows, so
 * eviction has nothing to rewrite and never reaches for a whole-file operation
 * such as VACUUM.
 *
 * ## Hardening
 *
 * Every argument travels as an element of an argv array through the injected
 * command seam, so there is no shell and nothing to quote. The review id is
 * validated as an integer in the reserved local band before it is stringified,
 * so a decimal integer is all that ever occupies the prefix argument — a value
 * that cannot carry a path separator, a dot-dot, or a leading dash. Discovered
 * ref names are the one text this module did not author, and each is required
 * to sit under the prefix it was discovered by before it can occupy an
 * argument: a foreign `refs/`-shaped name would otherwise pass the argv
 * hardening on shape alone and a listing that went wrong could delete a branch.
 * The whole listing is checked before the first deletion runs, so a bad name
 * late in it cannot be preceded by deletions that already happened.
 */
import { isLocalReviewId } from '@revu/shared'
import type { CommandRunner } from './command-runner'
import { runGit } from './local-git'

/** The namespace every pin lives under, and this module's discovery root. */
const PIN_ROOT = 'refs/revu/reviews'

/** The seam a drop runs through: one command runner and one repository. */
export interface RetentionContext {
  /** The only way this module reaches a subprocess. */
  readonly runner: CommandRunner
  /**
   * The repository to act in. Always explicit — nothing here reads the process
   * working directory, so a drop acts on the repository it was handed rather
   * than on wherever the daemon happened to start.
   */
  readonly cwd: string
}

/**
 * Why a drop did not complete:
 *   - `invalid-local-id`: the id is not an integer inside the reserved local
 *     review band. A pull request number is a positive integer too, and listing
 *     one under the local namespace would answer a clean zero and hide the
 *     mistake instead of naming it.
 *   - `unexpected-ref`: discovery returned a name outside the prefix it was
 *     asked for, which is evidence the listing did not mean what it says.
 *     Nothing is deleted on the strength of it.
 *   - `git-failed`: git ran and reported a non-zero exit — an unreadable
 *     repository, a locked ref.
 */
export type DropFailureReason = 'invalid-local-id' | 'unexpected-ref' | 'git-failed'

/**
 * The outcome of one drop. Both branches carry `dropped` and its `count`,
 * because a failure part-way through a listing has still removed the refs it
 * removed and a caller reconciling its own state needs to know which.
 */
export type DropPinnedRefsResult =
  | { ok: true; count: number; dropped: string[] }
  | {
      ok: false
      reason: DropFailureReason
      detail: string
      count: number
      dropped: string[]
    }

/** The prefix every ref belonging to one review lives under. */
function pinPrefix(localId: number): string {
  return `${PIN_ROOT}/${localId}/`
}

function failed(
  reason: DropFailureReason,
  detail: string,
  dropped: string[],
): DropPinnedRefsResult {
  return { ok: false, reason, detail, count: dropped.length, dropped }
}

/**
 * Removes every pin ref belonging to one local review, and reports what went.
 *
 * A drop is idempotent: a second call over a namespace the first emptied
 * discovers nothing, spawns nothing beyond that discovery, and reports a count
 * of zero. Every outcome is a value — a refused id and a failing git alike
 * resolve rather than reject — because eviction runs on paths where a throw
 * would abandon work that has already succeeded.
 */
export async function dropPinnedRefs(
  { runner, cwd }: RetentionContext,
  localId: number,
): Promise<DropPinnedRefsResult> {
  const dropped: string[] = []
  if (!isLocalReviewId(localId)) {
    return failed('invalid-local-id', `${localId} is not an id in the local review band`, dropped)
  }

  const prefix = pinPrefix(localId)
  // The format is stated explicitly: git's default listing output is a
  // convenience for humans and not a parsing contract, so relying on it would
  // make this parser hostage to a formatting change.
  const listed = await runGit(runner, cwd, {
    args: ['for-each-ref', '--format=%(refname)'],
    revs: [prefix],
  })
  if (!listed.ok) return failed('git-failed', listed.stderr.trim(), dropped)

  const refs = listed.stdout.split('\n').filter((line) => line.length > 0)
  for (const ref of refs) {
    if (!ref.startsWith(prefix)) {
      return failed('unexpected-ref', `${ref} is not under ${prefix}`, dropped)
    }
  }

  for (const ref of refs) {
    const result = await runGit(runner, cwd, { args: ['update-ref', '-d'], revs: [ref] })
    if (!result.ok) return failed('git-failed', result.stderr.trim(), dropped)
    dropped.push(ref)
  }
  return { ok: true, count: dropped.length, dropped }
}
