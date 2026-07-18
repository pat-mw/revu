/**
 * The refuse-to-start guard. `resolveDirectContext` must build a real session
 * on a good setup and, on every bad setup, throw a
 * `DirectStartupError` whose message is actionable. Every external is injected
 * (a fake `CommandRunner` for git/gh, a fake `fetch` for GitHub, an explicit
 * env), so the guard is proven with zero real subprocesses and zero network.
 *
 * The entry point maps a thrown `DirectStartupError` to a non-zero process exit;
 * this suite proves the throw and the message, which is the testable core of
 * "refuses to start with a clear message and non-zero exit".
 */
import { describe, expect, test } from 'bun:test'
import type { CommandResult, CommandRunner } from './command-runner'
import type { FetchLike } from './github-client'
import { DirectStartupError, resolveDirectContext } from './context'

/**
 * A scriptable git/gh runner. `origin` sets the `git remote get-url origin`
 * output (or `false` to fail it), `config` answers `git config <key>`, and
 * `ghToken` sets `gh auth token` (or `false` to fail it, i.e. unauthenticated).
 */
function scriptRunner(opts: {
  origin?: string | false
  config?: Record<string, string>
  ghToken?: string | false
}): CommandRunner {
  return {
    async run(args): Promise<CommandResult> {
      const fail = (stderr: string): CommandResult => ({ ok: false, code: 1, stdout: '', stderr })
      const okOut = (stdout: string): CommandResult => ({ ok: true, code: 0, stdout, stderr: '' })

      if (args[0] === 'git' && args[1] === 'remote') {
        if (opts.origin === false || opts.origin === undefined) return fail('fatal: no origin')
        return okOut(`${opts.origin}\n`)
      }
      if (args[0] === 'git' && args[1] === 'config') {
        const v = opts.config?.[args[2]]
        return v !== undefined ? okOut(`${v}\n`) : fail('')
      }
      if (args[0] === 'gh' && args[1] === 'auth' && args[2] === 'token') {
        if (opts.ghToken === false || opts.ghToken === undefined) return fail('gh: not logged in')
        return okOut(`${opts.ghToken}\n`)
      }
      return fail(`unexpected command ${args.join(' ')}`)
    },
  }
}

/** A fetch that answers `GET /user` with the given viewer at status 200. */
function viewerFetch(login: string, id = 1): FetchLike {
  return async () => new Response(JSON.stringify({ login, id }), { status: 200 })
}

/** A fetch that fails with the given status (e.g. a revoked token → 401). */
function failingFetch(status: number): FetchLike {
  return async () => new Response(JSON.stringify({ message: 'nope' }), { status })
}

const GOOD_CONFIG = { 'user.name': 'Alice', 'user.email': 'alice@x.io' }

describe('resolveDirectContext — success', () => {
  test('builds a full context from origin + gh token + git config + GET /user', async () => {
    const ctx = await resolveDirectContext({
      runner: scriptRunner({
        origin: 'git@github.com:acme/revu.git',
        config: GOOD_CONFIG,
        ghToken: 'gho_valid',
      }),
      fetchImpl: viewerFetch('alice-gh'),
      env: {},
    })
    expect(ctx.repo).toEqual({ owner: 'acme', repo: 'revu' })
    expect(ctx.session.human.id).toBe('alice@x.io')
    expect(ctx.session.viewerLogin).toBe('alice-gh')
  })

  test('an explicit override skips origin resolution', async () => {
    const ctx = await resolveDirectContext({
      runner: scriptRunner({ origin: false, config: GOOD_CONFIG, ghToken: 'gho_valid' }),
      fetchImpl: viewerFetch('alice-gh'),
      env: {},
      repoOverride: 'acme/other',
    })
    expect(ctx.repo).toEqual({ owner: 'acme', repo: 'other' })
  })

  test('an env token satisfies the guard without gh', async () => {
    const ctx = await resolveDirectContext({
      runner: scriptRunner({ origin: 'https://github.com/acme/revu', config: GOOD_CONFIG, ghToken: false }),
      fetchImpl: viewerFetch('env-gh'),
      env: { GH_TOKEN: 'env-token' },
    })
    expect(ctx.session.viewerLogin).toBe('env-gh')
  })
})

describe('resolveDirectContext — refuse to start', () => {
  test('no origin remote and no override: clear no-repo message', async () => {
    let message = ''
    try {
      await resolveDirectContext({
        runner: scriptRunner({ origin: false, config: GOOD_CONFIG, ghToken: 'gho_valid' }),
        fetchImpl: viewerFetch('x'),
        env: {},
      })
    } catch (err) {
      expect(err).toBeInstanceOf(DirectStartupError)
      message = (err as Error).message
    }
    expect(message).toContain('origin')
    expect(message).toContain('--repo')
  })

  test('a non-github origin: clear unsupported-repo message', async () => {
    let message = ''
    try {
      await resolveDirectContext({
        runner: scriptRunner({
          origin: 'https://gitlab.com/acme/revu.git',
          config: GOOD_CONFIG,
          ghToken: 'gho_valid',
        }),
        fetchImpl: viewerFetch('x'),
        env: {},
      })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('github.com')
    expect(message).toContain('--repo')
  })

  test('a malformed --repo override: clear owner/name message', async () => {
    let message = ''
    try {
      await resolveDirectContext({
        runner: scriptRunner({ config: GOOD_CONFIG, ghToken: 'gho_valid' }),
        fetchImpl: viewerFetch('x'),
        env: {},
        repoOverride: 'bogus',
      })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('owner/name')
  })

  test('gh unauthenticated and no env token: clear no-token message', async () => {
    let message = ''
    try {
      await resolveDirectContext({
        runner: scriptRunner({
          origin: 'git@github.com:acme/revu.git',
          config: GOOD_CONFIG,
          ghToken: false,
        }),
        fetchImpl: viewerFetch('x'),
        env: {},
      })
    } catch (err) {
      expect(err).toBeInstanceOf(DirectStartupError)
      message = (err as Error).message
    }
    expect(message).toContain('gh auth login')
    expect(message).toContain('GH_TOKEN')
  })

  test('a revoked token (GET /user 401): refuses to start', async () => {
    let thrown: unknown
    try {
      await resolveDirectContext({
        runner: scriptRunner({
          origin: 'git@github.com:acme/revu.git',
          config: GOOD_CONFIG,
          ghToken: 'gho_revoked',
        }),
        fetchImpl: failingFetch(401),
        env: {},
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DirectStartupError)
    expect((thrown as Error).message).toContain('401')
  })

  test('missing git identity: refuses to start', async () => {
    let thrown: unknown
    try {
      await resolveDirectContext({
        runner: scriptRunner({
          origin: 'git@github.com:acme/revu.git',
          config: {},
          ghToken: 'gho_valid',
        }),
        fetchImpl: viewerFetch('x'),
        env: {},
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DirectStartupError)
    expect((thrown as Error).message).toContain('git config')
  })
})
