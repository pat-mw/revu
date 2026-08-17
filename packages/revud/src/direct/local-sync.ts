/**
 * The git-only read path for a review of two local branches: resolving the pair
 * to the commit range the review covers, and the key that range is cached under.
 *
 * Every command runs through the hardened seam beside this module, which is the
 * only place argv arrays are built — nothing here assembles one, so a ref name
 * cannot reach git's option parser from this file.
 *
 * ## The base tip is read live, never recorded
 *
 * Both sides are resolved with `git rev-parse --verify` at the moment of asking.
 * There is no stored base commit to read instead: the branch *is* where the base
 * is, and reviewing a pair of branches means reviewing what they are now. Two
 * consequences follow, and both are intended:
 *
 *   - a base branch that advances moves `baseSha` with no new head commit;
 *   - the advance moves `compareKey` as well **whenever it brings in a commit the
 *     head branch already contains**, because that is what moves the common
 *     ancestor. An advance along commits the head branch does not have adds no
 *     common ancestor and leaves the reviewed range exactly where it was.
 *
 * A reader tempted to "stabilize" the base by remembering the first answer would
 * be choosing to review a range that no longer exists.
 *
 * ## Outcomes are classified by the exit code, never by stderr text
 *
 * A non-zero exit is a result, never a throw, so every outcome is decided by
 * reading `code`. stderr carries a human-facing message that varies with the git
 * version, the locale and the repository's configuration; the exit code is the
 * part that is an interface. Measured against git 2.50.1:
 *
 *   - `rev-parse --verify` on a ref that resolves to nothing exits **128**;
 *   - `merge-base` on two commits with no common ancestor exits **1** with empty
 *     output — and a shallow clone, whose common ancestor was simply never
 *     fetched, produces *the same two observations*. They are distinguishable
 *     only by asking `rev-parse --is-shallow-repository`, which is why the probe
 *     runs before the no-common-ancestor outcome is reported;
 *   - `merge-base` handed a commit the repository does not have exits **128**.
 */
import type { CommandRunner } from './command-runner'
import { runGit } from './local-git'

/** A full-length object name. Anything shorter or differently spelled is not one. */
const OBJECT_NAME = /^[0-9a-f]{40}$/

/** The commit range a local review covers, and the key its content is cached under. */
export interface LocalRange {
  /** The base branch's tip, as it is at resolution time. Not part of `compareKey`. */
  readonly baseSha: string
  /** The head branch's tip, as it is at resolution time. */
  readonly headSha: string
  /** The best common ancestor of the two tips — the left side of the reviewed range. */
  readonly mergeBaseSha: string
  /**
   * `mergeBaseSha` and `headSha` joined by three dots, in that order. One
   * spelling, shared with every other producer of this key: content is cached in
   * two halves and the immutable half is stored under exactly this string, so a
   * two-dot or hyphenated variant would fork the cache invisibly and the
   * immutable half would never be reused.
   */
  readonly compareKey: string
}

/**
 * A side of the pair did not resolve to a commit. `refs` names the side when one
 * ref failed to resolve, and both when the failure was the merge-base read
 * finding one of the commits it was handed absent.
 *
 * `code` is the exit code that was observed, and it is carried rather than
 * collapsed so a caller can still tell git's "no such revision" (128) from the
 * seam refusing to spawn an argv at all, or from a git that could not be spawned
 * — three causes with one consequence for the caller and no reason to invent a
 * separate outcome for each.
 */
export interface RefNotFound {
  readonly ok: false
  readonly reason: 'ref_not_found'
  readonly refs: readonly string[]
  readonly code: number
}

/**
 * Both refs resolve to the same commit, so there is nothing to review. Compared
 * on the resolved commits and not on the names: two different branch names left
 * at one commit are the same degenerate pair as one name given twice.
 */
export interface SameRef {
  readonly ok: false
  readonly reason: 'same_ref'
  readonly baseRef: string
  readonly headRef: string
  /** The commit both refs resolve to. */
  readonly sha: string
}

/** The two refs share no common ancestor, in a repository that holds its history. */
export interface UnrelatedHistories {
  readonly ok: false
  readonly reason: 'unrelated_histories'
  readonly baseRef: string
  readonly headRef: string
}

/**
 * The repository is shallow, so the common ancestor may exist upstream and simply
 * not be present. Reported instead of unrelated histories because the histories
 * are probably fine and the clone is what needs deepening.
 */
export interface ShallowClone {
  readonly ok: false
  readonly reason: 'shallow_clone'
  readonly baseRef: string
  readonly headRef: string
}

export type LocalRangeFailure = RefNotFound | SameRef | UnrelatedHistories | ShallowClone

/**
 * The ways resolving a pair of local branches can fail, derived from the union
 * rather than restated beside it, so the vocabulary cannot drift from the members
 * that produce it. A caller mapping these onto a coarser set of codes for the
 * outside world reads this.
 */
export type LocalRangeFailureReason = LocalRangeFailure['reason']

export type LocalRangeResult = { readonly ok: true; readonly range: LocalRange } | LocalRangeFailure

/** The pair to resolve. Both refs must already be fully qualified (`refs/…`). */
export interface LocalRangeRequest {
  readonly baseRef: string
  readonly headRef: string
}

type TipResult = { ok: true; sha: string } | { ok: false; code: number }

/**
 * Reads one ref's current tip. A clean exit whose output is not an object name is
 * treated as a non-resolution rather than trusted: the alternative is carrying
 * something that is not a commit into the compare key, which would key content
 * under a string no other producer of that key could ever match.
 */
async function resolveTip(runner: CommandRunner, cwd: string, ref: string): Promise<TipResult> {
  const result = await runGit(runner, cwd, { args: ['rev-parse', '--verify'], revs: [ref] })
  const sha = result.stdout.trim()
  if (!result.ok || !OBJECT_NAME.test(sha)) return { ok: false, code: result.code }
  return { ok: true, sha }
}

/**
 * Whether the repository is shallow. A probe that itself fails answers `false`:
 * the outcome it guards is already a failure, and an unanswerable probe is not
 * grounds for claiming the clone is the problem.
 */
async function isShallowRepository(runner: CommandRunner, cwd: string): Promise<boolean> {
  const result = await runGit(runner, cwd, { args: ['rev-parse', '--is-shallow-repository'] })
  return result.ok && result.stdout.trim() === 'true'
}

/**
 * Resolves a base/head branch pair to the commit range a review of it covers.
 *
 * Both refs are read live, the merge base is computed from the two resolved
 * commits, and `compareKey` is the three-dot join of the merge base and the head.
 * A merge base equal to the head is a **success**: the head has nothing ahead of
 * the base, which is an empty review and not an error.
 */
export async function resolveLocalRange(
  runner: CommandRunner,
  cwd: string,
  request: LocalRangeRequest,
): Promise<LocalRangeResult> {
  const { baseRef, headRef } = request

  const base = await resolveTip(runner, cwd, baseRef)
  if (!base.ok) return { ok: false, reason: 'ref_not_found', refs: [baseRef], code: base.code }
  const head = await resolveTip(runner, cwd, headRef)
  if (!head.ok) return { ok: false, reason: 'ref_not_found', refs: [headRef], code: head.code }

  if (base.sha === head.sha) {
    return { ok: false, reason: 'same_ref', baseRef, headRef, sha: base.sha }
  }

  const mergeBase = await runGit(runner, cwd, {
    args: ['merge-base'],
    revs: [base.sha, head.sha],
  })
  const mergeBaseSha = mergeBase.stdout.trim()
  if (!mergeBase.ok || !OBJECT_NAME.test(mergeBaseSha)) {
    // Exit 1 with no output is git's "these two have no common ancestor" — the
    // one outcome a shallow clone counterfeits exactly.
    if (mergeBase.code === 1 && mergeBaseSha === '') {
      if (await isShallowRepository(runner, cwd)) {
        return { ok: false, reason: 'shallow_clone', baseRef, headRef }
      }
      return { ok: false, reason: 'unrelated_histories', baseRef, headRef }
    }
    return {
      ok: false,
      reason: 'ref_not_found',
      refs: [baseRef, headRef],
      code: mergeBase.code,
    }
  }

  return {
    ok: true,
    range: {
      baseSha: base.sha,
      headSha: head.sha,
      mergeBaseSha,
      compareKey: `${mergeBaseSha}...${head.sha}`,
    },
  }
}
