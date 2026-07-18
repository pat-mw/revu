import type { CommandRunner } from './command-runner'

/**
 * Resolving which GitHub repository direct mode acts against. The owner/name
 * pair comes from `git remote get-url origin` by default, parsed from either the
 * https or the ssh remote form, and can be overridden explicitly by a caller
 * (a `--repo owner/name` flag or `REVU_REPO`) for a clone whose origin is not
 * the GitHub repo being reviewed.
 *
 * Parsing is total and defensive: an origin that is not a github.com URL, or an
 * override that is not `owner/name`, resolves to `null` rather than a guess, so
 * the refuse-to-start guard can turn "no valid GitHub repo" into a clear error
 * instead of the daemon silently pointing at the wrong place.
 */

export interface RepoRef {
  owner: string
  repo: string
}

/**
 * A single owner/name path segment: GitHub allows letters, digits, `.`, `_`,
 * and `-`, and neither segment is ever empty. The parser strips a trailing
 * `.git` before matching, so a `.git` suffix never leaks into `repo`.
 */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/

/**
 * Parse an explicit `owner/name` override (from `--repo` or `REVU_REPO`).
 * Returns `null` for anything that is not exactly two non-empty, well-formed
 * segments — extra slashes, a blank side, or an illegal character all reject,
 * so a malformed override is caught by the start guard rather than silently
 * split. A trailing `.git` on the name is tolerated and stripped.
 */
export function parseRepoOverride(value: string): RepoRef | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const parts = trimmed.split('/')
  if (parts.length !== 2) return null
  const owner = parts[0]
  const repo = stripGitSuffix(parts[1])
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo)) return null
  return { owner, repo }
}

/**
 * Parse an `origin` remote URL into an owner/name pair. Handles the two forms
 * `git remote get-url origin` emits for a github.com clone:
 *
 *   - https: `https://github.com/owner/repo.git` (also `http://`, an embedded
 *     `user@`/`user:token@` credential, and a trailing slash)
 *   - ssh:   `git@github.com:owner/repo.git` (scp-like) and the explicit
 *     `ssh://git@github.com/owner/repo.git` form
 *
 * Returns `null` for a non-github.com host or any URL that does not yield
 * exactly two path segments, so a non-GitHub origin is reported as "not a
 * GitHub repo" rather than misparsed. Only `github.com` is accepted; GitHub
 * Enterprise hosts are out of scope for this resolver.
 */
export function parseOriginUrl(url: string): RepoRef | null {
  const raw = url.trim()
  if (raw.length === 0) return null

  // scp-like ssh form: [user@]host:owner/repo(.git) — no scheme, colon splits
  // host from path. Distinguished from a scheme URL by the absence of `://`.
  if (!raw.includes('://')) {
    const at = raw.lastIndexOf('@')
    const afterUser = at === -1 ? raw : raw.slice(at + 1)
    const colon = afterUser.indexOf(':')
    if (colon === -1) return null
    const host = afterUser.slice(0, colon)
    if (!isGithubHost(host)) return null
    return parsePath(afterUser.slice(colon + 1))
  }

  // Scheme URL form: https, http, or ssh. Parse with the URL API so credentials
  // and ports are handled uniformly, and match the host explicitly.
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (!isGithubHost(parsed.hostname)) return null
  return parsePath(parsed.pathname)
}

/** True for `github.com` (case-insensitive); Enterprise hosts are not accepted. */
function isGithubHost(host: string): boolean {
  return host.toLowerCase() === 'github.com'
}

/**
 * Split a remote path (`/owner/repo.git`, `owner/repo`, …) into owner/name.
 * Leading/trailing slashes are ignored and a trailing `.git` is stripped; a
 * path that does not have exactly two well-formed segments returns `null`.
 */
function parsePath(path: string): RepoRef | null {
  const segments = path.split('/').filter((s) => s.length > 0)
  if (segments.length !== 2) return null
  const owner = segments[0]
  const repo = stripGitSuffix(segments[1])
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo)) return null
  return { owner, repo }
}

/** Drop a single trailing `.git` suffix if present. */
function stripGitSuffix(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -'.git'.length) : name
}

/**
 * Why repo resolution failed, so the start guard can print an actionable line.
 *   - `no-remote`: `git remote get-url origin` failed (no origin, or not a git
 *     repo at all).
 *   - `unparsable`: the origin URL is not a parseable github.com repo URL.
 *   - `bad-override`: the explicit override was not `owner/name`.
 */
export type RepoResolutionError =
  | { kind: 'no-remote'; detail: string }
  | { kind: 'unparsable'; originUrl: string }
  | { kind: 'bad-override'; value: string }

export type RepoResolution =
  | { ok: true; repo: RepoRef; source: 'override' | 'origin' }
  | { ok: false; error: RepoResolutionError }

/**
 * Resolve the target repo for direct mode. An explicit override (already read
 * from `--repo`/`REVU_REPO` by the caller) wins and is validated; otherwise the
 * origin remote is read via the injected `CommandRunner` and parsed. Every
 * failure is a typed `RepoResolution` with `ok: false` — this function never
 * throws — so the guard renders one clear message and exits non-zero.
 */
export async function resolveRepo(
  runner: CommandRunner,
  opts: { override?: string; cwd?: string },
): Promise<RepoResolution> {
  if (opts.override !== undefined && opts.override.length > 0) {
    const parsed = parseRepoOverride(opts.override)
    if (parsed === null) {
      return { ok: false, error: { kind: 'bad-override', value: opts.override } }
    }
    return { ok: true, repo: parsed, source: 'override' }
  }

  const result = await runner.run(
    ['git', 'remote', 'get-url', 'origin'],
    opts.cwd !== undefined ? { cwd: opts.cwd } : undefined,
  )
  if (!result.ok) {
    return {
      ok: false,
      error: { kind: 'no-remote', detail: result.stderr.trim() || 'git remote get-url origin failed' },
    }
  }
  const originUrl = result.stdout.trim()
  const parsed = parseOriginUrl(originUrl)
  if (parsed === null) {
    return { ok: false, error: { kind: 'unparsable', originUrl } }
  }
  return { ok: true, repo: parsed, source: 'origin' }
}
