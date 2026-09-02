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
 * requirement is an option rather than a fixture. With it lifted the half is
 * kept ALL-OR-NOTHING: only a clone whose half stands up end to end — origin
 * resolved, token obtained, viewer probed — keeps repo, client, and viewer
 * together, exactly as a required boot does; anything less — no origin, no
 * usable credential, or a GitHub that could not be reached or refused the
 * probe — drops all three as typed absences rather than blanks. A boot with
 * nothing to authenticate to issues no request at all; one whose probe failed
 * spent only that probe. The git-config identity guard still stands either
 * way.
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
   * Defaults on whenever there is a GitHub half to stand behind it — GitHub is
   * required, or a repository resolved anyway — so an unauthenticated direct
   * setup fails at boot rather than on the first request, and an optional-GitHub
   * boot never keeps a repository without a usable GitHub half — token
   * obtained AND viewer probed — behind it. Set `false` when
   * the credential is injected asynchronously by an external host and may
   * legitimately be absent for a short window at container start: boot then
   * proceeds and the absent-credential state is surfaced per request instead of
   * stopping the daemon.
   */
  validateToken?: boolean
  /**
   * Whether a usable GitHub repository is a precondition for starting. Defaults
   * to `true`: an unresolvable repo stops the daemon, exactly as before.
   *
   * Set `false` to boot for a review of local branches, which needs no origin,
   * no token, no network, and no viewer. The GitHub half is then kept
   * all-or-nothing: an unresolvable repo, or a resolvable one with no usable
   * GitHub half behind it — no obtainable token, a credential GitHub rejects,
   * or a GitHub that cannot be reached at all — becomes the typed-absent half
   * of `LocalDirectContext` instead of a thrown refusal, and the session is
   * built by the GitHub-free path. A repo whose half DOES stand up is kept
   * whole — token proven, client built, viewer probed — never as a
   * viewer-less GitHub surface, because the write guards compare against the
   * viewer login and silently invert on a blank one. The git-config identity
   * guard is NOT relaxed: the email keys drafts and viewed state, so an unset
   * `user.email` still refuses to start.
   */
  requireGithub?: boolean
  /**
   * Where the one diagnostic this function emits goes: the line announcing that
   * the GitHub half was shed. Defaults to `console.warn`; tests inject a capture
   * so the line is asserted directly instead of scraped from process output.
   */
  log?: (message: string) => void
}

/**
 * The safe description of a failure that shed the GitHub half: enough to tell
 * the causes apart in a log, built ONLY from fields the code itself authored.
 *
 * Nothing from the error's message reaches the caller. A credential can ride in
 * an error's free text — a credential-store reader quoting the line it read, a
 * proxy echoing the presented token back in a response body that an HTTP error
 * excerpts, a URL carrying the token in its userinfo. Redacting that text would
 * be a denylist against an unbounded space of token shapes, so it is not
 * attempted; these three admitted fields are an allowlist instead.
 *
 *   - The class name, and only when it is a bare identifier of bounded length.
 *     Class names are literals in this repository's source, never built from
 *     credential material.
 *   - The HTTP status, and only an integer in the real response range. This is
 *     what separates "GitHub refused the credential" from "GitHub never
 *     answered at all".
 *   - The errno mnemonic, and only in the SCREAMING_SNAKE shape libuv and the C
 *     library produce. No GitHub token matches it: every issued prefix
 *     (`ghp_`, `gho_`, `ghs_`, `github_pat_`) is lowercase.
 *
 * Anything outside those shapes degrades to a generic word rather than being
 * passed through.
 */
function describeShedCause(err: unknown): string {
  const parts: string[] = []

  const name = err instanceof Error ? err.name : ''
  parts.push(/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : 'unknown error')

  const status = (err as { status?: unknown }).status
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    parts.push(`HTTP ${status}`)
  }

  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && /^[A-Z][A-Z0-9]{1,15}(_[A-Z0-9]{1,15}){0,3}$/.test(code)) {
    parts.push(code)
  }

  return parts.join(', ')
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
 * With `requireGithub: false` — a review of local branches — those GitHub
 * preconditions become droppable instead of fatal, and they drop TOGETHER: no
 * origin means no GitHub half, and a resolvable origin with no usable half
 * behind it — a token that cannot be obtained, one GitHub rejects, or a
 * GitHub that cannot be reached to probe the viewer — sheds the repo too
 * rather than keeping a surface no client can authenticate to and no viewer
 * stands behind. Only when every precondition holds is the half kept, and
 * then it is kept whole — token proven, viewer probed — exactly as a required
 * boot keeps it. A boot that dropped the half builds its session from the
 * GitHub-free path; with nothing to authenticate to it makes no request at
 * all, and when the viewer probe itself failed, that failed probe was the
 * only request spent. The git-config identity guard is deliberately
 * untouched: `user.email` is the key drafts and viewed state are filed under,
 * so an unset one still refuses to start rather than collapsing every human
 * onto one blank id the store could not tell apart afterwards.
 */
export async function resolveDirectContext(
  opts: DirectResolveOptions = {},
): Promise<DirectContext> {
  const env = opts.env ?? process.env
  const runner = opts.runner ?? createBunCommandRunner()
  const requireGithub = opts.requireGithub ?? true
  const log = opts.log ?? console.warn

  // The step whose failure shed the GitHub half, recorded rather than logged on
  // the spot: the warning promises the daemon is continuing without GitHub, and
  // that promise is only true once the GitHub-free session has actually been
  // built. A shed followed by a fatal git-identity failure must not leave a
  // "continuing" line in front of an operator whose daemon did not start.
  let shedStep: string | undefined
  let shedCause = ''

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
  let repo = resolution.ok ? resolution.repo : undefined

  // 2. Token custody — build (or accept) the source. The default is the
  //    `gh`-backed direct source; an injected source swaps the custody surface
  //    (e.g. a host-injected ambient credential) while every other assembly step
  //    stays identical. By default a token is fetched once whenever a GitHub
  //    half exists to stand behind it, so an unauthenticated direct setup fails
  //    at startup rather than on the first call. Validation is skipped when the
  //    credential is injected asynchronously and may be absent at boot for a
  //    short window, and defaults off only when there is no repo at all —
  //    nothing to authenticate to.
  const tokenSource = opts.tokenSource ?? createDirectTokenSource(runner, env)
  const validateToken = opts.validateToken ?? (requireGithub || repo !== undefined)
  if (validateToken) {
    try {
      await tokenSource.getToken()
    } catch (err) {
      if (requireGithub) {
        if (!(err instanceof NoTokenError)) throw err
        throw new DirectStartupError(err.message)
      }
      // GitHub is optional and no usable credential exists — whatever shape
      // the failure took, the typed no-token absence or a source failing in
      // its own way: drop the GitHub half WHOLE rather than keep a repo no
      // client can authenticate to. A kept repo would report this daemon
      // GitHub-capable while its session carries no viewer login, and the
      // write guards keyed on that login — the self-review gate and the
      // submit idempotency re-check — silently invert on a blank one: every
      // verdict refused with a false reason, every retried submit
      // double-posted. All-or-nothing: repo, client, and viewer together, or
      // none of them.
      //
      // Recorded only when a repo had actually resolved: with no origin there
      // was no half to lose, and that boot is the designed local-only case
      // rather than a degradation worth a warning.
      if (repo !== undefined) {
        shedStep = 'obtaining a GitHub credential'
        shedCause = describeShedCause(err)
      }
      repo = undefined
    }
  }

  // 3. Session build — git-config identity plus the viewer's own login. The
  //    client is built only when a repo resolved: with nothing to address a
  //    request to, an absent client is the honest shape and no consumer can
  //    mis-call one.
  let github =
    repo === undefined
      ? undefined
      : createGithubClient({
          tokenSource,
          ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.githubBaseUrl !== undefined ? { baseUrl: opts.githubBaseUrl } : {}),
        })

  let session: Session
  try {
    // A GitHub half that survived token validation attempts the full session:
    // git-config identity plus `viewerLogin` from `GET /user`. Obtaining a
    // token locally proves nothing about the network or about GitHub accepting
    // it, so the viewer probe itself may still fail — a required boot stops on
    // that, while an optional one sheds the half and rebuilds locally (the
    // inner catch). Broker mode (validation skipped) does NOT probe the viewer
    // at all: its GitHub App installation token cannot resolve a login via
    // `GET /user` (GitHub answers 403). Identity comes from git config, and
    // the bot's own login — when the deployment configures one — from the
    // environment, so boot never depends on a present credential. A boot whose
    // GitHub half dropped takes that same GitHub-free path for the same
    // reason, one step further: with no repo there is nothing to be the viewer
    // OF, so no request is issued at all.
    if (repo !== undefined && github !== undefined && validateToken) {
      try {
        session = await buildDirectSession({
          runner,
          github,
          repo,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          env,
        })
      } catch (err) {
        if (requireGithub) throw err
        // The full session could not be built — an unreachable GitHub, or a
        // credential it rejects — on a boot that does not require GitHub. The
        // half sheds WHOLE here for the same reason a missing token sheds it
        // above, and the session is rebuilt from git config alone.
        // Deliberately no error classification: `buildBrokerSession` re-reads
        // the identity through the same builder, so a missing git identity —
        // the one failure that must stay fatal, because the email keys drafts
        // and viewed state — surfaces from the retry unchanged. That same lack
        // of classification is why the shed is only RECORDED here: an identity
        // failure caught at this point is about to be raised again by the
        // retry, and must not be announced as a daemon that carried on.
        shedStep = 'probing the GitHub viewer'
        shedCause = describeShedCause(err)
        repo = undefined
        github = undefined
        session = await buildBrokerSession({
          runner,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          env,
        })
      }
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
    // messages, and a required boot's viewer errors carry their HTTP status
    // (broker mode makes no GitHub call here, so no viewer error arises).
    throw new DirectStartupError(err instanceof Error ? err.message : String(err))
  }

  // The cwd git ran in is where the blob provider's `git cat-file` must read the
  // clone; carry it (and the runner) so the local-first blob path uses the same
  // seam startup validated against.
  const cwd = opts.cwd ?? process.cwd()

  // The half was shed and the GitHub-free session stood up, so the daemon is
  // genuinely continuing: say so once, naming the step that failed and the
  // sanitized cause. Without this the startup line shows only the ABSENCE of a
  // repo, which cannot tell a missing credential from a rejected one from a
  // network that was down for the length of one probe — and reading the reason
  // otherwise means re-running with GitHub required. The consequence is spelled
  // out because the cause alone does not tell an operator what they now have.
  if (shedStep !== undefined) {
    log(
      `revud: dropped the GitHub half while ${shedStep} (${shedCause}); continuing ` +
        `without GitHub — this daemon serves local reviews only, and pull requests ` +
        `stay unavailable until it is restarted against a reachable GitHub with a ` +
        `credential it accepts.`,
    )
  }

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
