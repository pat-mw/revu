/**
 * Session assembly: git-config identity → `Human` with a lowercase-email id, the
 * viewer login from an injected `GET /user`, and the `Session` shape the mock
 * returns for structural parity. A fake `CommandRunner` supplies git config and
 * a fake `GithubClient` supplies the viewer, so no test shells out or opens a
 * socket. The email-is-never-in-a-comment-body rule lives in the frontend; here
 * we pin that the id derives from the lowercased email.
 */
import { describe, expect, test } from 'bun:test'
import { isOwnComment, parseCommentIdentity } from '@revu/shared'
import type { CommandResult, CommandRunner } from './command-runner'
import type { GithubViewer, GithubViewerClient } from './github-client'
import { buildBrokerSession, buildDirectSession, buildHuman, MissingGitIdentityError } from './session'

/** A CommandRunner answering `git config <key>` from a map; anything else fails. */
function gitConfigRunner(config: Record<string, string>): CommandRunner {
  return {
    async run(args): Promise<CommandResult> {
      // args: ['git', 'config', '<key>']
      if (args[0] === 'git' && args[1] === 'config') {
        const value = config[args[2]]
        if (value !== undefined) return { ok: true, code: 0, stdout: `${value}\n`, stderr: '' }
        return { ok: false, code: 1, stdout: '', stderr: '' }
      }
      return { ok: false, code: 127, stdout: '', stderr: 'unexpected command' }
    },
  }
}

const fakeGithub = (viewer: GithubViewer): GithubViewerClient => ({
  async getViewer() {
    return viewer
  },
})

describe('buildHuman', () => {
  test('derives id from the lowercased email and keeps the name as display', async () => {
    const runner = gitConfigRunner({
      'user.name': 'Alice Nguyen',
      'user.email': 'Alice.Nguyen@Contractor.CO',
    })
    // An explicit empty env: the role assertion below must not depend on a
    // REVU_ROLE that happens to be set in the test process's real environment.
    const human = await buildHuman(runner, { env: {} })
    expect(human.id).toBe('alice.nguyen@contractor.co')
    expect(human.name).toBe('Alice Nguyen')
    expect(human.email).toBe('Alice.Nguyen@Contractor.CO')
    expect(human.role).toBe('contractor')
  })

  test('honors REVU_ROLE=lead', async () => {
    const runner = gitConfigRunner({ 'user.name': 'Lead Dev', 'user.email': 'lead@x.io' })
    const human = await buildHuman(runner, { env: { REVU_ROLE: 'lead' } })
    expect(human.role).toBe('lead')
  })

  test('an unknown REVU_ROLE falls back to contractor', async () => {
    const runner = gitConfigRunner({ 'user.name': 'Dev', 'user.email': 'dev@x.io' })
    const human = await buildHuman(runner, { env: { REVU_ROLE: 'wizard' } })
    expect(human.role).toBe('contractor')
  })

  test('throws when user.name is unset', async () => {
    const runner = gitConfigRunner({ 'user.email': 'x@y.io' })
    await expect(buildHuman(runner)).rejects.toBeInstanceOf(MissingGitIdentityError)
  })

  test('throws when user.email is unset', async () => {
    const runner = gitConfigRunner({ 'user.name': 'Nameless' })
    await expect(buildHuman(runner)).rejects.toBeInstanceOf(MissingGitIdentityError)
  })
})

describe('buildDirectSession', () => {
  test('assembles a session with viewerLogin from GET /user', async () => {
    const runner = gitConfigRunner({
      'user.name': 'Bob Builder',
      'user.email': 'bob@build.co',
    })
    const session = await buildDirectSession({
      runner,
      github: fakeGithub({ login: 'bob-gh', id: 42 }),
      repo: { owner: 'acme', repo: 'revu' },
    })
    expect(session.human.id).toBe('bob@build.co')
    expect(session.human.name).toBe('Bob Builder')
    expect(session.viewerLogin).toBe('bob-gh')
    // There is no broker bot in direct mode, so brokerLogin is the empty-string
    // "no bot" sentinel `parseCommentIdentity` is designed around. It must NOT
    // echo the viewer login: that would route the viewer's own (unstamped)
    // comments into the bot-prefix parser and render them as the bot.
    expect(session.brokerLogin).toBe('')
    expect(session.workspace).toContain('acme')
    expect(session.workspace).toContain('revu')
  })

  test("the viewer's own comment renders with their genuine GitHub identity", async () => {
    const runner = gitConfigRunner({ 'user.name': 'Bob Builder', 'user.email': 'bob@build.co' })
    const session = await buildDirectSession({
      runner,
      github: fakeGithub({ login: 'bob-gh', id: 42 }),
      repo: { owner: 'acme', repo: 'revu' },
    })

    // A direct-mode comment posts as the real user with no stamped prefix. With
    // brokerLogin as the empty "no bot" sentinel, the parser must leave it as a
    // genuine GitHub identity — never `kind:'bot'`.
    const comment = {
      id: 7,
      user: {
        login: 'bob-gh',
        id: 42,
        node_id: 'U_42',
        avatar_url: '',
        html_url: '',
        type: 'User' as const,
      },
      body: 'Looks good to me.',
    }
    const parsed = parseCommentIdentity(comment, session.brokerLogin)
    expect(parsed.identity.kind).toBe('github')
    expect(parsed.body).toBe('Looks good to me.')

    // Own-comment detection still works: it reads viewerLogin, not brokerLogin.
    expect(
      isOwnComment(comment, {
        human: session.human,
        botLogin: session.brokerLogin,
        ...(session.viewerLogin !== undefined ? { viewerLogin: session.viewerLogin } : {}),
      }),
    ).toBe(true)
    expect(
      isOwnComment(
        { ...comment, user: { ...comment.user, login: 'someone-else' } },
        {
          human: session.human,
          botLogin: session.brokerLogin,
          ...(session.viewerLogin !== undefined ? { viewerLogin: session.viewerLogin } : {}),
        },
      ),
    ).toBe(false)
  })

  test('the session is structurally parity with the mock (has human/brokerLogin/workspace)', async () => {
    const runner = gitConfigRunner({ 'user.name': 'Ci', 'user.email': 'ci@x.io' })
    const session = await buildDirectSession({
      runner,
      github: fakeGithub({ login: 'ci-gh', id: 7 }),
      repo: { owner: 'o', repo: 'r' },
    })
    expect(Object.keys(session).sort()).toEqual(
      ['brokerLogin', 'human', 'viewerLogin', 'workspace'].sort(),
    )
    expect(Object.keys(session.human).sort()).toEqual(['email', 'id', 'name', 'role'].sort())
  })
})

describe('buildBrokerSession', () => {
  test('builds identity from git config and omits viewerLogin — no GitHub call at all', async () => {
    // Broker mode takes NO github client: a GitHub App installation token cannot
    // resolve a login via `GET /user`, so the viewer is never probed. Identity is
    // fully local, so the session builds whether a credential is present, absent,
    // or would 403 — there is simply no request that could fail.
    const runner = gitConfigRunner({ 'user.name': 'Bot Wrangler', 'user.email': 'ops@shared.co' })
    const session = await buildBrokerSession({ runner, repo: { owner: 'acme', repo: 'revu' } })
    expect(session.human.id).toBe('ops@shared.co')
    expect(session.brokerLogin).toBe('')
    expect(session.viewerLogin).toBeUndefined()
    expect(session.workspace).toContain('acme')
    expect(session.workspace).toContain('revu')
  })

  test('propagates a missing git identity — the local-only source is still required', async () => {
    const runner = gitConfigRunner({ 'user.email': 'ops@shared.co' })
    await expect(
      buildBrokerSession({ runner, repo: { owner: 'acme', repo: 'revu' } }),
    ).rejects.toBeInstanceOf(MissingGitIdentityError)
  })
})
