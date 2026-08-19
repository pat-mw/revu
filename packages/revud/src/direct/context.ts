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
 * A boot that reviews local branches needs none of that GitHub half, so the
 * requirement is an option rather than a fixture: with it lifted the repo and its
 * client are typed-absent instead of blank, the boot issues no request, and the
 * git-config identity guard still stands.
 *
 * Everything external is injected: the `CommandRunner` (git/gh), the GitHub
 * `fetch`, and the environment. Nothing here reaches a real subprocess or the
 * network on its own, so the whole guard is unit-testable with fakes.
 */

/** The parts of the context that exist whether or not a repository was resolved. */
interface DirectContextBase {
  session: Session
  tokenSource: TokenSource
  /** The subprocess runner used for git/gh — reused by the local-first blob provider. */
  runner: CommandRunner
  /** The directory git commands run in (the repo clone); where blob `cat-file` reads. */
  cwd: string
}

/**
 * A context that resolved a GitHub repository: the repo and the client that
 * addresses it are both present, so every GitHub-backed surface can be wired.
 */
export interface GithubDirectContext extends DirectContextBase {
  repo: RepoRef
  github: GithubClient
}

/**
 * A context that started without a GitHub repository — a review of local
 * branches, which needs no origin, no token, and no viewer.
 *
 * The GitHub half is absent by TYPE, never blank. A `{ owner: '', repo: '' }`
 * stand-in would let a consumer build request paths like `/repos///pulls/204`,
 * which GitHub answers 404 with a message that blames the pull request rather
 * than the missing repository. Consumers must narrow instead of interpolating.
 */
export interface LocalDirectContext extends DirectContextBase {
  repo?: undefined
  github?: undefined
}

/** The assembled context the server runs against, with or without GitHub. */
export type DirectContext = GithubDirectContext | LocalDirectContext

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

/**
 * Narrow a context to its GitHub-backed shape, or refuse to start.
 *
 * The boot paths that talk to GitHub resolve their context with the GitHub
 * requirement in force, so the repo is always present by the time they wire
 * anything up. This makes that invariant one the compiler checks rather than one
 * every consumer assumes: relaxing the requirement on a GitHub-backed path
 * becomes a refusal with an actionable message, not a stream of requests to
 * `/repos///…`.
 */
export function requireGithubContext(context: DirectContext): GithubDirectContext {
  if (context.repo === undefined) {
    throw new DirectStartupError(
      'This mode needs a GitHub repository, but the context was resolved without ' +
        'one. Run revud from inside a cloned GitHub repo, or pass --repo owner/name ' +
        '(or set REVU_REPO=owner/name).',
    )
  }
  return context
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
   * Defaults to `requireGithub`, so an unauthenticated direct setup fails at boot
   * rather than on the first request. Set `false` when the credential is injected
   * asynchronously by an external host and may legitimately be absent for a short
   * window at container start: boot then proceeds and the absent-credential state
   * is surfaced per request instead of stopping the daemon.
   */
  validateToken?: boolean
  /**
   * Whether a usable GitHub repository is a precondition for starting. Defaults
   * to `true`: an unresolvable repo stops the daemon, exactly as before.
   *
   * Set `false` to boot for a review of local branches, which needs no origin,
   * no token, and no viewer. An unresolvable repo is then recorded as the
   * typed-absent GitHub half of `LocalDirectContext` instead of thrown, the token
   * probe defaults off, and the session is built by the zero-GitHub-call path.
   * The git-config identity guard is NOT relaxed: the email keys drafts and
   * viewed state, so an unset `user.email` still refuses to start.
   */
  requireGithub?: boolean
}

/**
 * Resolve and validate everything the daemon needs, or throw
 * `DirectStartupError`. In order:
 *
 *   1. Resolve the repo (override → origin remote). A missing origin, a
 *      non-github.com origin, or a malformed override each stop startup with a
 *      message naming the cause and the `--repo owner/name` escape hatch —
 *      unless `requireGithub` is `false`, which records the failure as an absent
 *      GitHub half instead.
 *   2. Prove a token is obtainable. `gh` unauthenticated with no env token stops
 *      startup with the `gh auth login` / `GH_TOKEN` guidance. The token is
 *      fetched once to fail fast; it is not logged or returned.
 *   3. Build the session (git-config identity + `GET /user` viewer login).
 *
 * A GitHub error while reading the viewer (a revoked or wrong-scoped token) is
 * also a hard start failure, surfaced with the HTTP status so the user can act.
 *
 * With `requireGithub: false` — a review of local branches — every one of those
 * GitHub preconditions relaxes: no origin is needed, the token probe defaults
 * off, and the session comes from the zero-GitHub-call path, so the boot makes
 * no request at all. The git-config identity guard is deliberately untouched:
 * `user.email` is the key drafts and viewed state are filed under, so an unset
 * one still refuses to start rather than collapsing every human onto one blank
 * id the store could not tell apart afterwards.
 */
export async function resolveDirectContext(
  opts: DirectResolveOptions = {},
): Promise<DirectContext> {
  const env = opts.env ?? process.env
  const runner = opts.runner ?? createBunCommandRunner()
  const requireGithub = opts.requireGithub ?? true

  // 1. Repo resolution. Required by default; when it is not required, an
  //    unresolvable repo is the absent GitHub half rather than a start failure.
  const override = opts.repoOverride ?? env.REVU_REPO
  const resolution = await resolveRepo(runner, {
    ...(override !== undefined ? { override } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  })
  if (!resolution.ok && requireGithub) {
    throw new DirectStartupError(repoErrorMessage(resolution.error))
  }
  const repo = resolution.ok ? resolution.repo : undefined

  // 2. Token custody — build (or accept) the source. The default is the
  //    `gh`-backed direct source; an injected source swaps the custody surface
  //    (e.g. a host-injected ambient credential) while every other assembly step
  //    stays identical. By default a token is fetched once to prove the setup is
  //    authenticated, so an unauthenticated direct setup fails at startup rather
  //    than on the first call. Validation is skipped when the credential is
  //    injected asynchronously and may be absent at boot for a short window, and
  //    defaults off when GitHub is not required at all — a local-branch review
  //    has nothing to authenticate to.
  const tokenSource = opts.tokenSource ?? createDirectTokenSource(runner, env)
  const validateToken = opts.validateToken ?? requireGithub
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

  // 3. Session build — git-config identity plus the viewer's own login. The
  //    client is built only when a repo resolved: with nothing to address a
  //    request to, an absent client is the honest shape and no consumer can
  //    mis-call one.
  const github =
    repo === undefined
      ? undefined
      : createGithubClient({
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
    // (GitHub answers 403). Identity comes from git config, and the bot's own
    // login — when the deployment configures one — from the environment, so
    // boot never depends on a present credential. A local-branch review takes
    // that same path for the same reason, one step further: with no repo there
    // is nothing to be the viewer OF, so the GitHub-free assembly is the only
    // one available and the boot issues no request.
    if (repo !== undefined && github !== undefined && validateToken) {
      session = await buildDirectSession({
        runner,
        github,
        repo,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        env,
      })
    } else {
      session = await buildBrokerSession({
        runner,
        ...(repo !== undefined ? { repo } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        env,
      })
    }
  } catch (err) {
    // Git-config identity errors stop startup with their own already-actionable
    // messages (broker mode makes no GitHub call here, so no viewer error arises).
    throw new DirectStartupError(err instanceof Error ? err.message : String(err))
  }

  // The cwd git ran in is where the blob provider's `git cat-file` must read the
  // clone; carry it (and the runner) so the local-first blob path uses the same
  // seam startup validated against.
  const cwd = opts.cwd ?? process.cwd()
  if (repo === undefined || github === undefined) {
    return { session, tokenSource, runner, cwd }
  }
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
