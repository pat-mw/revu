import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TokenSource } from '../direct/token-source'

/**
 * The broker-mode `TokenSource`: read the GitHub token an external host-side
 * broker injects into the workspace's `~/.git-credentials` file. The broker
 * mints a short-lived installation token OUTSIDE this process and pushes it into
 * the file; this module adds no credential of its own — it only reads what is
 * ambiently present, so the custody surface stays exactly the injected file.
 *
 * The file is re-read on EVERY `getToken()` call, never cached: the host
 * rotates the credential well within a process lifetime and may transiently
 * truncate or remove the file while refreshing it (including a gap right after
 * container boot, before the first credential lands). Caching would pin a
 * revoked token; re-reading returns whatever token is current at that moment.
 *
 * Token custody rule (inherited from `TokenSource`): the token exists only as
 * the resolved return value to the in-process caller. It is never logged, never
 * placed in an error message or stack, and never crosses the HTTP boundary.
 */

/** The environment variable that overrides the credential-file location. */
const CREDENTIALS_FILE_ENV_VAR = 'REVU_CREDENTIALS_FILE'

/** The git-credential-store username convention for an App installation token. */
const INSTALLATION_TOKEN_USER = 'x-access-token'

/** The credential host this source serves tokens for. */
const GITHUB_HOST = 'github.com'

/**
 * The shape of a POSIX errno mnemonic (`ENOENT`, `EACCES`, ...). A read failure
 * is only tagged with its `code` when the code matches this — so a reader that
 * throws with a `code` set to arbitrary content cannot smuggle that content into
 * a surfaced error message.
 */
const ERRNO_MNEMONIC = /^[A-Z][A-Z0-9_]{0,31}$/

/**
 * The injected credential file holds no usable GitHub token RIGHT NOW: the file
 * is missing, empty, or carries no parseable `github.com` entry. This is a
 * transient per-request state — the host-side broker writes and refreshes the
 * file on its own schedule, so the correct reaction is to retry the request
 * shortly, NOT to stop the process. It is deliberately a distinct type from
 * `NoTokenError` (a fatal there-is-no-way-to-get-a-token condition) so callers
 * can map the two differently. By contract the message and `detail` carry no
 * token material and no file content.
 */
export class AwaitingCredentialError extends Error {
  constructor(detail?: string) {
    super(
      'No GitHub credential is available in the injected credential file yet. ' +
        'The host-side broker writes it and refreshes it periodically; ' +
        'this is transient — retry shortly.' +
        (detail !== undefined && detail.length > 0 ? ` (${detail})` : ''),
    )
    this.name = 'AwaitingCredentialError'
  }
}

export interface FileCredentialTokenSourceOptions {
  /**
   * Credential file to read. Takes precedence over the environment override;
   * defaults to `~/.git-credentials` under `os.homedir()`.
   */
  path?: string
  /** Environment consulted for `REVU_CREDENTIALS_FILE`; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /**
   * Injected file reader (a test seam). The default reads the file
   * synchronously as UTF-8. A reader may throw to signal an unreadable or
   * missing file; every reader failure is folded into
   * `AwaitingCredentialError` (carrying at most the error `code`, never the
   * error message, so an injected reader can never smuggle content into the
   * thrown text).
   */
  readFile?: (path: string) => string
}

/**
 * Build the file-reading `TokenSource`. The path is resolved once (explicit
 * option → `REVU_CREDENTIALS_FILE` → `~/.git-credentials`); the file CONTENT is
 * read fresh on every call. Throws `AwaitingCredentialError` whenever no usable
 * token is present — missing file, empty file, or no `github.com` entry.
 */
export function createFileCredentialTokenSource(
  opts: FileCredentialTokenSourceOptions = {},
): TokenSource {
  const env = opts.env ?? process.env
  const path =
    opts.path ?? env[CREDENTIALS_FILE_ENV_VAR] ?? join(homedir(), '.git-credentials')
  const readFile = opts.readFile ?? ((p: string): string => readFileSync(p, 'utf8'))

  return {
    async getToken(): Promise<string> {
      let content: string
      try {
        content = readFile(path)
      } catch (err) {
        // A missing file (ENOENT) is the expected pre-injection state; any other
        // read failure is treated the same transient way because the file is
        // host-managed and may be mid-swap. The detail is derived so that
        // whatever the reader throws — a non-object, an error with an arbitrary
        // `code`, a message embedding secrets — nothing reader-controlled beyond
        // a recognised errno mnemonic can reach the thrown text.
        throw new AwaitingCredentialError(readFailureDetail(err))
      }

      if (content.trim().length === 0) {
        throw new AwaitingCredentialError('credential file is empty')
      }

      const token = selectGithubToken(content)
      if (token === null) {
        throw new AwaitingCredentialError(
          'credential file has no usable github.com entry',
        )
      }
      return token
    },
  }
}

/**
 * Describe a credential-file read failure without echoing anything the failing
 * reader controls beyond a recognised errno mnemonic. A missing file is the
 * expected pre-injection state; every other failure is reported as an opaque
 * "unreadable", tagged with the errno code only when it has the shape of a POSIX
 * errno mnemonic. Any other thrown shape — a non-object (`throw null`), an error
 * whose `code` is absent or arbitrary — yields no tag, so the custody boundary
 * holds regardless of how a reader fails.
 */
function readFailureDetail(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined
  if (code === 'ENOENT') return 'credential file not found'
  return typeof code === 'string' && ERRNO_MNEMONIC.test(code)
    ? `credential file unreadable: ${code}`
    : 'credential file unreadable'
}

/**
 * Pick the GitHub token out of git-credential-store content. Each line is an
 * `https` credential URL (`https://<user>:<password>@<host>`); the token is the
 * password of a `github.com` entry. An `x-access-token` entry (the App
 * installation convention) is preferred over any other `github.com` user, in
 * any line order; among multiple `x-access-token` entries the first wins,
 * mirroring `git credential fill`. This assumes the broker REPLACES the entry on
 * rotation (as `git credential approve` does) rather than appending — an
 * append-style writer would pin the oldest, revoked token. A non-`x-access-token`
 * github.com entry is used only as a last-resort fallback (e.g. a coexisting
 * human PAT); acceptable in a broker-owned disposable workspace. Blank lines,
 * lines that do not parse as `https` URLs, non-github hosts, and entries without
 * a password are all skipped. Git percent-encodes the password on write, so it
 * is decoded once before returning (WHATWG `URL` does not decode `password`);
 * a password whose percent-encoding does not decode is skipped as malformed.
 * Returns null when no entry yields a token — the caller turns that into the
 * typed awaiting state, without ever echoing the file content.
 */
function selectGithubToken(content: string): string | null {
  let fallback: string | null = null
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    let url: URL
    try {
      url = new URL(line)
    } catch {
      continue
    }
    if (url.protocol !== 'https:') continue
    if (url.hostname !== GITHUB_HOST) continue
    if (url.password.length === 0) continue

    let password: string
    try {
      password = decodeURIComponent(url.password)
    } catch {
      continue
    }
    if (password.length === 0) continue

    if (url.username === INSTALLATION_TOKEN_USER) return password
    if (fallback === null) fallback = password
  }
  return fallback
}
