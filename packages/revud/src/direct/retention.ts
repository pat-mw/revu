/**
 * Retention: the only path that drops a local review's pinned refs, and the only
 * one that reclaims a cached half of a comparison nothing references any more.
 *
 * The two are the same subject seen from either end of the same store. A pin ref
 * keeps the git objects a synced snapshot was read from; a cached immutable half
 * keeps the rows that snapshot was assembled into. Both are held for exactly as
 * long as something needs them and released by an explicit act rather than by a
 * clock, and getting either release wrong loses content that has no second
 * source. So they live in one module, under one doctrine, and the guards that
 * keep the ref drop from reaching past its own namespace are the guards that keep
 * the cache sweep from reaching past what is unreferenced.
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
 * No object is ever reclaimed by a drop. Dropping a ref makes objects
 * collectable; it is git's own schedule, or the user's own command, that decides
 * when the space comes back. Nothing here runs a garbage collection, touches the
 * working tree, or writes a ref — the whole of a drop's effect is the removal of
 * names it discovered under one review's own prefix.
 *
 * Nor does anything here reach for a whole-file storage operation. The cache
 * sweep removes rows, one keyed statement at a time, through the store's own
 * durable write path, and it never reclaims the file those rows sat in. A
 * whole-file rewrite such as VACUUM cannot run inside a transaction and takes an
 * exclusive lock on the file every unsubmitted draft lives in, so reaching for
 * one would block every reader of the store to recover space nobody asked for.
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
import type { DirectStore, ImmutableDeletion } from './store'

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

/**
 * Removes every cached immutable half that no stored snapshot references, and
 * reports what went.
 *
 * The rule is one subtraction and nothing else: a half is reclaimable exactly
 * when the cache holds its key and no snapshot in either table names it. There
 * is no age in it, no last-sync time, no cap on how many halves the cache may
 * keep. That is not a policy left open for a later refinement — the cache
 * records nothing about when a row was written, so there is no clock to read
 * even if one were wanted, and a half a live snapshot names is needed however
 * long ago the review it belongs to was last synced. An expiry added here would
 * be a rule about age applied to a table that has never known the age of
 * anything.
 *
 * ## Removing too much is the failure that does not degrade
 *
 * The two mistakes are not symmetric, and the whole shape of this follows from
 * which one to prefer. Leaving an unreferenced half behind costs disk and
 * nothing else; the next sweep takes it. Removing a half a live snapshot names
 * makes that review UNOPENABLE — the read that re-assembles it finds no
 * immutable half and refuses outright rather than handing back a snapshot with
 * an empty one, so what the caller gets is a failed persist and a review that
 * will not open again. The instinct that a derived half can simply be rebuilt by
 * re-syncing is what makes the mistake tempting, and it is wrong on exactly the
 * path this serves: a local review's comparison was computed from one clone, and
 * a branch rewritten since no longer holds the commits its compare key names.
 *
 * So this proposes and the store disposes. The candidate set is computed here,
 * and the store recomputes what is live inside the same transaction that issues
 * the deletes, which is the only place a snapshot written after these reads can
 * still be caught. A candidate that went live in that window keeps its half, at
 * the cost of one row that waits for the next sweep.
 *
 * ## Why this throws where a ref drop returns
 *
 * `dropPinnedRefs` resolves every outcome as a value, because a drop that failed
 * part-way has already removed refs a caller has to reconcile against. This one
 * refuses outright, because there is no partial progress to report and nothing
 * to reconcile: a snapshot envelope that will not parse means the reference set
 * is not known, and every deletion built on a reference set that is not known is
 * a guess. `StoreUnreadableError` travels out with nothing removed. A persist
 * that failed travels out as `StoreWriteError`, with the transaction rolled back
 * rather than swallowed into a success that removed part of what it named.
 *
 * ## What is never touched
 *
 * Only the cache of immutable halves. Not a draft — unsubmitted text is the
 * irreplaceable state in this store, and no reclamation may reach it for any
 * reason. Not the content-addressed blob table, which is keyed by git blob SHA
 * and shares no key space with a comparison. Not a snapshot envelope in either
 * table: the live set is READ from both and written to neither, and the
 * pull-request keyspace in particular is one the local path has no standing to
 * remove rows from. And never a half a snapshot still names, not even to force a
 * fresh sync — the two-half cache is the whole reason a warm re-sync is cheap,
 * and invalidating it on purpose would be a cache clear wearing a reclamation's
 * name.
 */
export function pruneImmutables(store: DirectStore): ImmutableDeletion {
  // The stored set is read BEFORE the live set, so a snapshot persisted between
  // the two reads names a key that was never a candidate. That ordering can only
  // ever narrow the proposal, which is the safe direction; what actually makes
  // the sweep safe is the store recomputing the live set inside the deleting
  // transaction, since a snapshot written after both reads is invisible to
  // either order.
  const stored = store.listImmutableKeys()
  const live = new Set(store.listLiveCompareKeys())
  return store.deleteImmutables(stored.filter((key) => !live.has(key)))
}
