/**
 * The hardened seam every local git invocation goes through: ref normalization,
 * argv construction, and repository discovery. This is the only module on the
 * local review path that constructs git argv arrays.
 *
 * ## The threat this seam exists for
 *
 * The command runner spawns an argv array with no shell, so shell injection is
 * impossible — and option injection is not. A ref name beginning with `-` is
 * read by git as a flag: `--upload-pack=<cmd>` executes an attacker's command
 * and `--output=<path>` overwrites an attacker's chosen file, both from an
 * ordinary argument position. `git check-ref-format` is no defense: it accepts
 * `refs/heads/--upload-pack=x` (exit 0, pinned against real git by this
 * module's test suite), and handed a dash-leading name directly it consumes the
 * name as an option (exit 129) — failing closed for the wrong reason. The real
 * defenses, layered:
 *
 *   1. `normalizeRef` rejects hostile shapes before anything else looks at the
 *      value — rejection first, because validation of a value that can still be
 *      read as a flag proves nothing;
 *   2. every ref that survives is fully qualified (`refs/…`), a shape that
 *      cannot begin with `-`;
 *   3. `runGit` places every rev behind `--end-of-options` (honored by git
 *      ≥ 2.24) and every pathspec behind `--`, and refuses to spawn — without
 *      calling the runner at all — any argv the `isHardenedArgv` predicate
 *      rejects.
 *
 * ## Working directories are discovered, never assumed
 *
 * Nothing here reads the process working directory. Every function takes an
 * explicit `cwd`, and `discoverRepoRoot` resolves it to the repository's real
 * toplevel, so a worktree or subdirectory invocation acts on the repository it
 * is actually inside rather than on wherever the daemon happened to start.
 */
import type { BranchRef } from '@revu/shared'
import type { CommandResult, CommandRunner } from './command-runner'
import { isHardenedArgv } from './local-git-argv'
import { resolveRepo } from './repo'

/** Which ref namespace a name is normalized into. */
export type RefKind = 'branch' | 'remote'

const REF_NAMESPACE: Record<RefKind, string> = {
  branch: 'refs/heads/',
  remote: 'refs/remotes/',
}

/**
 * Why a ref name was rejected before normalization:
 *   - `empty`: the empty string names nothing.
 *   - `leading-dash`: git would read the value as an option — the injection
 *     shape this whole module exists to stop.
 *   - `control-character`: an ASCII control byte (including newline and tab)
 *     is never legal in a ref and can smuggle record separators into parsed
 *     output.
 *   - `whitespace`: a space would split the meaning of the name for any human
 *     or tool reading it back, and git rejects it anyway.
 *   - `dot-dot`: `..` turns a single name into a range expression.
 *   - `foreign-namespace`: an already-qualified name under a different
 *     namespace than the caller asked for; prefixing it would silently produce
 *     a legal ref pointing at nothing the caller meant.
 */
export type RefRejectionReason =
  | 'empty'
  | 'leading-dash'
  | 'control-character'
  | 'whitespace'
  | 'dot-dot'
  | 'foreign-namespace'

export type NormalizeRefResult =
  | { ok: true; ref: string }
  | { ok: false; reason: RefRejectionReason }

/**
 * Rejects hostile shapes, then fully qualifies the name. Rejection comes first
 * because it is what makes the value safe to look at: normalization is what
 * makes the value un-flag-like, validation is what makes it well-formed, and
 * both happen here in that order. Well-formedness beyond these screens (a
 * trailing `.lock`, an empty segment) is real git's judgement, via
 * `checkRefFormat`, on the already-qualified result.
 *
 * A name already qualified under the requested namespace passes through
 * byte-identical, so a picker-supplied fully-qualified ref and a user-typed
 * short name normalize to the same string and downstream keys never fork.
 */
export function normalizeRef(input: string, kind: RefKind): NormalizeRefResult {
  if (input.length === 0) return { ok: false, reason: 'empty' }
  if (input.startsWith('-')) return { ok: false, reason: 'leading-dash' }
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return { ok: false, reason: 'control-character' }
    if (/\s/.test(ch)) return { ok: false, reason: 'whitespace' }
  }
  if (input.includes('..')) return { ok: false, reason: 'dot-dot' }
  const namespace = REF_NAMESPACE[kind]
  if (input.startsWith('refs/')) {
    if (!input.startsWith(namespace)) return { ok: false, reason: 'foreign-namespace' }
    return { ok: true, ref: input }
  }
  return { ok: true, ref: `${namespace}${input}` }
}

/**
 * The exit code reported when this seam refused to spawn at all. Distinct from
 * the runner's `-1` (the executable could not be spawned) and from every real
 * git exit: a blocked argv means the command was never run, and callers that
 * classify outcomes by exit code can name that case explicitly.
 */
export const GIT_ARGV_BLOCKED = -2

function blocked(reason: string): CommandResult {
  return { ok: false, code: GIT_ARGV_BLOCKED, stdout: '', stderr: reason }
}

/** One git invocation, with its operands declared rather than inferred. */
export interface GitCommand {
  /** The subcommand and its options, e.g. `['rev-parse', '--verify']`. */
  readonly args: readonly string[]
  /** Rev operands. Emitted behind `--end-of-options`. */
  readonly revs?: readonly string[]
  /** Pathspec operands. Emitted behind `--`. */
  readonly pathspecs?: readonly string[]
  /**
   * Bytes for the command's standard input. Git's batch plumbing reads its work
   * from there, which keeps values out of the argv entirely — the strongest
   * form of the option-injection defense this seam exists for, since a value
   * that never reaches an argument cannot be read as one.
   */
  readonly stdin?: string
}

/**
 * Runs one git command through the hardened argv form: `git` is always the
 * executable, every rev operand sits behind `--end-of-options`, and every
 * pathspec sits behind `--`. The operands are declared by the caller rather
 * than guessed from shape, and the assembled argv is checked against
 * `isHardenedArgv` before the runner sees it — an argv the predicate rejects is
 * returned as a `GIT_ARGV_BLOCKED` result with nothing spawned, so the
 * predicate the tests sweep with is also the last gate on the production path.
 *
 * A non-zero git exit is a result, never a throw; callers classify by the exit
 * code they observe, never by stderr text.
 */
export async function runGit(
  runner: CommandRunner,
  cwd: string,
  command: GitCommand,
): Promise<CommandResult> {
  const argv = ['git', ...command.args]
  const revs = command.revs ?? []
  const pathspecs = command.pathspecs ?? []
  if (revs.length > 0) argv.push('--end-of-options', ...revs)
  if (pathspecs.length > 0) argv.push('--', ...pathspecs)
  const verdict = isHardenedArgv(argv)
  if (!verdict.ok) return blocked(verdict.reason)
  return runner.run(argv, { cwd, ...(command.stdin !== undefined ? { stdin: command.stdin } : {}) })
}

/**
 * Asks real git whether an already-qualified ref name is well-formed: exit 0
 * means valid. Only ever called with a `refs/`-prefixed string — that prefix is
 * load-bearing, because `git check-ref-format` does not implement
 * `--end-of-options` (exit 129, pinned by the test suite), so the qualified
 * shape is the only thing standing between this argument and git's option
 * parser. An argument that is not `refs/`-qualified is refused here with
 * `GIT_ARGV_BLOCKED` and the runner is never called.
 */
export async function checkRefFormat(
  runner: CommandRunner,
  cwd: string,
  qualifiedRef: string,
): Promise<CommandResult> {
  if (!qualifiedRef.startsWith('refs/')) {
    return blocked(
      `check-ref-format takes only refs/-qualified names; got ${JSON.stringify(qualifiedRef)}`,
    )
  }
  const argv = ['git', 'check-ref-format', qualifiedRef]
  const verdict = isHardenedArgv(argv)
  if (!verdict.ok) return blocked(verdict.reason)
  return runner.run(argv, { cwd })
}

export type RepoRootResult = { ok: true; root: string } | { ok: false; code: number }

/**
 * Resolves a directory to its repository's real toplevel via
 * `git rev-parse --show-toplevel`. A subdirectory or linked-worktree invocation
 * resolves to the toplevel git itself reports — which is also the symlink-
 * resolved form of the path, so callers comparing against it must compare
 * resolved paths. A failure is typed and carries the observed exit code; there
 * is no fallback directory, because a guessed root is worse than no root.
 */
export async function discoverRepoRoot(
  runner: CommandRunner,
  cwd: string,
): Promise<RepoRootResult> {
  const result = await runGit(runner, cwd, { args: ['rev-parse', '--show-toplevel'] })
  if (!result.ok) return { ok: false, code: result.code }
  const root = result.stdout.trim()
  if (root.length === 0) return { ok: false, code: result.code }
  return { ok: true, root }
}

export type RepoIdentityResult =
  | { ok: true; identity: string; source: 'origin' | 'root' }
  | { ok: false; code: number }

/**
 * The string that identifies which repository a local review belongs to:
 * `owner/name` whenever the origin remote parses as a hosted repository, and
 * otherwise the discovered toplevel path. Never empty and never a hash —
 * downstream comparison against an `owner/name` pair only works on the literal
 * spelling. The identity is resolved from what the repository is at the moment
 * of asking, so a clone that gains an origin after its first local review was
 * keyed will resolve differently from then on; rows keyed earlier keep the
 * path-shaped identity they were created under, deliberately.
 */
export async function repoIdentity(
  runner: CommandRunner,
  cwd: string,
): Promise<RepoIdentityResult> {
  const resolution = await resolveRepo(runner, { cwd })
  if (resolution.ok) {
    return {
      ok: true,
      identity: `${resolution.repo.owner}/${resolution.repo.repo}`,
      source: 'origin',
    }
  }
  const root = await discoverRepoRoot(runner, cwd)
  if (!root.ok) return { ok: false, code: root.code }
  return { ok: true, identity: root.root, source: 'root' }
}

/**
 * The record format the branch listing asks for, and never git's default.
 *
 * An explicit format is mandatory. The default `for-each-ref` output is a
 * human-facing shape that no compatibility promise fixes, so parsing it would
 * mean parsing whatever the installed git happens to print — and a listing that
 * silently lost its format would hand this module's parser a stream it never
 * agreed to read. Fields are separated by NUL, the one byte a ref name can never
 * contain, and records by newline, so no field needs escaping and none can be
 * split by a name carrying a slash or whitespace.
 *
 * Three fields are requested where a branch listing needs one. The object name
 * and the checked-out marker have no home in the listing's shape, but a fixed
 * field count is what lets the parser tell the requested format apart from any
 * other output — the second line of defense behind the argv itself.
 */
const FOR_EACH_REF_FORMAT = '%(refname)%00%(objectname)%00%(HEAD)'

/**
 * The two namespaces a review side may come from. Remote-tracking refs are
 * listed alongside local branches because a base is frequently tracked and never
 * checked out; the namespace travels with each entry so a caller can offer the
 * right set on each side without re-reading the ref name.
 */
const BRANCH_NAMESPACES = ['refs/heads', 'refs/remotes'] as const

const LOCAL_BRANCH_PREFIX = 'refs/heads/'
const REMOTE_BRANCH_PREFIX = 'refs/remotes/'

/**
 * The symbolic ref recording which branch the origin remote calls its default,
 * and the prefix its target is expected to carry. A repository with no origin
 * simply does not have this ref.
 */
const REMOTE_HEAD_REF = 'refs/remotes/origin/HEAD'
const ORIGIN_BRANCH_PREFIX = 'refs/remotes/origin/'

/**
 * True for `refs/remotes/<remote>/HEAD` exactly.
 *
 * That ref is a symbolic ref, not a branch: it points at whichever
 * remote-tracking branch the remote calls its default, so listing it would put a
 * second, differently-spelled copy of that branch in front of the reader — one
 * that silently follows the remote if the default ever changes. The default it
 * names is read separately and applied as a marker on the branch itself.
 *
 * The test is anchored on the namespace and on the segment depth rather than on
 * a `/HEAD` suffix, because every looser spelling excludes a real branch: one
 * named `HEAD` under a further segment (`refs/remotes/origin/feature/HEAD`), one
 * merely beginning with those letters (`refs/remotes/origin/HEADless`), and any
 * local branch at all, which is never a remote's symbolic ref however it is
 * spelled.
 */
function isRemoteDefaultSymref(ref: string): boolean {
  if (!ref.startsWith(REMOTE_BRANCH_PREFIX)) return false
  const withinRemotes = ref.slice(REMOTE_BRANCH_PREFIX.length).split('/')
  return withinRemotes.length === 2 && withinRemotes[1] === 'HEAD'
}

/**
 * Parses the record stream `FOR_EACH_REF_FORMAT` produces. Pure, so the record
 * shapes can be asserted without a repository or a runner standing behind them.
 *
 * Every ref comes back fully qualified — the same form ref normalization
 * produces — so the string a caller hands back is the string everything
 * downstream keys on, with no re-derivation anywhere. A record whose field count
 * is not the requested one is not the format this parser asked for and is
 * skipped, as is any ref outside the two branch namespaces.
 *
 * No entry is marked as the default here: the default is not in this stream.
 */
export function parseForEachRefZ(stdout: string): BranchRef[] {
  const branches: BranchRef[] = []
  for (const record of stdout.split('\n')) {
    // Exactly the requested field count, and no other: a record of any other
    // shape did not come from the format above, and the one this parser would
    // most readily mis-read is the shortest — a bare ref name, which parses
    // perfectly well and means nothing was pinned. This also disposes of the
    // empty record left behind by the stream's final newline.
    const fields = record.split('\0')
    if (fields.length !== 3) continue
    const ref = fields[0]
    if (isRemoteDefaultSymref(ref)) continue
    if (ref.startsWith(LOCAL_BRANCH_PREFIX)) {
      const name = ref.slice(LOCAL_BRANCH_PREFIX.length)
      branches.push({ ref, name, kind: 'local', isDefault: false })
      continue
    }
    // Each namespace is tested in turn rather than one being the other's
    // fallback: a ref under neither is not a branch and must not be admitted as
    // whichever kind happens to be written last.
    if (ref.startsWith(REMOTE_BRANCH_PREFIX)) {
      const name = ref.slice(REMOTE_BRANCH_PREFIX.length)
      branches.push({ ref, name, kind: 'remote', isDefault: false })
    }
  }
  return branches
}

/**
 * The local branch the origin remote calls its default, fully qualified, or
 * `null` when the repository cannot say.
 *
 * A clone with no origin has no such symbolic ref and the probe exits non-zero
 * with `--quiet` suppressing any diagnostic — the ordinary state of a repository
 * reviewed purely locally. So every non-zero exit degrades to "no default is
 * known" rather than to a failure, and the outcome is decided by the exit code
 * alone; the diagnostic text is never read.
 *
 * The symbolic ref names a remote-tracking branch, and the marker is moved onto
 * the local branch of the same name because a remote-tracking ref is a second
 * copy of one branch: marking it would preselect a base spelled differently from
 * the branch the reader thinks of as the default. When no local branch of that
 * name is listed, nothing is marked.
 */
async function readDefaultBranchRef(
  runner: CommandRunner,
  cwd: string,
): Promise<string | null> {
  const probe = await runGit(runner, cwd, {
    args: ['symbolic-ref', '--quiet'],
    revs: [REMOTE_HEAD_REF],
  })
  if (!probe.ok) return null
  const target = probe.stdout.trim()
  // The probe asks about one remote, so its target is expected under that
  // remote; anything else is not a shape this can translate. Being wrong here
  // costs a marker that matches no listed branch, never a marker on the wrong
  // branch, because only an exact ref match applies it.
  if (!target.startsWith(ORIGIN_BRANCH_PREFIX)) return null
  return `${LOCAL_BRANCH_PREFIX}${target.slice(ORIGIN_BRANCH_PREFIX.length)}`
}

/**
 * Every branch this repository can offer as a review side: local branches and
 * remote-tracking refs together, each fully qualified and carrying which
 * namespace it came from, with the default branch marked when the repository
 * knows one.
 *
 * A repository with no branches at all — freshly initialized, nothing committed
 * — lists nothing and is an empty array, never a failure. A read that actually
 * fails is not quietly turned into that same empty array: an unreadable
 * repository and a repository with no branches are different facts and must not
 * arrive as one.
 */
export async function listBranches(runner: CommandRunner, cwd: string): Promise<BranchRef[]> {
  const listed = await runGit(runner, cwd, {
    args: ['for-each-ref', `--format=${FOR_EACH_REF_FORMAT}`],
    revs: BRANCH_NAMESPACES,
  })
  if (!listed.ok) {
    throw new Error(`branches could not be listed: git for-each-ref exited ${listed.code}`)
  }
  const branches = parseForEachRefZ(listed.stdout)
  const defaultRef = await readDefaultBranchRef(runner, cwd)
  if (defaultRef === null) return branches
  return branches.map((branch) =>
    branch.ref === defaultRef ? { ...branch, isDefault: true } : branch,
  )
}
