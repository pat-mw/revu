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
  return runner.run(argv, { cwd })
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
