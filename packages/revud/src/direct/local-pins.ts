/**
 * The only module that names or writes a pin ref.
 *
 * A local review's snapshot is built from one clone and nothing else. There is
 * no API tier behind it, so the objects its diff and its blob bytes were read
 * from have exactly one source: the object database of that clone. An ordinary
 * `git gc` — or the implicit one git runs on its own schedule — collects
 * anything unreachable, and a commit that has been amended or rebased away is
 * unreachable the moment the branch moves. Retention of those objects is
 * therefore a correctness property of the local review path, not housekeeping,
 * and this module is how it is bought: a ref per synced compare, so the objects
 * stay reachable until something deliberately drops the ref.
 *
 * ## Why the ref name is not the compare key
 *
 * The obvious name is `refs/revu/reviews/<id>/<compareKey>`, and it cannot be
 * created. A compare key is `<mergeBaseSha>...<headSha>`, and git rejects any
 * ref name containing `..` outright — `check-ref-format` exits non-zero, and no
 * amount of quoting helps, because the restriction is on the name itself. The
 * separator is therefore substituted for a single `-`, in exactly one place, and
 * a ref name is never parsed back into a compare key: callers that want to know
 * which compares are pinned list the refs, they do not reverse the encoding.
 *
 * ## Why the id and the key sit in directory position
 *
 * Every name here ends in `/base` or `/head`, so `<localId>` and the encoded key
 * are always path segments and never refs in their own right. Git stores loose
 * refs as files, so a ref *at* `refs/revu/reviews/<id>` would occupy the path
 * every child of that review needs to live under, and creating one makes the
 * whole subtree unwritable. Keeping both in directory position also gives
 * retention a stable prefix: everything belonging to one review is discoverable
 * by listing `refs/revu/reviews/<localId>/`, whatever the key encoding becomes.
 *
 * ## Why both refs are written by one invocation
 *
 * `git update-ref --stdin` applies its batch as a transaction: if any update in
 * it fails, none is applied. Two separate `git update-ref` calls do not have
 * that property — the first survives the second's failure, leaving the base
 * pinned and the head not, which is the shape that quietly loses the objects a
 * draft anchors against. The batch also keeps every object name out of the
 * argv, so nothing that must not be read as a flag ever passes git's option
 * parser.
 *
 * ## What this module does not do
 *
 * It does not delete refs. Retention owns eviction, discovering refs by prefix
 * rather than reconstructing their names, and two independent deletion paths
 * would be one deletion path and one piece of dead code. It also never runs
 * `git gc`: reclaiming objects is git's business and the user's, and this
 * module's only claim is that the objects are still there to reclaim.
 */
import { isLocalReviewId } from '@revu/shared'
import type { CommandRunner } from './command-runner'
import { runGit } from './local-git'

/** The namespace every pin lives under. Also retention's discovery prefix. */
const PIN_ROOT = 'refs/revu/reviews'

/** The separator a compare key joins its two object names with. */
const COMPARE_SEPARATOR = '...'

/**
 * An object name as git resolves one: 40 hex characters for a sha1 repository,
 * 64 for a sha256 one. Anything else is refused before it can reach a command.
 */
const OBJECT_NAME = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/

/** The two refs pinning one synced compare. */
export interface PinRefs {
  /** Holds the merge base commit — the left side of the reviewed range. */
  readonly base: string
  /** Holds the head commit — the right side. */
  readonly head: string
}

/** One pinned ref and the object it holds, as listed from the repository. */
export interface Pin {
  readonly ref: string
  readonly objectName: string
}

/**
 * Why a pin or a listing did not happen:
 *   - `invalid-local-id`: the id is not an integer inside the reserved local
 *     review band. A pull request number is a positive integer too, and pinning
 *     retention state under one would attach local bookkeeping to forge-keyed
 *     data.
 *   - `invalid-object-name`: a value that is not a resolved object name. It is
 *     refused before it can occupy a command argument.
 *   - `git-failed`: git ran and reported a non-zero exit — a locked ref, a bare
 *     repository, a missing object.
 */
export type PinFailureReason = 'invalid-local-id' | 'invalid-object-name' | 'git-failed'

export type PinResult =
  | { ok: true; refs: PinRefs }
  | { ok: false; reason: PinFailureReason; detail: string }

export type ListPinsResult =
  | { ok: true; pins: Pin[] }
  | { ok: false; reason: PinFailureReason; detail: string }

/**
 * Turns a compare key into a single ref-legal path component. This is the only
 * place the substitution happens, and it is deliberately not invertible: a `-`
 * is legal inside an object name's neighbourhood in a way that makes reversing
 * the encoding a guess, so callers list refs instead of parsing them.
 */
export function pinKeyForCompare(compareKey: string): string {
  const at = compareKey.indexOf(COMPARE_SEPARATOR)
  if (at === -1) return compareKey
  const head = compareKey.slice(at + COMPARE_SEPARATOR.length)
  return `${compareKey.slice(0, at)}-${head}`
}

/**
 * The two ref names pinning one compare of one review. A pure name builder: it
 * validates nothing, because it is also how tests and retention talk about
 * names that were written earlier. `pinSnapshotObjects` is the validating entry
 * point, and it is the only one that writes.
 */
export function pinRefsFor(localId: number, compareKey: string): PinRefs {
  const key = pinKeyForCompare(compareKey)
  const prefix = `${PIN_ROOT}/${localId}/${key}`
  return { base: `${prefix}/base`, head: `${prefix}/head` }
}

/** The prefix every ref of one review lives under, or of every review. */
function pinPrefix(localId?: number): string {
  return localId === undefined ? `${PIN_ROOT}/` : `${PIN_ROOT}/${localId}/`
}

/**
 * Writes both pins for one synced compare in a single batched invocation.
 *
 * A pin failure is not a sync failure: a review whose objects are unpinned is
 * still perfectly readable today, it merely has no retention guarantee. So
 * every outcome here is a value — the function resolves for a refused input and
 * for a failed git alike, and never rejects.
 *
 * Idempotent: re-pinning the same compare rewrites the same two refs.
 */
export async function pinSnapshotObjects(
  runner: CommandRunner,
  cwd: string,
  localId: number,
  range: { mergeBaseSha: string; headSha: string },
): Promise<PinResult> {
  if (!isLocalReviewId(localId)) {
    return {
      ok: false,
      reason: 'invalid-local-id',
      detail: `${localId} is not an id in the local review band`,
    }
  }
  for (const [label, value] of [
    ['mergeBaseSha', range.mergeBaseSha],
    ['headSha', range.headSha],
  ] as const) {
    if (!OBJECT_NAME.test(value)) {
      return {
        ok: false,
        reason: 'invalid-object-name',
        detail: `${label} is not a resolved object name`,
      }
    }
  }

  const refs = pinRefsFor(localId, `${range.mergeBaseSha}${COMPARE_SEPARATOR}${range.headSha}`)
  // Newline-terminated records: legal because a ref name cannot contain a
  // newline or a space and an object name is hex, both already enforced above.
  const batch =
    `update ${refs.base} ${range.mergeBaseSha}\n` + `update ${refs.head} ${range.headSha}\n`

  const result = await runGit(runner, cwd, {
    args: ['update-ref', '--stdin'],
    stdin: batch,
  })
  if (!result.ok) {
    return { ok: false, reason: 'git-failed', detail: result.stderr.trim() }
  }
  return { ok: true, refs }
}

/**
 * Lists the pins of one review, or of every review when no id is given.
 *
 * The format is always stated explicitly. Git's default `for-each-ref` output
 * is a convenience for humans and not a parsing contract, so relying on it
 * would make this parser hostage to a formatting change. NUL separates the two
 * fields because it is the one byte neither a ref name nor an object name can
 * contain.
 */
export async function listPins(
  runner: CommandRunner,
  cwd: string,
  localId?: number,
): Promise<ListPinsResult> {
  if (localId !== undefined && !isLocalReviewId(localId)) {
    return {
      ok: false,
      reason: 'invalid-local-id',
      detail: `${localId} is not an id in the local review band`,
    }
  }
  const result = await runGit(runner, cwd, {
    args: ['for-each-ref', '--format=%(refname)%00%(objectname)'],
    revs: [pinPrefix(localId)],
  })
  if (!result.ok) {
    return { ok: false, reason: 'git-failed', detail: result.stderr.trim() }
  }
  const pins: Pin[] = []
  for (const line of result.stdout.split('\n')) {
    if (line.length === 0) continue
    const at = line.indexOf('\0')
    // A record without the separator is not a short record, it is evidence the
    // format was not applied — so it is dropped rather than half-parsed into a
    // ref whose object name would silently be the empty string.
    if (at === -1) continue
    pins.push({ ref: line.slice(0, at), objectName: line.slice(at + 1) })
  }
  return { ok: true, pins }
}
