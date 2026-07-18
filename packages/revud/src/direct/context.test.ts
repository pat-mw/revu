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
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { CommandResult, CommandRunner } from './command-runner'
import type { FetchLike } from './github-client'
import { createFileCredentialTokenSource } from '../broker/token-source'
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

describe('resolveDirectContext — broker boot never probes the viewer', () => {
  test('an injected file-credential source + validateToken:false builds without a credential present', async () => {
    // Point the file-credential source at a path that does not exist: the host
    // has not injected the credential yet. With boot-time validation skipped, the
    // context must still build — identity resolves from git config, no token
    // needed — so the daemon can start and surface the awaiting state per request
    // instead of refusing to boot. `viewerLogin` is absent by design (broker mode
    // never calls `GET /user`).
    const dir = mkdtempSync(join(tmpdir(), 'revud-broker-boot-'))
    const missing = join(dir, 'no-such-.git-credentials')
    try {
      const ctx = await resolveDirectContext({
        runner: scriptRunner({
          origin: 'git@github.com:acme/revu.git',
          config: GOOD_CONFIG,
        }),
        // fetchImpl is never reached: broker boot builds the session from git
        // config alone and makes no GitHub request at all.
        fetchImpl: failingFetch(500),
        env: {},
        tokenSource: createFileCredentialTokenSource({ path: missing }),
        validateToken: false,
      })
      expect(ctx.repo).toEqual({ owner: 'acme', repo: 'revu' })
      // Identity is real (local git config); the viewer is absent by design.
      expect(ctx.session.human.id).toBe('alice@x.io')
      expect(ctx.session.viewerLogin).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('boot succeeds even when GET /user would 403 (installation token) — the probe is gone', async () => {
    // The credential IS present — the steady state. A GitHub App installation
    // token cannot call `GET /user`; GitHub answers 403 "Resource not accessible
    // by integration". If boot probed the viewer, that 403 would crash-loop the
    // daemon. It must not: broker boot never calls `GET /user`, so a fetch that
    // would 403 is never reached, boot succeeds, and `viewerLogin` stays absent.
    const dir = mkdtempSync(join(tmpdir(), 'revud-broker-boot-'))
    const credFile = join(dir, '.git-credentials')
    writeFileSync(credFile, 'https://x-access-token:ghs_fake@github.com\n', 'utf8')
    try {
      const ctx = await resolveDirectContext({
        runner: scriptRunner({
          origin: 'git@github.com:acme/revu.git',
          config: GOOD_CONFIG,
        }),
        fetchImpl: failingFetch(403),
        env: {},
        tokenSource: createFileCredentialTokenSource({ path: credFile }),
        validateToken: false,
      })
      expect(ctx.session.human.id).toBe('alice@x.io')
      expect(ctx.session.viewerLogin).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
