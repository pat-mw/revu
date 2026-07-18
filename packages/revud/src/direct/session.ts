import type { Human, Session } from '@revu/shared'
import { emailToId } from '@revu/shared'
import type { CommandRunner } from './command-runner'
import type { GithubViewerClient } from './github-client'
import type { RepoRef } from './repo'

/**
 * Assembling the direct-mode `Session`. Identity comes from git config, the same
 * source of truth the broker uses: `user.name` is the display name and
 * `user.email` — lowercased via `emailToId` — is the stable `Human.id` for
 * drafts, viewed state, and the audit log. The email is a key only; it never
 * enters a comment body.
 *
 * `viewerLogin` is the one field GitHub authenticates: in direct mode every call
 * is the real user, so `GET /user` gives the login that own-comment detection
 * compares against (`comment.user.login === viewerLogin`). There is no stamping
 * and no broker, so the identity is otherwise cosmetic — GitHub authenticates
 * the human for real.
 *
 * The `Session` shape matches what the mock returns for structural parity
 * (`human`, `brokerLogin`, `workspace`, plus the optional `viewerLogin` the
 * contract reserves for direct mode).
 */

/** Roles a session human may carry; mirrors `Human['role']`. */
const VALID_ROLES = ['contractor', 'lead'] as const
type Role = (typeof VALID_ROLES)[number]

function resolveRole(env: Record<string, string | undefined>): Role {
  const raw = env.REVU_ROLE
  return raw === 'lead' ? 'lead' : 'contractor'
}

/**
 * A required git-config value was missing (empty `user.name` or `user.email`).
 * Direct mode keys everything on the email, so an unset identity is a hard start
 * failure with an actionable fix, not a blank session.
 */
export class MissingGitIdentityError extends Error {
  constructor(field: 'user.name' | 'user.email') {
    super(
      `git config ${field} is not set. Direct mode reads your identity from git config ` +
        `(the email is the stable key for drafts and viewed state). ` +
        `Set it with \`git config --global ${field} "…"\`.`,
    )
    this.name = 'MissingGitIdentityError'
  }
}

/** Read one `git config <key>`; returns the trimmed value, or `null` when unset/empty. */
async function readGitConfig(
  runner: CommandRunner,
  key: string,
  cwd?: string,
): Promise<string | null> {
  const result = await runner.run(
    ['git', 'config', key],
    cwd !== undefined ? { cwd } : undefined,
  )
  if (!result.ok) return null
  const value = result.stdout.trim()
  return value.length > 0 ? value : null
}

/**
 * Read git config identity into a `Human`. `user.name` and `user.email` are both
 * required; either being unset throws `MissingGitIdentityError`. The id is the
 * lowercased email (via `emailToId`), the role comes from `REVU_ROLE` (default
 * `contractor`), and the name is display-only.
 */
export async function buildHuman(
  runner: CommandRunner,
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<Human> {
  const env = opts.env ?? process.env
  const name = await readGitConfig(runner, 'user.name', opts.cwd)
  if (name === null) throw new MissingGitIdentityError('user.name')
  const email = await readGitConfig(runner, 'user.email', opts.cwd)
  if (email === null) throw new MissingGitIdentityError('user.email')

  return {
    id: emailToId(email),
    name,
    email,
    role: resolveRole(env),
  }
}

/**
 * Build the full direct-mode `Session`: git-config `Human`, the viewer's own
 * GitHub login from `GET /user`, and the resolved repo folded into `workspace`
 * so the surface matches the mock's `coder-ws-<id>` convention. `brokerLogin`
 * is the empty string — the designed "no bot" sentinel (see below) — and
 * `viewerLogin` is the field own-comment detection reads.
 */
export async function buildDirectSession(args: {
  runner: CommandRunner
  github: GithubViewerClient
  repo: RepoRef
  cwd?: string
  env?: Record<string, string | undefined>
}): Promise<Session> {
  const human = await buildHuman(args.runner, {
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(args.env !== undefined ? { env: args.env } : {}),
  })
  const viewer = await args.github.getViewer()

  return {
    human,
    // There is no broker bot in direct mode: the viewer authenticates as
    // themselves and comments are never stamped. The empty string is the
    // designed "no bot" sentinel — `parseCommentIdentity` special-cases '' so
    // every comment keeps its genuine GitHub identity. It must NOT echo the
    // viewer login: a comment whose author matches `brokerLogin` is routed into
    // the bot-prefix parser, so echoing the viewer would render the viewer's
    // own unstamped comments as the bot. Own-comment detection uses
    // `viewerLogin` below, never `brokerLogin`.
    brokerLogin: '',
    workspace: `direct-${args.repo.owner}-${args.repo.repo}`,
    viewerLogin: viewer.login,
  }
}

/**
 * Build the broker-mode `Session`. Identity is resolved entirely locally from git
 * config (`buildHuman` — no token needed), so the `Human` — the stable key for
 * drafts, viewed state, and the audit log — is real from boot regardless of
 * whether a GitHub credential is present, absent, or would be rejected.
 *
 * There is deliberately NO `GET /user` probe: broker mode authenticates with a
 * GitHub App installation token, which cannot resolve a login that way — GitHub
 * answers `GET /user` with 403 "Resource not accessible by integration". Probing
 * it would make boot fail exactly when the credential is present (the steady
 * state). So `viewerLogin` is left absent — the shared-bot session shape. That is
 * correct here: the identity-dependent write behaviors that would read
 * `viewerLogin` (the self-approval guard, submit idempotency-by-self, own-comment
 * detection) are enabled together with broker writes in the writes unit, not at
 * boot, so an absent viewer changes no behavior a read-only broker exposes.
 */
export async function buildBrokerSession(args: {
  runner: CommandRunner
  repo: RepoRef
  cwd?: string
  env?: Record<string, string | undefined>
}): Promise<Session> {
  const human = await buildHuman(args.runner, {
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(args.env !== undefined ? { env: args.env } : {}),
  })

  return {
    human,
    brokerLogin: '',
    workspace: `direct-${args.repo.owner}-${args.repo.repo}`,
  }
}
