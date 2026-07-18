import type { Session } from '@revu/shared'
import type { CommandRunner } from './command-runner'
import { createBunCommandRunner } from './command-runner'
import type { FetchLike, GithubClient } from './github-client'
import { createGithubClient } from './github-client'
import type { RepoRef } from './repo'
import { resolveRepo } from './repo'
import type { TokenSource } from './token-source'
import { createDirectTokenSource, NoTokenError } from './token-source'
import { buildBrokerSession, buildDirectSession } from './session'

/**
 * The direct-mode bring-up: resolve the target repo, prove a GitHub token is
 * obtainable, build the real session, and hand back the pieces the server needs.
 * This is where the refuse-to-start guard lives — every failure that should stop
 * the daemon is a `DirectStartupError`, thrown here, so the entry point can print
 * one actionable line and exit non-zero.
 *
 * Everything external is injected: the `CommandRunner` (git/gh), the GitHub
 * `fetch`, and the environment. Nothing here reaches a real subprocess or the
 * network on its own, so the whole guard is unit-testable with fakes.
 */

/** The assembled direct-mode context the server runs against. */
export interface DirectContext {
  session: Session
  repo: RepoRef
  tokenSource: TokenSource
  github: GithubClient
  /** The subprocess runner used for git/gh — reused by the local-first blob provider. */
  runner: CommandRunner
  /** The directory git commands run in (the repo clone); where blob `cat-file` reads. */
  cwd: string
}

/**
 * A direct-mode precondition failed and the daemon must not start. The message
 * is written to be shown to a user verbatim: it names what is wrong and how to
 * fix it. It never contains token material.
 */
export class DirectStartupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectStartupError'
  }
}

/** Read the repo override from `--repo`/`REVU_REPO`, already parsed by the caller. */
export interface DirectResolveOptions {
  runner?: CommandRunner
  fetchImpl?: FetchLike
  githubBaseUrl?: string
  env?: Record<string, string | undefined>
  /** Directory the git commands run in; defaults to the process cwd. */
  cwd?: string
  /** Explicit `owner/name` override (from `--repo` or `REVU_REPO`). */
  repoOverride?: string
  /**
   * The credential strategy the GitHub client authenticates with. When omitted,
   * the `gh`-backed direct source is built from the runner and env. Supplying one
   * is how the same engine is brought up against a different custody surface (an
   * ambient host-injected credential) without duplicating any of the assembly.
   */
  tokenSource?: TokenSource
  /**
   * Whether to prove a token is obtainable at startup by fetching one once.
   * Defaults to `true`, so an unauthenticated direct setup fails at boot rather
   * than on the first request. Set `false` when the credential is injected
   * asynchronously by an external host and may legitimately be absent for a short
   * window at container start: boot then proceeds and the absent-credential state
   * is surfaced per request instead of stopping the daemon.
   */
  validateToken?: boolean
}

/**
 * Resolve and validate everything direct mode needs, or throw
 * `DirectStartupError`. In order:
 *
 *   1. Resolve the repo (override → origin remote). A missing origin, a
 *      non-github.com origin, or a malformed override each stop startup with a
 *      message naming the cause and the `--repo owner/name` escape hatch.
 *   2. Prove a token is obtainable. `gh` unauthenticated with no env token stops
 *      startup with the `gh auth login` / `GH_TOKEN` guidance. The token is
 *      fetched once to fail fast; it is not logged or returned.
 *   3. Build the session (git-config identity + `GET /user` viewer login).
 *
 * A GitHub error while reading the viewer (a revoked or wrong-scoped token) is
 * also a hard start failure, surfaced with the HTTP status so the user can act.
 */
export async function resolveDirectContext(
  opts: DirectResolveOptions = {},
): Promise<DirectContext> {
  const env = opts.env ?? process.env
  const runner = opts.runner ?? createBunCommandRunner()

  // 1. Repo resolution.
  const override = opts.repoOverride ?? env.REVU_REPO
  const resolution = await resolveRepo(runner, {
    ...(override !== undefined ? { override } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  })
  if (!resolution.ok) {
    throw new DirectStartupError(repoErrorMessage(resolution.error))
  }
  const repo = resolution.repo

  // 2. Token custody — build (or accept) the source. The default is the
  //    `gh`-backed direct source; an injected source swaps the custody surface
  //    (e.g. a host-injected ambient credential) while every other assembly step
  //    stays identical. By default a token is fetched once to prove the setup is
  //    authenticated, so an unauthenticated direct setup fails at startup rather
  //    than on the first call. Validation is skipped when the credential is
  //    injected asynchronously and may be absent at boot for a short window.
  const tokenSource = opts.tokenSource ?? createDirectTokenSource(runner, env)
  const validateToken = opts.validateToken ?? true
  if (validateToken) {
    try {
      await tokenSource.getToken()
    } catch (err) {
      if (err instanceof NoTokenError) {
        throw new DirectStartupError(err.message)
      }
      throw err
    }
  }

  // 3. Session build — git-config identity plus the viewer's own login.
  const github = createGithubClient({
    tokenSource,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.githubBaseUrl !== undefined ? { baseUrl: opts.githubBaseUrl } : {}),
  })

  let session: Session
  try {
    // Direct mode validates the token at boot, so the viewer fetch is proven to
    // work and the full session (with `viewerLogin` from `GET /user`) is built.
    // Broker mode (validation skipped) does NOT probe the viewer at all: its
    // GitHub App installation token cannot resolve a login via `GET /user`
    // (GitHub answers 403), so `viewerLogin` is absent by design and identity
    // comes from git config alone — boot never depends on a present credential.
    session = validateToken
      ? await buildDirectSession({
          runner,
          github,
          repo,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          env,
        })
      : await buildBrokerSession({
          runner,
          repo,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          env,
        })
  } catch (err) {
    // Git-config identity errors stop startup with their own already-actionable
    // messages (broker mode makes no GitHub call here, so no viewer error arises).
    throw new DirectStartupError(err instanceof Error ? err.message : String(err))
  }

  // The cwd git ran in is where the blob provider's `git cat-file` must read the
  // clone; carry it (and the runner) so the local-first blob path uses the same
  // seam startup validated against.
  const cwd = opts.cwd ?? process.cwd()
  return { session, repo, tokenSource, github, runner, cwd }
}

/** Turn a repo-resolution failure into the exact line the user should read. */
function repoErrorMessage(error: {
  kind: 'no-remote' | 'unparsable' | 'bad-override'
  detail?: string
  originUrl?: string
  value?: string
}): string {
  switch (error.kind) {
    case 'no-remote':
      return (
        'Direct mode needs a GitHub repository, but no `origin` remote was found ' +
        `in this directory (${error.detail ?? 'git remote get-url origin failed'}). ` +
        'Run revud from inside a cloned GitHub repo, or pass --repo owner/name ' +
        '(or set REVU_REPO=owner/name).'
      )
    case 'unparsable':
      return (
        `The origin remote (${error.originUrl ?? ''}) is not a recognizable github.com ` +
        'repository URL. Direct mode only supports github.com; pass --repo owner/name ' +
        '(or set REVU_REPO=owner/name) to name the repository explicitly.'
      )
    case 'bad-override':
      return (
        `The repository override "${error.value ?? ''}" is not in owner/name form. ` +
        'Pass --repo owner/name (for example --repo octocat/hello-world).'
      )
  }
}
