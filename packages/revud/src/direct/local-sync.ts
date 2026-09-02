/**
 * The git-only read path for a review of two local branches: resolving the pair
 * to the commit range the review covers, the key that range is cached under, and
 * the change set that range contains.
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
 *
 * ## The change set is read as records, never as text
 *
 * `git diff --raw -z` reports one record per changed path, carrying both sides'
 * file modes, both sides' object names and a status letter — everything the file
 * list and the blob index need, from a single read, with no cap on how many
 * records it will emit. `-z` makes each field NUL-terminated, so a path can hold
 * a space, a newline or a quote and still be read back byte for byte.
 *
 * Reading it correctly turns on three details, each with a consequence:
 *
 *   - **`--no-abbrev` is mandatory.** Plain `--raw` truncates object names to
 *     seven characters. Content is stored and looked up under full-length names,
 *     so a truncated one matches nothing: every blob lookup would miss, line
 *     resolution would come back empty, and pending comments would be classified
 *     as lost en masse — with no visible cause, because a short name looks like a
 *     name. The parser here refuses anything that is not a full-length object
 *     name, so the mistake fails loudly rather than silently, but the flag is
 *     what stops it happening at all.
 *   - **An all-zero object name means "absent on this side"** and becomes null,
 *     the same value the API-shaped producer of this structure uses; a zero-
 *     spelled name in the index would be looked up as though it were content.
 *   - **Gitlinks and symlinks are left out of the blob index, decided by file
 *     mode.** A gitlink's oid is a commit in another repository that this one
 *     usually does not hold at all, so asking for its bytes fails permanently
 *     and the path would sit in the review as a blob nothing can ever supply.
 *     A symlink's object is a path string rather than file content. Both stay in
 *     the file list, with the reason they carry no index entry recorded beside
 *     it, so the change set stays honest about what changed. The decision is made
 *     on the mode and never on the shape of the oid: a real gitlink names an
 *     ordinary-looking oid, and "it looks like zeros" would skip the wrong ones.
 *
 * ## Counts and patch text come from two more reads over the same range
 *
 * `--raw` says what changed; it does not say how many lines moved or what they
 * were. `--numstat -z` answers the first and `--unified=3` the second, both over
 * the same two commits, and all three emit files in git's one diff-queue order —
 * which is what lets the three streams be joined by position. The join is by
 * position and not by path on purpose: a patch's paths live inside a
 * `diff --git a/… b/…` header, where a path holding a quote or a newline arrives
 * C-quoted, so parsing one back out would be a second, weaker path parser beside
 * the exact one `-z` already gives. Position is only safe if a disagreement is
 * loud, so a length mismatch between the three reads is a typed failure rather
 * than an off-by-one nobody notices.
 *
 * ## Each file's patch starts at that file's own first hunk header
 *
 * Everything a unified diff prints before a file's first `@@` introduces the
 * file — `diff --git`, `index`, `similarity index`, `rename from`/`rename to`,
 * `--- a/…`, `+++ b/…` — and none of it may travel with the hunks. The reader on
 * the other side ignores whatever precedes the first hunk header but nothing
 * after it: once a hunk is open, a following file's `--- a/x` is consumed as a
 * deleted line, its `+++ b/x` as an added line and its `diff --git` line as
 * context. Each of those advances the line cursors, so every row after them is
 * numbered past the end of the range the hunk's own header declares, and a
 * comment anchored to one of those rows names a line holding entirely different
 * content. Splitting the stream on `diff --git ` and then dropping everything
 * before the first `@@` is what keeps that from happening at all.
 *
 * ## An absent patch is a statement, not a gap
 *
 * `patch` is set only when the file has at least one hunk. A binary file
 * (`Binary files … differ`), a pure rename and a mode-only change all produce a
 * section with no hunk, and all three leave the field **absent** rather than
 * empty — the same convention the API-shaped producer carries, where absence
 * means "there is no text diff to show" and an empty string would mean "the diff
 * is empty", two different claims. Binary files additionally report `-` for both
 * line counts, which become zero.
 *
 * ## Commits come back oldest first, because that is the order they are sliced in
 *
 * git prints history newest first. The list this module produces is read by
 * finding a known commit in it and taking everything *after* that position, to
 * answer "what landed since this draft was written" — an expression that is only
 * correct while the list runs forwards. Handed a newest-first list, the same
 * expression returns the commits that came *before* the known one and reports
 * them as the new ones: a wrong answer shaped exactly like a right one, with
 * nothing anywhere to notice it. The reversal is asked of git rather than
 * applied afterwards, so the order is a property of the read.
 *
 * ## The pull shape is synthesized, and the address is never in it
 *
 * A local review has no pull request behind it, so the shape every surface
 * downstream of a snapshot reads is built here instead of fetched. Every field
 * takes a value that shape already declares legal — an unknown mergeable state,
 * no merge, no requested reviewers — and its author is a sentinel carrying the
 * reviewer's display **name**. The configured address is the key a person's
 * stored state is filed under, so it belongs in no document that is handed out;
 * this module never even asks git for it.
 */
import type {
  CommitInfo,
  GhRef,
  GhUser,
  PullDetail,
  PullFile,
  SnapshotImmutable,
} from '@revu/shared'
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

// ————————————————————————————————————————————————————————————————————————————
// The change set the range contains.
// ————————————————————————————————————————————————————————————————————————————

/** How git spells "no object on this side" in a `--raw` record. */
const ABSENT_OBJECT_NAME = '0'.repeat(40)

/** How git spells "nothing on this side" in a `--raw` record's file-mode field. */
const ABSENT_FILE_MODE = '000000'

/**
 * The status letters a diff between two commits can report. `U` (unmerged) and
 * `X` (unknown) describe an index mid-conflict, which a commit-to-commit range
 * cannot produce; a record carrying one is not a case to map but evidence that
 * the output being read is not what it was asked for.
 */
export type RawDiffStatus = 'A' | 'C' | 'D' | 'M' | 'R' | 'T'

const RAW_DIFF_STATUSES: readonly string[] = ['A', 'C', 'D', 'M', 'R', 'T']

/**
 * One `--raw -z` record, held as git spelled it. Deliberately unopinionated: the
 * object names are the literal fields, including the all-zero spelling, and the
 * status keeps its letter with any similarity score alongside rather than folded
 * in. Interpretation happens one step later, so the two steps can be read — and
 * tested — apart.
 */
export interface RawDiffRecord {
  /** File mode on the base side, `000000` when the path is absent there. */
  readonly srcMode: string
  /** File mode on the head side, `000000` when the path is absent there. */
  readonly dstMode: string
  readonly srcSha: string
  readonly dstSha: string
  readonly status: RawDiffStatus
  /** The similarity score git printed beside a rename or a copy, when it printed one. */
  readonly score?: number
  /** The head-side path. For a rename or a copy, the post-image path. */
  readonly path: string
  /** The pre-image path, present only for a rename or a copy. */
  readonly previousPath?: string
}

/** Why a changed path carries no blob index entry. */
export type BlobIndexSkipReason = 'gitlink' | 'symlink'

/**
 * The fields of a change-set file that a `--raw` read determines on its own:
 * which object the head side names, the path it lives under, how it changed, and
 * where a rename came from. Line counts and patch text come from separate reads
 * over the same range and are layered on by whatever runs them.
 *
 * Deliberately a subset of the wire shape rather than the whole of it with zeros
 * in the gaps: a file that silently claims no lines changed is indistinguishable
 * from one that genuinely did not, whereas a missing later step is a type error.
 */
export type DiffFileEntry = Pick<PullFile, 'sha' | 'filename' | 'status' | 'previous_filename'>

/** A change set: what changed, and which objects hold each side of it. */
export interface LocalDiffFiles {
  /** One entry per record, in the order git emitted them. */
  readonly files: readonly DiffFileEntry[]
  /**
   * The status letter git printed for each entry, in the same order — kept
   * because the mapping onto the wire vocabulary is lossy in a way that matters
   * later: two letters both become `modified`, and only one of them is emitted
   * as two sections of patch output.
   */
  readonly rawStatuses: readonly RawDiffStatus[]
  /** Keyed by head-side path. A path whose object cannot be read is absent. */
  readonly blobIndex: SnapshotImmutable['blobIndex']
  /**
   * Head-side path → why that path has no blob index entry. Carried beside the
   * index rather than inside the file entry, so a reader can say *why* a file
   * shows no content without the reason having to fit a wire shape that has no
   * field for it.
   */
  readonly skippedBlobPaths: Readonly<Record<string, BlobIndexSkipReason>>
}

/** git produced output, but not output in the format that was asked for. */
export interface MalformedDiff {
  readonly ok: false
  readonly reason: 'malformed_diff'
  readonly detail: string
}

/** The diff command itself failed. Carries the exit code that was observed. */
export interface DiffFailed {
  readonly ok: false
  readonly reason: 'diff_failed'
  readonly code: number
}

export type RawDiffParse =
  | { readonly ok: true; readonly records: readonly RawDiffRecord[] }
  | MalformedDiff

export type LocalDiffFilesResult =
  | { readonly ok: true; readonly diff: LocalDiffFiles }
  | MalformedDiff
  | DiffFailed

/**
 * A `--raw` metadata field. The object names are pinned at full length: without
 * `--no-abbrev` git prints seven characters here, and a truncated name that was
 * accepted would poison the blob index silently, where one that is refused says
 * exactly what went wrong.
 */
const RAW_META = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])(\d*)$/

function malformed(detail: string): MalformedDiff {
  return { ok: false, reason: 'malformed_diff', detail }
}

/**
 * Reads `git diff --raw -z` output into records.
 *
 * The stream is a flat sequence of NUL-terminated fields: one metadata field,
 * then the one path it concerns — or, for a rename or a copy, the two paths it
 * pairs. How many path fields follow is therefore a function of the status letter
 * that was just read, which is why this walks the fields rather than splitting on
 * a record separator: there is no record separator to split on.
 *
 * Anything that is not that format is reported as a typed failure rather than
 * skipped. A record this cannot read is a file the review would silently omit,
 * and a review that quietly drops a changed file is worse than one that says it
 * could not be built.
 */
export function parseRawZ(stdout: string): RawDiffParse {
  const fields = stdout.split('\0')
  // Every field is NUL-terminated, so splitting leaves one trailing empty string.
  if (fields[fields.length - 1] === '') fields.pop()

  const records: RawDiffRecord[] = []
  let index = 0
  while (index < fields.length) {
    const meta = RAW_META.exec(fields[index])
    if (meta === null) {
      return malformed(`${JSON.stringify(fields[index])} is not a --raw -z metadata field`)
    }
    const [, srcMode, dstMode, srcSha, dstSha, letter, score] = meta
    if (!RAW_DIFF_STATUSES.includes(letter)) {
      return malformed(`status ${JSON.stringify(letter)} cannot arise between two commits`)
    }
    const status = letter as RawDiffStatus
    const pathCount = status === 'R' || status === 'C' ? 2 : 1
    const paths = fields.slice(index + 1, index + 1 + pathCount)
    if (paths.length < pathCount || paths.some((path) => path.length === 0)) {
      return malformed(`status ${status} needs ${pathCount} path field(s), got ${paths.length}`)
    }
    index += 1 + pathCount
    records.push({
      srcMode,
      dstMode,
      srcSha,
      dstSha,
      status,
      ...(score.length > 0 ? { score: Number(score) } : {}),
      ...(pathCount === 2 ? { previousPath: paths[0], path: paths[1] } : { path: paths[0] }),
    })
  }
  return { ok: true, records }
}

/**
 * Status letters onto the four the wire shape declares. Two of them have no
 * member of their own and are mapped to the closest true statement about the head
 * side: a copy is a file that is new where it now sits, and a type change is a
 * path that exists on both sides with different content.
 */
const STATUS: Readonly<Record<RawDiffStatus, PullFile['status']>> = {
  A: 'added',
  C: 'added',
  D: 'removed',
  M: 'modified',
  R: 'renamed',
  T: 'modified',
}

/** File modes whose object is not readable file content, and what to call each. */
const UNREADABLE_MODES = new Map<string, BlobIndexSkipReason>([
  ['160000', 'gitlink'],
  ['120000', 'symlink'],
])

/**
 * Whether a record's object is something this repository can read as content,
 * decided on the file modes of the sides that exist. A skip on either side takes
 * the whole path out of the index: an entry whose base or head names something
 * that is not file content would anchor a comment against something that is not
 * the file.
 */
function skipReason(record: RawDiffRecord): BlobIndexSkipReason | null {
  for (const mode of [record.srcMode, record.dstMode]) {
    if (mode === ABSENT_FILE_MODE) continue
    const reason = UNREADABLE_MODES.get(mode)
    if (reason !== undefined) return reason
  }
  return null
}

/** An object name, or null where git spelled the side as absent. */
function objectNameOrNull(sha: string): string | null {
  return sha === ABSENT_OBJECT_NAME ? null : sha
}

/**
 * Turns records into the file list and the blob index a review is read through.
 *
 * The index is keyed by the **head-side** path, which is what makes a rename work:
 * its entry lives under the new path and holds the old path's object on the base
 * side, so a comment written against the pre-image resolves through the one entry
 * that knows both sides. A removed file keeps a null head side, and an added file
 * a null base side, whichever way git happened to spell the missing object.
 */
export function buildLocalDiffFiles(records: readonly RawDiffRecord[]): LocalDiffFiles {
  const files: DiffFileEntry[] = []
  const rawStatuses: RawDiffStatus[] = []
  const blobIndex: SnapshotImmutable['blobIndex'] = {}
  const skippedBlobPaths: Record<string, BlobIndexSkipReason> = {}

  for (const record of records) {
    rawStatuses.push(record.status)
    const status = STATUS[record.status]
    const base = objectNameOrNull(record.srcSha)
    const head = objectNameOrNull(record.dstSha)

    files.push({
      // The head-side object when there is one, and the pre-image object
      // otherwise: a removed file has no head side, and its pre-image name is the
      // only thing that identifies it — the same value the API-shaped producer
      // carries in this field for a removal.
      sha: head ?? base ?? '',
      filename: record.path,
      // Only a rename carries its pre-image path. A copy is reported as added,
      // and an added file has no earlier name, so saying it does would describe a
      // relationship the status it was given does not have.
      ...(record.status === 'R' && record.previousPath !== undefined
        ? { previous_filename: record.previousPath }
        : {}),
      status,
    })

    const skip = skipReason(record)
    if (skip !== null) {
      skippedBlobPaths[record.path] = skip
      continue
    }
    blobIndex[record.path] = {
      base: status === 'added' ? null : base,
      head: status === 'removed' ? null : head,
    }
  }

  return { files, rawStatuses, blobIndex, skippedBlobPaths }
}

/** The two commits a change set is read between. */
export type LocalDiffRange = Pick<LocalRange, 'mergeBaseSha' | 'headSha'>

/**
 * Reads the change set between two commits.
 *
 * There is no upper bound on how many files come back. The API-shaped producer
 * caps itself because it pages through a list and a very large pull would page
 * forever; one `git diff` emits every record in a single reply, so a cap here
 * would be an artifact copied from a constraint that does not exist on this path,
 * and it would silently truncate a large review.
 *
 * `core.quotePath=false` is passed explicitly even though `-z` already emits
 * paths verbatim: the guarantee then rests on the setting rather than on a
 * behaviour of the output format, and a path outside ASCII arrives as its own
 * bytes either way.
 */
export async function readLocalDiffFiles(
  runner: CommandRunner,
  cwd: string,
  range: LocalDiffRange,
): Promise<LocalDiffFilesResult> {
  const result = await runGit(runner, cwd, {
    args: ['-c', 'core.quotePath=false', 'diff', '--raw', '--no-abbrev', '-M', '-z'],
    revs: [range.mergeBaseSha, range.headSha],
  })
  if (!result.ok) return { ok: false, reason: 'diff_failed', code: result.code }
  const parsed = parseRawZ(result.stdout)
  if (!parsed.ok) return parsed
  return { ok: true, diff: buildLocalDiffFiles(parsed.records) }
}

// ————————————————————————————————————————————————————————————————————————————
// How many lines moved.
// ————————————————————————————————————————————————————————————————————————————

/**
 * One `--numstat -z` record. `additions` and `deletions` are already numbers:
 * git spells a binary file's counts as `-`, which carry no line information at
 * all, and those become zero with `binary` recording why — the same pair of
 * values the API-shaped producer reports for a binary file, so a consumer never
 * has to know which producer it came from.
 */
export interface NumstatRecord {
  readonly additions: number
  readonly deletions: number
  /** True when git spelled both counts as `-`, its notation for a binary file. */
  readonly binary: boolean
  /** The head-side path. For a rename, the post-image path. */
  readonly path: string
  /** The pre-image path, present only for a rename. */
  readonly previousPath?: string
}

export type NumstatParse =
  | { readonly ok: true; readonly records: readonly NumstatRecord[] }
  | MalformedDiff

/**
 * A `--numstat -z` field: two counts and then either the path or, for a rename,
 * nothing. The path is matched with an any-character class rather than `.`,
 * because `-z` exists precisely so a path may hold a newline.
 */
const NUMSTAT_FIELD = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/

/**
 * Reads `git diff --numstat -z` output into records.
 *
 * A record is one NUL-terminated field holding both counts and the path — except
 * for a rename, whose path position is **empty** and whose two paths follow as
 * their own fields. So how many fields a record spans is decided by whether the
 * path position was empty, which is why this walks the fields rather than
 * splitting on a record separator; there is none.
 *
 * Anything that is not that format is a typed failure rather than a skipped
 * record: a count this cannot read would leave a file claiming that nothing
 * changed in it, which is indistinguishable from a file where nothing did.
 */
export function parseNumstatZ(stdout: string): NumstatParse {
  const fields = stdout.split('\0')
  // Every field is NUL-terminated, so splitting leaves one trailing empty string.
  if (fields[fields.length - 1] === '') fields.pop()

  const records: NumstatRecord[] = []
  let index = 0
  while (index < fields.length) {
    const field = NUMSTAT_FIELD.exec(fields[index])
    if (field === null) {
      return malformed(`${JSON.stringify(fields[index])} is not a --numstat -z field`)
    }
    const [, added, deleted, path] = field
    const binary = added === '-' && deleted === '-'
    if (!binary && (added === '-' || deleted === '-')) {
      // git spells a binary file as `-` on BOTH sides. One `-` beside a number
      // is a shape git does not emit, and guessing which half to believe would
      // put a fabricated count on a file.
      return malformed(`counts ${JSON.stringify(`${added}\t${deleted}`)} are not a pair git emits`)
    }
    const counts = {
      additions: binary ? 0 : Number(added),
      deletions: binary ? 0 : Number(deleted),
      binary,
    }
    if (path.length > 0) {
      records.push({ ...counts, path })
      index += 1
      continue
    }
    const paths = fields.slice(index + 1, index + 3)
    if (paths.length < 2 || paths.some((candidate) => candidate.length === 0)) {
      return malformed(`an empty path field must be followed by two paths, got ${paths.length}`)
    }
    records.push({ ...counts, previousPath: paths[0], path: paths[1] })
    index += 3
  }
  return { ok: true, records }
}

// ————————————————————————————————————————————————————————————————————————————
// The patch text, split per file and trimmed to that file's own hunks.
// ————————————————————————————————————————————————————————————————————————————

/** How git opens each file's section in patch output. */
const PATCH_SECTION_START = 'diff --git '

/**
 * A hunk header at the start of a line. Nothing inside a hunk can be mistaken
 * for one: every body line carries a `+`, `-` or space marker in the first
 * column, so a line beginning with `@@` is always the header it looks like.
 */
const HUNK_HEADER_START = '@@ -'

/** Every line of `text`, as `[start, end)` offsets, with the terminators excluded. */
function* lineRanges(text: string): Generator<readonly [number, number]> {
  let cursor = 0
  for (;;) {
    const terminator = text.indexOf('\n', cursor)
    if (terminator === -1) {
      if (cursor < text.length) yield [cursor, text.length]
      return
    }
    yield [cursor, terminator]
    cursor = terminator + 1
  }
}

/**
 * Splits patch output into one section per file, each beginning at its own
 * `diff --git ` line and running to the start of the next.
 *
 * The boundary is a line that begins with `diff --git ` in the first column,
 * which no hunk body line can: a context line holding that text arrives with a
 * leading space, an added one with a `+` and a deleted one with a `-`. So the
 * split cannot be fooled by a repository whose own content is a patch.
 */
export function splitPatchSections(stdout: string): string[] {
  const sections: string[] = []
  let start = -1
  for (const [from] of lineRanges(stdout)) {
    if (!stdout.startsWith(PATCH_SECTION_START, from)) continue
    if (start !== -1) sections.push(stdout.slice(start, from))
    start = from
  }
  if (start !== -1) sections.push(stdout.slice(start))
  return sections
}

/**
 * One file's hunks, from its first hunk header to the end of its section, or
 * `undefined` when the section carries no hunk at all.
 *
 * Dropping everything before the first header is the whole point: those lines
 * introduce the file, and a reader that has already opened a hunk consumes them
 * as content — `--- a/x` as a deleted line, `+++ b/x` as an added one — which
 * shifts every line number after them. `undefined` rather than an empty string
 * for a section with no hunk, because absence and emptiness are different
 * claims: a binary file, a pure rename and a mode-only change all have no text
 * diff to show, which is not the same as showing an empty one.
 */
export function patchHunks(section: string): string | undefined {
  for (const [from] of lineRanges(section)) {
    if (!section.startsWith(HUNK_HEADER_START, from)) continue
    const body = section.slice(from)
    // git terminates the last line of a section; the wire shape carries a patch
    // as lines without a terminator, the way the API-shaped producer sends it.
    return body.endsWith('\n') ? body.slice(0, -1) : body
  }
  return undefined
}

/**
 * How many `diff --git ` sections one changed path occupies in patch output.
 *
 * Every status but one occupies a single section. A type change — a path whose
 * object class changes, a symlink replaced by a regular file, a submodule
 * replaced by either — occupies **two**: git has no single-section spelling for
 * "this stopped being a link and became a file", so it emits the change as a
 * deletion of the old class followed by a creation of the new one. The record
 * stream and the count stream still report such a path once each, which is
 * exactly why the three streams cannot be joined by index alone: they agree on
 * the order of the paths, never on how many entries each path spans.
 */
export function patchSectionCount(status: RawDiffStatus): number {
  return status === 'T' ? 2 : 1
}

/** How git introduces the removal of an object, and its creation. */
const DELETED_FILE_INTRODUCTION = 'deleted file mode '
const NEW_FILE_INTRODUCTION = 'new file mode '

/**
 * Whether a section's introduction — everything before its own first hunk header
 * — carries a line beginning with `marker`.
 *
 * The scan stops at the first hunk deliberately. Inside a hunk every line carries
 * a `+`, `-` or space marker in the first column, so a body line can never be
 * mistaken for an introduction line; stopping early makes that structural rather
 * than a property of the strings a repository happens to contain.
 */
function introduces(section: string, marker: string): boolean {
  for (const [from] of lineRanges(section)) {
    if (section.startsWith(HUNK_HEADER_START, from)) return false
    if (section.startsWith(marker, from)) return true
  }
  return false
}

// ————————————————————————————————————————————————————————————————————————————
// The three reads, joined.
// ————————————————————————————————————————————————————————————————————————————

/** A change set with the line counts and the patch text layered onto every file. */
export interface LocalChangeSet {
  /** One complete file per changed path, in the order git emitted them. */
  readonly files: readonly PullFile[]
  /** Keyed by head-side path. A path whose object cannot be read is absent. */
  readonly blobIndex: SnapshotImmutable['blobIndex']
  /** Head-side path → why that path has no blob index entry. */
  readonly skippedBlobPaths: Readonly<Record<string, BlobIndexSkipReason>>
  /**
   * Head-side paths git reported as binary. Carried beside the file list
   * because the wire shape has no field for it: there, a binary file is spelled
   * by an absent patch, which cannot distinguish binary from a diff git declined
   * to produce for some other reason. A reader wanting to say which is which
   * reads this.
   */
  readonly binaryPaths: readonly string[]
}

export type LocalChangeSetResult =
  | { readonly ok: true; readonly changeSet: LocalChangeSet }
  | MalformedDiff
  | DiffFailed

/**
 * What joining three already-read streams can produce. Narrower than the result
 * of reading them: nothing here spawns a command, so no exit code can arise.
 */
export type LocalChangeSetBuild =
  | { readonly ok: true; readonly changeSet: LocalChangeSet }
  | MalformedDiff

/**
 * Joins the three reads of one range into complete files.
 *
 * The join is by position, which is sound because all three commands walk git's
 * one diff queue — and it is only sound while the three agree, so a length
 * disagreement is refused here rather than absorbed. The counts additionally
 * carry their own path, verbatim under `-z`, and it is checked against the
 * `--raw` path at the same position: a silent shift by one would otherwise put
 * one file's line counts and another file's patch onto a third file's name.
 * The patch sections carry paths too, but only inside a header where a path
 * holding a quote or a newline arrives C-quoted, so they are matched by position
 * alone rather than through a second, weaker path parser.
 *
 * ## Why the patch sections are not counted one per file
 *
 * The three streams agree on the *order* of the paths, never on how many entries
 * each path spans. A type change spans one record, one count record and **two**
 * patch sections, so the expected number of sections is a sum over the statuses
 * rather than the length of the file list. Position is still what associates a
 * section with a file: the cursor advances by each file's own span, so the guard
 * stays as loud as it was for anything that is not the shape git documents —
 * a stream one section short, one section long, or carrying a pair whose two
 * sections are not the deletion-then-creation git emits for a type change, is
 * refused with what was expected and what arrived.
 *
 * ## Which of a pair's sections becomes the patch
 *
 * Both, reduced to their hunks and joined. The counts stream reports a type
 * change once, with the *union* of the two sides — the lines the old object lost
 * and the lines the new one gained — so a patch carrying one side would leave
 * the other side's count with nothing behind it. Joining the hunks rather than
 * the sections is what keeps the result a patch: a section carries the lines
 * that introduce its file, and a reader that has already opened a hunk consumes
 * those as content.
 *
 * A span whose sections do not all carry hunks produces no patch at all. git
 * declines a text diff for a side it considers binary, and half a change is not
 * a smaller truth than none — it is a patch whose line numbers describe a file
 * that never existed. The absent key already means "there is no diff to show
 * here", which is exactly the claim.
 */
export function buildLocalChangeSet(
  diff: LocalDiffFiles,
  counts: readonly NumstatRecord[],
  sections: readonly string[],
): LocalChangeSetBuild {
  if (counts.length !== diff.files.length) {
    return malformed(
      `${diff.files.length} changed file(s) but ${counts.length} line-count record(s)`,
    )
  }
  const spans = diff.rawStatuses.map(patchSectionCount)
  const expectedSections = spans.reduce((total, span) => total + span, 0)
  if (sections.length !== expectedSections) {
    return malformed(
      `${diff.files.length} changed file(s) span ${expectedSections} patch section(s), got ${sections.length}`,
    )
  }

  const files: PullFile[] = []
  const binaryPaths: string[] = []
  let cursor = 0
  for (const [index, entry] of diff.files.entries()) {
    const count = counts[index]
    if (count.path !== entry.filename) {
      return malformed(
        `line counts at position ${index} name ${JSON.stringify(count.path)}, the change set names ${JSON.stringify(entry.filename)}`,
      )
    }
    const span = sections.slice(cursor, cursor + spans[index])
    cursor += spans[index]
    if (
      span.length === 2 &&
      !(introduces(span[0], DELETED_FILE_INTRODUCTION) && introduces(span[1], NEW_FILE_INTRODUCTION))
    ) {
      return malformed(
        `the two patch sections for ${JSON.stringify(entry.filename)} are not a deletion followed by a creation`,
      )
    }
    const file: PullFile = {
      ...entry,
      additions: count.additions,
      deletions: count.deletions,
      changes: count.additions + count.deletions,
    }
    const hunks = span.map(patchHunks)
    // Assigned only when every section of the span has one, so a file with no
    // text diff carries no `patch` key at all rather than a key holding
    // undefined — the difference survives serialization, where an undefined
    // value does not.
    if (hunks.every((text) => text !== undefined)) file.patch = hunks.join('\n')
    files.push(file)
    if (count.binary) binaryPaths.push(entry.filename)
  }

  return {
    ok: true,
    changeSet: {
      files,
      blobIndex: diff.blobIndex,
      skippedBlobPaths: diff.skippedBlobPaths,
      binaryPaths,
    },
  }
}

/**
 * Reads the line counts for a range. `-M` matches the change-set read, so a
 * rename is one record there and one record here rather than a deletion and an
 * addition on one side and a rename on the other.
 */
export async function readLocalNumstat(
  runner: CommandRunner,
  cwd: string,
  range: LocalDiffRange,
): Promise<NumstatParse | DiffFailed> {
  const result = await runGit(runner, cwd, {
    args: ['-c', 'core.quotePath=false', 'diff', '--numstat', '-M', '-z'],
    revs: [range.mergeBaseSha, range.headSha],
  })
  if (!result.ok) return { ok: false, reason: 'diff_failed', code: result.code }
  return parseNumstatZ(result.stdout)
}

/**
 * Reads the patch text for a range, split into one section per file.
 *
 * The context width is stated explicitly rather than left to git's default: the
 * default is configurable per repository, and a patch's context width decides
 * which lines a comment can be anchored to, so leaving it ambient would let one
 * contractor's configuration change what another contractor can review.
 *
 * ## Why the patch text is asked for in git's own format, explicitly
 *
 * This is the one read of the three that a person's ordinary configuration can
 * take away. `diff.external` replaces the whole diff generator with another
 * program — difftastic, delta, anything — and the output is then that program's,
 * carrying no `diff --git` line at all. `color.diff = always` keeps git's format
 * but prefixes every structural line with an escape sequence, so neither the
 * line that opens a section nor the one that opens a hunk begins where it is
 * looked for. Either setting turns every review in that repository into a
 * refusal naming a malformed diff, and both are things people really set. The
 * two flags cost nothing where neither is configured, which is where git's own
 * defaults already produce this output.
 *
 * The record and count reads carry neither flag. Both settings are properties of
 * patch generation, and neither reaches `--raw` or `--numstat` output; a flag
 * that changes nothing about a command is a claim about that command nothing can
 * check.
 */
export async function readLocalPatchSections(
  runner: CommandRunner,
  cwd: string,
  range: LocalDiffRange,
): Promise<{ readonly ok: true; readonly sections: string[] } | DiffFailed> {
  const result = await runGit(runner, cwd, {
    args: [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-ext-diff',
      '--no-color',
      '-M',
      '--unified=3',
    ],
    revs: [range.mergeBaseSha, range.headSha],
  })
  if (!result.ok) return { ok: false, reason: 'diff_failed', code: result.code }
  return { ok: true, sections: splitPatchSections(result.stdout) }
}

/**
 * Reads a range's complete change set: what changed, which objects hold each
 * side, how many lines moved, and each file's own hunks.
 *
 * Three commands rather than one combined invocation, deliberately. git will
 * emit `--raw`, `--numstat` and `--patch` together, but the boundary between the
 * NUL-delimited sections and the plain-text patch section is then the fragile
 * part of the parse, and getting it wrong misreads every file rather than
 * failing. Three reads of one immutable pair of commits cost three subprocesses
 * and are each parsed by a function that does one thing.
 */
export async function readLocalChangeSet(
  runner: CommandRunner,
  cwd: string,
  range: LocalDiffRange,
): Promise<LocalChangeSetResult> {
  const diff = await readLocalDiffFiles(runner, cwd, range)
  if (!diff.ok) return diff
  const counts = await readLocalNumstat(runner, cwd, range)
  if (!counts.ok) return counts
  const patches = await readLocalPatchSections(runner, cwd, range)
  if (!patches.ok) return patches
  return buildLocalChangeSet(diff.diff, counts.records, patches.sections)
}

// ————————————————————————————————————————————————————————————————————————————
// The commits the range contains, oldest first.
// ————————————————————————————————————————————————————————————————————————————

/**
 * The record format the commit read asks for, and never git's default.
 *
 * Six fields per commit — the object name, its parents, the author's name and
 * address, the author date, and the raw message — separated by NUL, written as
 * git's own `%x00` escape rather than as a byte in this file. A NUL cannot occur
 * in an object name, an address or a date, and git will not let one into a
 * message, so no field needs escaping and none can be split by a message that
 * happens to contain a newline or a tab. The default output is a human-facing
 * shape no compatibility promise fixes; parsing it would mean parsing whatever
 * the installed git happens to print.
 */
const COMMIT_LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%B'

/**
 * How many NUL-terminated fields one commit record spans: the five the format
 * separates, plus the message, which the record terminator closes.
 */
const COMMIT_LOG_FIELDS = 6

/** git produced output, but not output in the format the commit read asked for. */
export interface MalformedCommitLog {
  readonly ok: false
  readonly reason: 'malformed_commit_log'
  readonly detail: string
}

/** The commit read itself failed. Carries the exit code that was observed. */
export interface CommitLogFailed {
  readonly ok: false
  readonly reason: 'commit_log_failed'
  readonly code: number
}

export type CommitLogParse =
  | { readonly ok: true; readonly commits: readonly CommitInfo[] }
  | MalformedCommitLog

function malformedCommitLog(detail: string): MalformedCommitLog {
  return { ok: false, reason: 'malformed_commit_log', detail }
}

/**
 * The author date as the same instant, spelled in UTC at millisecond precision.
 *
 * git prints a strict ISO timestamp carrying the author's own UTC offset. That
 * names the same instant but does not *compare* the same, and comparison is
 * what this field is used for: readers decide whether a commit landed after a
 * draft was written by comparing this string against a UTC-spelled one, and an
 * offset-bearing string sorts wrong against a UTC-spelled string for every
 * author outside UTC — a commit from an hour before a draft reads as an hour
 * after it. The comparison is reached whenever a draft's own head has fallen
 * out of the range, which on a branch that is amended and rebased is the
 * ordinary case rather than the rare one.
 *
 * The spelling is the draft timestamps' own, millisecond field included, which
 * is what makes the comparison a comparison of instants rather than of two
 * notations. It is not byte-identical to what the API-shaped producer emits:
 * that one passes a service's timestamp through untouched, and the service
 * spells the same instant to the second. Both are UTC, both compare correctly
 * against a draft, and neither is derived from the other — so the shared
 * property is the timezone, not the number of digits.
 *
 * Nothing is lost by converting: the offset is not information any reader of
 * this structure has ever had, because the API-shaped producer discards it too.
 *
 * A value that cannot be read as an instant is carried through unchanged. A
 * date this cannot parse is a fact about the repository, and replacing it with
 * a manufactured one would hide it.
 */
function authorDate(printed: string): string {
  const instant = Date.parse(printed)
  return Number.isNaN(instant) ? printed : new Date(instant).toISOString()
}

/**
 * Reads the record stream `COMMIT_LOG_FORMAT` produces into commit entries.
 *
 * Every entry's `author` is null. That field names a hosted account, and there
 * is no account behind a commit made in a local clone — the API-shaped producer
 * already answers null whenever the service names none, so null is a value the
 * consumers of this structure have always had to handle rather than a new one
 * invented here. The person who wrote the commit is not lost: git's own author
 * name, address and date travel in the commit's own author field, which is
 * exactly where the API-shaped producer puts them too.
 *
 * The message drops the single terminator git stores it with, so a message reads
 * the same here as it does from the API-shaped producer; nothing else about it
 * is touched, and a message that genuinely ends in a blank line keeps it. The
 * author date is converted to UTC for the same reason and with the same care —
 * see `authorDate`, where the comparison it exists to make correct is named.
 *
 * A stream this cannot read is a typed failure rather than a partial list. A
 * commit list missing entries is not a smaller truth: it is what a reconciler
 * slices to decide which commits landed after a draft was written, so a dropped
 * record silently changes that answer.
 */
export function parseCommitLogZ(stdout: string): CommitLogParse {
  const fields = stdout.split('\0')
  // Every record is NUL-terminated, so splitting leaves one trailing empty string.
  if (fields[fields.length - 1] === '') fields.pop()
  if (fields.length % COMMIT_LOG_FIELDS !== 0) {
    return malformedCommitLog(
      `${fields.length} field(s) is not a whole number of ${COMMIT_LOG_FIELDS}-field records`,
    )
  }

  const commits: CommitInfo[] = []
  for (let index = 0; index < fields.length; index += COMMIT_LOG_FIELDS) {
    const [sha, parentNames, name, address, date, body] = fields.slice(
      index,
      index + COMMIT_LOG_FIELDS,
    )
    // Both object-name checks also catch a stream that is not this format at
    // all but happens to hold a multiple of six fields: a misread record puts
    // something that is not an object name where one belongs.
    if (!OBJECT_NAME.test(sha)) {
      return malformedCommitLog(`${JSON.stringify(sha)} is not a full-length object name`)
    }
    // A root commit has no parents, and git spells that as an empty field
    // rather than as an absent one.
    const parents = parentNames.length === 0 ? [] : parentNames.split(' ')
    const stray = parents.find((parent) => !OBJECT_NAME.test(parent))
    if (stray !== undefined) {
      return malformedCommitLog(`${JSON.stringify(stray)} is not a full-length object name`)
    }
    commits.push({
      sha,
      commit: {
        message: body.endsWith('\n') ? body.slice(0, -1) : body,
        author: { name, email: address, date: authorDate(date) },
      },
      author: null,
      parents: parents.map((parent) => ({ sha: parent })),
    })
  }
  return { ok: true, commits }
}

/**
 * Reads the commits a range contains, **oldest first**.
 *
 * The order is the whole point of the flag that produces it. git prints history
 * newest first; the list this produces is sliced by finding a known commit in it
 * and taking everything after that position, which answers "what landed since"
 * only while the list runs forwards. Reversed, the same expression answers with
 * the commits *before* the known one and reports them as new — a wrong answer
 * that looks exactly like a right one.
 *
 * Signature reporting is refused rather than inherited. A repository or a user
 * may ask for every commit's signature to be verified and reported, and git
 * writes that report to standard output, ahead of the record the format asked
 * for — so a stream that was configured elsewhere would arrive with prose in
 * front of its first field.
 */
export async function readLocalCommits(
  runner: CommandRunner,
  cwd: string,
  range: LocalDiffRange,
): Promise<CommitLogParse | CommitLogFailed> {
  const result = await runGit(runner, cwd, {
    args: ['log', '--no-show-signature', '--reverse', '-z', `--format=${COMMIT_LOG_FORMAT}`],
    revs: [`${range.mergeBaseSha}..${range.headSha}`],
  })
  if (!result.ok) return { ok: false, reason: 'commit_log_failed', code: result.code }
  return parseCommitLogZ(result.stdout)
}

// ————————————————————————————————————————————————————————————————————————————
// The pull shape a local review presents, synthesized rather than fetched.
// ————————————————————————————————————————————————————————————————————————————

/**
 * The reviewer's display name as the repository records it, or null when it
 * records none.
 *
 * Only the name is ever asked for. The configured address is the key a person's
 * stored state is filed under, and a key belongs in no document that is handed
 * out — so this read does not merely decline to copy the address into a body,
 * it never obtains it.
 *
 * Null rather than a stand-in when git cannot say: a repository that names
 * nobody is a fact the caller can act on, and a fabricated name would be
 * indistinguishable from a real one.
 */
export async function readLocalAuthorName(
  runner: CommandRunner,
  cwd: string,
): Promise<string | null> {
  const result = await runGit(runner, cwd, { args: ['config', '--get', 'user.name'] })
  if (!result.ok) return null
  const name = result.stdout.trim()
  return name.length > 0 ? name : null
}

/**
 * The sentinel author everything a local review produces is attributed to.
 *
 * The display name rides in the login field, the only name-shaped field the
 * account shape has; the bot type marks it as not a genuine hosted account; the
 * URLs are empty because there is no page anywhere to link to; and the id is
 * zero, which sits outside every real band, since hosted account ids are
 * positive and nothing local mints one.
 */
export function synthesizeLocalUser(name: string): GhUser {
  return {
    login: name,
    id: 0,
    node_id: 'local:user',
    avatar_url: '',
    html_url: '',
    type: 'Bot',
  }
}

/** The prefixes a fully qualified ref is displayed without. */
const REF_DISPLAY_PREFIXES = ['refs/heads/', 'refs/remotes/'] as const

/**
 * The display form of a fully qualified ref. A remote-tracking ref keeps its
 * remote, because that is the part that tells it apart from the local branch of
 * the same name.
 */
function shortRefName(ref: string): string {
  for (const prefix of REF_DISPLAY_PREFIXES) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length)
  }
  return ref
}

/** What a local review is, in the parts git cannot answer. */
export interface LocalReviewIdentity {
  /** The review's local id. It is both its number and its id on the wire. */
  readonly id: number
  /** The repository identity the review is scoped to. */
  readonly repo: string
  /** The repository's default branch, as the pull shape reports it on both sides. */
  readonly defaultBranch: string
  /** Fully qualified base ref. */
  readonly baseRef: string
  /** Fully qualified head ref. */
  readonly headRef: string
  readonly title: string
  /** The pull request that superseded this review, or null while it stands alone. */
  readonly archivedPr: number | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** Everything the synthesized pull shape is built from. */
export interface LocalPullDetailInput {
  readonly review: LocalReviewIdentity
  /** The reviewer's display name. Never an address. */
  readonly authorName: string
  /** The resolved range: both tips and the merge base between them. */
  readonly range: LocalRange
  /** The assembled immutable half, which is where the counts come from. */
  readonly immutable: SnapshotImmutable
  /** How many review comments the review currently holds. */
  readonly reviewComments: number
}

/**
 * Builds the pull shape a local review presents, so every surface downstream of
 * a snapshot works without knowing which producer filled it.
 *
 * Each field has a legal local value rather than a placeholder:
 *
 *   - the id, number and node id are all derived from the local review's id, so
 *     re-synthesis never churns identity;
 *   - the state is open until a pull request supersedes the review;
 *   - the author is the sentinel above — a name, never an address;
 *   - both sides carry the branch's display name and the tip it resolved to;
 *     the base side names the base branch's tip, while the merge base travels
 *     in its own field, because they are different commits and a review that
 *     confused them would describe a different range;
 *   - mergeability is unknown and mergeable is null: nothing computes either
 *     locally, and both values are already part of the shape;
 *   - the counts are read off the change set the snapshot actually holds. Issue
 *     comments have no local existence at all, so that count is not one nobody
 *     filled in — zero is the only true answer.
 */
export function synthesizeLocalPullDetail(input: LocalPullDetailInput): PullDetail {
  const { review, authorName, range, immutable, reviewComments } = input
  const side = (ref: string, sha: string): GhRef => ({
    ref: shortRefName(ref),
    sha,
    label: shortRefName(ref),
    repo: { full_name: review.repo, default_branch: review.defaultBranch },
  })

  let additions = 0
  let deletions = 0
  for (const file of immutable.files) {
    additions += file.additions
    deletions += file.deletions
  }

  return {
    id: review.id,
    node_id: `local:${review.id}`,
    number: review.id,
    state: review.archivedPr === null ? 'open' : 'closed',
    draft: false,
    merged_at: null,
    title: review.title,
    body: null,
    user: synthesizeLocalUser(authorName),
    labels: [],
    requested_reviewers: [],
    head: side(review.headRef, range.headSha),
    base: side(review.baseRef, range.baseSha),
    created_at: review.createdAt,
    updated_at: review.updatedAt,
    merged: false,
    mergeable: null,
    mergeable_state: 'unknown',
    merge_base_sha: range.mergeBaseSha,
    comments: 0,
    review_comments: reviewComments,
    commits: immutable.commits.length,
    additions,
    deletions,
    changed_files: immutable.files.length,
  }
}

// ————————————————————————————————————————————————————————————————————————————
// The immutable half, assembled.
// ————————————————————————————————————————————————————————————————————————————

/** The parts of a resolved range the immutable half is built from. */
export type LocalSnapshotRange = Pick<LocalRange, 'compareKey' | 'mergeBaseSha' | 'headSha'>

/**
 * A range's immutable half, and the two details about it that the shape has no
 * field for.
 *
 * They are carried **beside** the immutable half rather than inside it. That
 * shape is stored verbatim and compared field for field against the one the
 * API-shaped producer builds, so a local-only detail added to it would be a
 * quiet divergence in a structure whose whole value is that both producers
 * agree on it.
 */
export interface LocalSnapshot {
  readonly immutable: SnapshotImmutable
  /** Head-side path → why that path has no blob index entry. */
  readonly skippedBlobPaths: Readonly<Record<string, BlobIndexSkipReason>>
  /** Head-side paths git reported as binary. */
  readonly binaryPaths: readonly string[]
}

export type LocalSnapshotResult =
  | { readonly ok: true; readonly snapshot: LocalSnapshot }
  | MalformedDiff
  | DiffFailed
  | MalformedCommitLog
  | CommitLogFailed

/**
 * Assembles the immutable half from a resolved range, its change set and its
 * commits: exactly the six fields the shape declares and nothing else.
 *
 * The base branch's tip is deliberately not among them. The reviewed range
 * starts at the merge base, and the base tip moves whenever the base branch
 * does — content keyed by it would be filed under a string that changes without
 * any of the content changing.
 *
 * The two lists are copied rather than referenced. The change set they come
 * from is read-only and this shape is not, so the copy is what makes the result
 * a value of its own instead of a mutable view onto something a caller still
 * holds.
 */
export function buildLocalSnapshotImmutable(
  range: LocalSnapshotRange,
  changeSet: LocalChangeSet,
  commits: readonly CommitInfo[],
): SnapshotImmutable {
  return {
    compareKey: range.compareKey,
    mergeBaseSha: range.mergeBaseSha,
    headSha: range.headSha,
    files: [...changeSet.files],
    blobIndex: changeSet.blobIndex,
    commits: [...commits],
  }
}

/**
 * Reads everything a range's immutable half is made of: what changed, which
 * objects hold each side, how many lines moved, each file's own hunks, and the
 * commits the range contains.
 *
 * Four reads of one immutable pair of commits. A read that fails stops the
 * assembly and is returned as it came, so a caller sees which read failed and
 * with what — never a snapshot assembled from three of four answers.
 */
export async function readLocalSnapshotImmutable(
  runner: CommandRunner,
  cwd: string,
  range: LocalSnapshotRange,
): Promise<LocalSnapshotResult> {
  const changeSet = await readLocalChangeSet(runner, cwd, range)
  if (!changeSet.ok) return changeSet
  const commits = await readLocalCommits(runner, cwd, range)
  if (!commits.ok) return commits
  return {
    ok: true,
    snapshot: {
      immutable: buildLocalSnapshotImmutable(range, changeSet.changeSet, commits.commits),
      skippedBlobPaths: changeSet.changeSet.skippedBlobPaths,
      binaryPaths: changeSet.changeSet.binaryPaths,
    },
  }
}

/**
 * What a worktree holds relative to the commits a review covers.
 *
 * Three states rather than a flag, because "the question could not be answered"
 * is a genuinely different answer from "answered, nothing outstanding". A
 * repository with no worktree at all, or one whose index is held by another
 * process, produces no reading — and collapsing that into `clean` at the point
 * of measurement is how a warning stops appearing without anyone deciding it
 * should. The third state travels; what a caller does with it, including how it
 * is stored somewhere that only has room for a flag, is the caller's decision to
 * make in the open.
 */
export type WorktreeState = 'clean' | 'dirty' | 'unknown'

/**
 * Reads whether the worktree holds changes the reviewed range does not contain.
 *
 * The range is built from commits, so anything uncommitted is by definition
 * outside it. This read is what lets a reader be told so, and it is deliberately
 * only a read: the worktree is observed, never taken into the review.
 *
 * ## A file git has never been told about is not an uncommitted change
 *
 * `-uno` is stated explicitly, and the choice it encodes is the whole value of
 * the reading. The claim being made is "there is work here the review does not
 * cover"; a scratch file, a stray build artifact or a directory of dependencies
 * that the ignore rules do not quite cover is not work the review is missing —
 * it is content nobody has offered for review at all. Counting those would raise
 * the warning in nearly every working repository, and a warning that is always
 * on is a warning nobody reads, which costs exactly the case it exists for: an
 * edit sitting in a tracked file that the reader believes they are reviewing.
 *
 * The flag is written out rather than left to git, because the untracked-file
 * mode is configurable and its default is to include them. Left ambient, one
 * clone's configuration would decide what another clone's reader is told.
 *
 * ## An unreadable worktree degrades, it never fails the read
 *
 * Every failure — a non-zero exit, an unspawnable git, a runner that rejects
 * outright — becomes `unknown`. The commits half of a review is already read and
 * complete by the time this runs, and losing all of it because a supplementary
 * observation could not be made would trade a large certainty for a small one.
 * Outcomes are decided by the exit code, never by matching the message text.
 */
export async function detectDirtyWorktree(
  runner: CommandRunner,
  cwd: string,
): Promise<WorktreeState> {
  let result
  try {
    result = await runGit(runner, cwd, { args: ['status', '--porcelain=v1', '-uno'] })
  } catch {
    // The runner's contract allows a rejection when git cannot be spawned at
    // all. That is one more way of not knowing, not a different kind of event.
    return 'unknown'
  }
  if (!result.ok) return 'unknown'
  // The porcelain format prints one record per outstanding path and nothing at
  // all when there are none, so the presence of any content is the answer.
  return result.stdout.trim().length > 0 ? 'dirty' : 'clean'
}
