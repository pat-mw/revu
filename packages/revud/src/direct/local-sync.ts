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
 */
import type { PullFile, SnapshotImmutable } from '@revu/shared'
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
  const blobIndex: SnapshotImmutable['blobIndex'] = {}
  const skippedBlobPaths: Record<string, BlobIndexSkipReason> = {}

  for (const record of records) {
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

  return { files, blobIndex, skippedBlobPaths }
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
  if (sections.length !== diff.files.length) {
    return malformed(`${diff.files.length} changed file(s) but ${sections.length} patch section(s)`)
  }

  const files: PullFile[] = []
  const binaryPaths: string[] = []
  for (const [index, entry] of diff.files.entries()) {
    const count = counts[index]
    if (count.path !== entry.filename) {
      return malformed(
        `line counts at position ${index} name ${JSON.stringify(count.path)}, the change set names ${JSON.stringify(entry.filename)}`,
      )
    }
    const file: PullFile = {
      ...entry,
      additions: count.additions,
      deletions: count.deletions,
      changes: count.additions + count.deletions,
    }
    const patch = patchHunks(sections[index])
    // Assigned only when there is one, so a file with no text diff carries no
    // `patch` key at all rather than a key holding undefined — the difference
    // survives serialization, where an undefined value does not.
    if (patch !== undefined) file.patch = patch
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
 */
export async function readLocalPatchSections(
  runner: CommandRunner,
  cwd: string,
  range: LocalDiffRange,
): Promise<{ readonly ok: true; readonly sections: string[] } | DiffFailed> {
  const result = await runGit(runner, cwd, {
    args: ['-c', 'core.quotePath=false', 'diff', '-M', '--unified=3'],
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
