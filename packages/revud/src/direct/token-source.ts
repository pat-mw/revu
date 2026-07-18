import type { CommandRunner } from './command-runner'

/**
 * Where the GitHub token comes from. This is the strategy seam that lets one
 * shared core serve every deployment mode: direct mode reads the local `gh`
 * credential (this file), and a future broker mode fetches an installation
 * token from the host — each is one `TokenSource` implementation, injected, with
 * nothing else in the pipeline aware of the difference.
 *
 * Token custody rule: a `TokenSource` is the only thing that ever holds token
 * material. It is never returned over any HTTP route and never logged — an
 * implementation must not print the token, and callers must not either.
 */
export interface TokenSource {
  /**
   * Resolve the GitHub token, or throw `NoTokenError` when none is available.
   * The token is returned to the in-process caller only (the GitHub client); it
   * never crosses the HTTP boundary.
   */
  getToken(): Promise<string>
}

/**
 * No GitHub token could be obtained: neither an environment override nor an
 * authenticated `gh` produced one. The message is actionable — it names the two
 * ways to fix it — and, by contract, contains no token material (there was
 * none). The guard turns this into a non-zero exit at startup.
 */
export class NoTokenError extends Error {
  constructor(detail?: string) {
    super(
      'No GitHub token available for direct mode. ' +
        'Run `gh auth login` to authenticate the GitHub CLI, ' +
        'or set GH_TOKEN (or GITHUB_TOKEN) to a token in the environment.' +
        (detail !== undefined && detail.length > 0 ? ` (${detail})` : ''),
    )
    this.name = 'NoTokenError'
  }
}

/** The environment variables an explicit token override may be set in, in order of precedence. */
const TOKEN_ENV_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const

/**
 * The direct-mode `TokenSource`: prefer an environment token, else ask the
 * authenticated `gh` CLI.
 *
 * Precedence matches `gh` itself — `GH_TOKEN` then `GITHUB_TOKEN` — so a token
 * exported in the environment (CI, a scripted run) overrides the stored `gh`
 * credential without a login. When neither env var is set, it shells out to
 * `gh auth token` via the injected `CommandRunner`; a non-zero exit (an
 * unauthenticated `gh`, or `gh` absent entirely) becomes a `NoTokenError`.
 *
 * The token is trimmed and returned to the caller; it is never logged, and the
 * command's stderr — which may name the account but not the token — is folded
 * into the error only when no token was produced.
 */
export function createDirectTokenSource(
  runner: CommandRunner,
  env: Record<string, string | undefined> = process.env,
): TokenSource {
  return {
    async getToken(): Promise<string> {
      for (const name of TOKEN_ENV_VARS) {
        const value = env[name]
        if (value !== undefined && value.trim().length > 0) {
          return value.trim()
        }
      }

      const result = await runner.run(['gh', 'auth', 'token'])
      if (!result.ok) {
        // stderr may say "not logged in" or "gh: command not found"; neither
        // carries token material, so it is safe to surface as the failure detail.
        throw new NoTokenError(result.stderr.trim() || `gh auth token exited with code ${result.code}`)
      }
      const token = result.stdout.trim()
      if (token.length === 0) {
        throw new NoTokenError('gh auth token returned an empty token')
      }
      return token
    },
  }
}
