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

/**
 * A fetch that refuses to be called: every invocation counts itself and throws.
 * `failingFetch` above proves "no request" only indirectly — it answers, so a
 * caller that did make a request simply sees an error status. This one makes the
 * absence directly assertable: `calls()` is the number of requests attempted, and
 * a request that slips through fails the test loudly wherever it is awaited
 * rather than being swallowed as a bad response.
 */
function refusingFetch(): { impl: FetchLike; calls: () => number } {
  let calls = 0
  return {
    impl: async (url: string) => {
      calls += 1
      throw new Error(`unexpected GitHub request: ${url}`)
    },
    calls: () => calls,
  }
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

/**
 * Starting with GitHub optional. A local-only review needs no origin, no token,
 * and no viewer: `requireGithub: false` turns an unusable GitHub half into a
 * typed absence instead of a refusal, and the session is then built from git
 * config alone. The half is all-or-nothing: a clone whose origin resolves AND
 * whose token is obtainable keeps repo, client, and viewer together (probed at
 * boot exactly as a required boot probes them), while a clone with no usable
 * half — no token obtainable, a credential GitHub rejects, or a GitHub that
 * cannot be reached — drops all three — never a repo without a viewer, because
 * the write guards compare against the viewer login and silently invert on a
 * blank one. The default is unchanged, and the case that proves the relaxation
 * carries its own control that flips the flag back and asserts the refusal
 * returns — otherwise a passing boot would say nothing about the flag.
 */
describe('resolveDirectContext — local-only boot needs no GitHub', () => {
  test('no origin, no token, and not one GitHub request', async () => {
    const fetch = refusingFetch()
    const ctx = await resolveDirectContext({
      runner: scriptRunner({ origin: false, config: GOOD_CONFIG, ghToken: false }),
      fetchImpl: fetch.impl,
      env: {},
      requireGithub: false,
    })
    // Identity is real and local: the git-config email is the key everything
    // per-human is stored under, so it must survive a GitHub-less boot intact.
    expect(ctx.session.human.id).toBe('alice@x.io')
    expect(ctx.session.viewerLogin).toBeUndefined()
    // Asserted directly rather than inferred: the fake throws on any call and
    // counts, so zero here means no request was attempted, not that one was
    // answered harmlessly.
    expect(fetch.calls()).toBe(0)
  })

  test('the same setup under the default still refuses to start', async () => {
    let thrown: unknown
    try {
      await resolveDirectContext({
        runner: scriptRunner({ origin: false, config: GOOD_CONFIG, ghToken: false }),
        fetchImpl: refusingFetch().impl,
        env: {},
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DirectStartupError)
  })

  test('the GitHub half is typed-absent, never a blank owner/name', async () => {
    const ctx = await resolveDirectContext({
      runner: scriptRunner({ origin: false, config: GOOD_CONFIG, ghToken: false }),
      fetchImpl: refusingFetch().impl,
      env: {},
      requireGithub: false,
    })
    // A blank `{ owner: '', repo: '' }` stand-in would build request paths like
    // `/repos///pulls/204`, which GitHub answers 404 with a message that blames
    // the pull request. Absence has to be absence.
    expect(ctx.repo).toBeUndefined()
  })

  test('no repo means no GitHub client to mis-call either', async () => {
    const ctx = await resolveDirectContext({
      runner: scriptRunner({ origin: false, config: GOOD_CONFIG, ghToken: false }),
      fetchImpl: refusingFetch().impl,
      env: {},
      requireGithub: false,
    })
    expect(ctx.github).toBeUndefined()
  })

  test('the workspace is a defined, non-empty label', async () => {
    const ctx = await resolveDirectContext({
      runner: scriptRunner({ origin: false, config: GOOD_CONFIG, ghToken: false }),
      fetchImpl: refusingFetch().impl,
      env: {},
      requireGithub: false,
    })
    expect(ctx.session.workspace.length).toBeGreaterThan(0)
  })

  test('the workspace interpolates neither `undefined` nor an empty repo', async () => {
    const ctx = await resolveDirectContext({
      runner: scriptRunner({ origin: false, config: GOOD_CONFIG, ghToken: false }),
      fetchImpl: refusingFetch().impl,
      env: {},
      requireGithub: false,
    })
    // `direct-undefined-undefined` and `direct--` are exactly what a missing repo
    // produces when the absence is papered over instead of handled.
    expect(ctx.session.workspace).not.toContain('undefined')
    expect(ctx.session.workspace).not.toContain('direct--')
  })

  test('an unset user.email still refuses to start', async () => {
    // The git-config identity guard is NOT relaxed by this flag. The email keys
    // drafts and viewed state, so starting without one would file every human's
    // drafts under a single blank id the store cannot tell apart afterwards.
    let thrown: unknown
    try {
      await resolveDirectContext({
        runner: scriptRunner({
          origin: false,
          config: { 'user.name': 'Alice' },
          ghToken: false,
        }),
        fetchImpl: refusingFetch().impl,
        env: {},
        requireGithub: false,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DirectStartupError)
    expect((thrown as Error).message).toContain('git config')
  })

  test('a clone without a credential drops the GitHub half whole, and still costs no request', async () => {
    // The origin resolves — this is a genuine GitHub clone — but no token is
    // obtainable, so nothing could authenticate a request or identify the
    // viewer the write guards compare against. Keeping the repo here would
    // present a GitHub-capable daemon whose session carries no viewer: the
    // self-review gate and the submit idempotency re-check compare against the
    // viewer login and silently invert on a blank one. The half is therefore
    // dropped WHOLE — repo, client, and viewer together — and the boot is a
    // purely local one that issues no request.
    const fetch = refusingFetch()
    const ctx = await resolveDirectContext({
      runner: scriptRunner({
        origin: 'git@github.com:acme/revu.git',
        config: GOOD_CONFIG,
        ghToken: false,
      }),
      fetchImpl: fetch.impl,
      env: {},
      requireGithub: false,
    })
    expect(ctx.repo).toBeUndefined()
    expect(ctx.github).toBeUndefined()
    expect(ctx.session.viewerLogin).toBeUndefined()
    expect(fetch.calls()).toBe(0)
  })

  test('a clone with a credential keeps the whole half — repo, client, and viewer together', async () => {
    // With a token obtainable, the optional-GitHub boot proves it and probes
    // the viewer exactly as a required boot does. The kept half is never
    // viewer-less: either every GitHub precondition holds and the full
    // GitHub-capable surface is wired, or none is kept at all.
    const ctx = await resolveDirectContext({
      runner: scriptRunner({
        origin: 'git@github.com:acme/revu.git',
        config: GOOD_CONFIG,
        ghToken: 'gho_valid',
      }),
      fetchImpl: viewerFetch('alice-gh'),
      env: {},
      requireGithub: false,
    })
    expect(ctx.repo).toEqual({ owner: 'acme', repo: 'revu' })
    expect(ctx.github).not.toBeUndefined()
    expect(ctx.session.viewerLogin).toBe('alice-gh')
  })

  test('a stale credential (GET /user answers 401) drops the GitHub half whole', async () => {
    // The token EXISTS locally — `gh auth token` produces one — but GitHub
    // rejects it, so no viewer can stand behind the half. A local-only boot
    // needs no token, so a credential GitHub refuses must shed the half
    // exactly as an absent credential does — repo, client, and viewer
    // together — and the boot proceeds as a purely local one.
    const ctx = await resolveDirectContext({
      runner: scriptRunner({
        origin: 'git@github.com:acme/revu.git',
        config: GOOD_CONFIG,
        ghToken: 'gho_stale',
      }),
      fetchImpl: failingFetch(401),
      env: {},
      requireGithub: false,
    })
    expect(ctx.repo).toBeUndefined()
    expect(ctx.github).toBeUndefined()
    expect(ctx.session.viewerLogin).toBeUndefined()
  })

  test('an unreachable GitHub (fetch throws) drops the GitHub half whole', async () => {
    // The offline shape: the viewer probe cannot even connect. A local-only
    // boot in an ordinary GitHub clone must survive exactly this — needing no
    // network is the point of the mode — so the connection failure sheds the
    // half rather than stopping the daemon.
    const offlineFetch: FetchLike = async () => {
      throw new Error('fetch failed: getaddrinfo ENOTFOUND api.github.com')
    }
    const ctx = await resolveDirectContext({
      runner: scriptRunner({
        origin: 'git@github.com:acme/revu.git',
        config: GOOD_CONFIG,
        ghToken: 'gho_valid',
      }),
      fetchImpl: offlineFetch,
      env: {},
      requireGithub: false,
    })
    expect(ctx.repo).toBeUndefined()
    expect(ctx.github).toBeUndefined()
    expect(ctx.session.viewerLogin).toBeUndefined()
  })

  test('a token source that fails in its own way sheds the half instead of aborting', async () => {
    // The shed is not conditioned on the failure being the typed no-token
    // shape: an injected source that fails differently (an unreadable
    // credential store, say) equally leaves no usable credential, so an
    // optional boot drops the half whole rather than crashing on the error.
    const ctx = await resolveDirectContext({
      runner: scriptRunner({ origin: 'git@github.com:acme/revu.git', config: GOOD_CONFIG }),
      fetchImpl: refusingFetch().impl,
      env: {},
      tokenSource: {
        getToken: async () => {
          throw new Error('credential store unreadable')
        },
      },
      requireGithub: false,
    })
    expect(ctx.repo).toBeUndefined()
    expect(ctx.github).toBeUndefined()
    expect(ctx.session.viewerLogin).toBeUndefined()
  })

  test('the same stale credential under the requirement still refuses to start', async () => {
    // The control that keeps the relaxation honest: a required boot treats a
    // rejected credential as the hard start failure it always was, with the
    // HTTP status in the message so the user can act.
    let thrown: unknown
    try {
      await resolveDirectContext({
        runner: scriptRunner({
          origin: 'git@github.com:acme/revu.git',
          config: GOOD_CONFIG,
          ghToken: 'gho_stale',
        }),
        fetchImpl: failingFetch(401),
        env: {},
        requireGithub: true,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DirectStartupError)
    expect((thrown as Error).message).toContain('401')
  })

  test('the same unreachable GitHub under the requirement still refuses to start', async () => {
    let thrown: unknown
    try {
      await resolveDirectContext({
        runner: scriptRunner({
          origin: 'git@github.com:acme/revu.git',
          config: GOOD_CONFIG,
          ghToken: 'gho_valid',
        }),
        fetchImpl: async () => {
          throw new Error('fetch failed: getaddrinfo ENOTFOUND api.github.com')
        },
        env: {},
        requireGithub: true,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DirectStartupError)
    expect((thrown as Error).message).toContain('ENOTFOUND')
  })

  test('an unset user.email still refuses to start when the shed retries locally', async () => {
    // The session builder reads git identity BEFORE it probes the viewer, so
    // on this setup it is the unset email — not the rejected credential —
    // that reaches the shed, and the local rebuild then raises it again from
    // the same reader. That is the stronger version of the guarantee: the
    // identity guard holds even when the identity failure is itself what
    // triggered the shed. The email keys drafts and viewed state, so the
    // retry must refuse an unset one exactly as a first-attempt local boot
    // does, never soften it into a blank id shared by every human.
    let thrown: unknown
    try {
      await resolveDirectContext({
        runner: scriptRunner({
          origin: 'git@github.com:acme/revu.git',
          config: { 'user.name': 'Alice' },
          ghToken: 'gho_stale',
        }),
        fetchImpl: failingFetch(401),
        env: {},
        requireGithub: false,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DirectStartupError)
    expect((thrown as Error).message).toContain('git config')
  })
})

/**
 * The shed is announced. Dropping the GitHub half turns a GitHub-capable
 * daemon into a local-only one, and the causes an operator has to tell apart —
 * no credential at all, a credential GitHub rejects, a GitHub that cannot be
 * reached, an injected source failing in its own way — are invisible in the
 * startup line, which shows only the ABSENCE of a repo. One warning names the
 * cause and the consequence at the moment the daemon commits to continuing
 * without GitHub.
 *
 * The line is built from the failure's STRUCTURE — class name, HTTP status,
 * errno mnemonic — and never from its free text, because a credential can ride
 * in an error message, a URL, or a header. The leak assertion below is the one
 * that matters, so it is written to be able to fail: it first proves the
 * token-shaped string really is in the source error.
 */
describe('resolveDirectContext — the shed announces itself', () => {
  /** A diagnostics sink plus the lines it received, so nothing is read from process output. */
  function captureLog(): { log: (message: string) => void; lines: () => string[] } {
    const lines: string[] = []
    return {
      log: (message: string) => {
        lines.push(message)
      },
      lines: () => lines,
    }
  }

  /** Shaped like a real GitHub personal access token, so a leak is unmistakable. */
  const TOKEN_SHAPED = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzA'

  test('a rejected credential names the rejection and the consequence', async () => {
    const captured = captureLog()
    await resolveDirectContext({
      runner: scriptRunner({
        origin: 'git@github.com:acme/revu.git',
        config: GOOD_CONFIG,
        ghToken: 'gho_stale',
      }),
      fetchImpl: failingFetch(401),
      env: {},
      requireGithub: false,
      log: captured.log,
    })
    expect(captured.lines()).toHaveLength(1)
    const line = captured.lines()[0] ?? ''
    // The cause: which step failed, and how GitHub answered.
    expect(line).toContain('GithubRequestError')
    expect(line).toContain('401')
    // The consequence: the reason alone does not tell an operator what they now have.
    expect(line).toContain('local reviews only')
  })

  test('an unreachable GitHub reads differently from a rejected credential', async () => {
    const captured = captureLog()
    await resolveDirectContext({
      runner: scriptRunner({
        origin: 'git@github.com:acme/revu.git',
        config: GOOD_CONFIG,
        ghToken: 'gho_valid',
      }),
      fetchImpl: async () => {
        throw Object.assign(new Error('fetch failed: getaddrinfo ENOTFOUND api.github.com'), {
          code: 'ENOTFOUND',
        })
      },
      env: {},
      requireGithub: false,
      log: captured.log,
    })
    expect(captured.lines()).toHaveLength(1)
    const line = captured.lines()[0] ?? ''
    expect(line).toContain('ENOTFOUND')
    expect(line).toContain('local reviews only')
    // Distinguishable from the rejected-credential line: no HTTP answer came back.
    expect(line).not.toContain('GithubRequestError')
  })

  test('an absent credential names the absent credential, not a GitHub answer', async () => {
    const captured = captureLog()
    await resolveDirectContext({
      runner: scriptRunner({
        origin: 'git@github.com:acme/revu.git',
        config: GOOD_CONFIG,
        ghToken: false,
      }),
      fetchImpl: refusingFetch().impl,
      env: {},
      requireGithub: false,
      log: captured.log,
    })
    expect(captured.lines()).toHaveLength(1)
    const line = captured.lines()[0] ?? ''
    expect(line).toContain('NoTokenError')
    expect(line).toContain('local reviews only')
  })

  test('an injected source failing in its own way is a fourth, distinct line', async () => {
    const captured = captureLog()
    await resolveDirectContext({
      runner: scriptRunner({ origin: 'git@github.com:acme/revu.git', config: GOOD_CONFIG }),
      fetchImpl: refusingFetch().impl,
      env: {},
      tokenSource: {
        getToken: async () => {
          throw Object.assign(new Error('credential store unreadable'), { code: 'EACCES' })
        },
      },
      requireGithub: false,
      log: captured.log,
    })
    expect(captured.lines()).toHaveLength(1)
    const line = captured.lines()[0] ?? ''
    expect(line).toContain('EACCES')
    // Not the typed no-token absence: an operator must not read this as "log in".
    expect(line).not.toContain('NoTokenError')
  })

  test('a plain no-origin local-only boot says nothing', async () => {
    // A repository with no GitHub remote is the DESIGNED case, not a
    // degradation. Warning here would train the reader to ignore the line.
    const captured = captureLog()
    await resolveDirectContext({
      runner: scriptRunner({ origin: false, config: GOOD_CONFIG, ghToken: false }),
      fetchImpl: refusingFetch().impl,
      env: {},
      requireGithub: false,
      log: captured.log,
    })
    expect(captured.lines()).toEqual([])
  })

  test('a boot that keeps the whole GitHub half says nothing', async () => {
    const captured = captureLog()
    const ctx = await resolveDirectContext({
      runner: scriptRunner({
        origin: 'git@github.com:acme/revu.git',
        config: GOOD_CONFIG,
        ghToken: 'gho_valid',
      }),
      fetchImpl: viewerFetch('alice-gh'),
      env: {},
      requireGithub: false,
      log: captured.log,
    })
    expect(ctx.repo).toEqual({ owner: 'acme', repo: 'revu' })
    expect(captured.lines()).toEqual([])
  })

  test('the required path throws instead of warning', async () => {
    // The operator already gets the failure as a refusal to start; a warning
    // beside it would be a second, weaker copy of the same news.
    const captured = captureLog()
    let thrown: unknown
    try {
      await resolveDirectContext({
        runner: scriptRunner({
          origin: 'git@github.com:acme/revu.git',
          config: GOOD_CONFIG,
          ghToken: 'gho_stale',
        }),
        fetchImpl: failingFetch(401),
        env: {},
        requireGithub: true,
        log: captured.log,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DirectStartupError)
    expect(captured.lines()).toEqual([])
  })

  test('a token-bearing credential-source error reaches the log token-free', async () => {
    const sourceError = Object.assign(
      new Error(`credential store returned https://x-access-token:${TOKEN_SHAPED}@github.com`),
      { code: 'EACCES' },
    )
    // Falsification: if the token-shaped string were not actually in the source
    // error, the absence assertion below would pass for the wrong reason.
    expect(sourceError.message).toContain(TOKEN_SHAPED)

    const captured = captureLog()
    await resolveDirectContext({
      runner: scriptRunner({ origin: 'git@github.com:acme/revu.git', config: GOOD_CONFIG }),
      fetchImpl: refusingFetch().impl,
      env: {},
      tokenSource: {
        getToken: async () => {
          throw sourceError
        },
      },
      requireGithub: false,
      log: captured.log,
    })
    expect(captured.lines()).toHaveLength(1)
    const line = captured.lines()[0] ?? ''
    expect(line).not.toContain(TOKEN_SHAPED)
    // Not merely absent verbatim: no recognizable fragment of it either.
    expect(line).not.toContain('ghp_')
    expect(line).not.toContain('x-access-token')
  })

  test("a token echoed in GitHub's own response body never reaches the log", async () => {
    // The viewer-probe shed's error carries a bounded excerpt of the response
    // body, and a proxy or a misconfigured endpoint can echo the presented
    // credential back inside it.
    const captured = captureLog()
    await resolveDirectContext({
      runner: scriptRunner({
        origin: 'git@github.com:acme/revu.git',
        config: GOOD_CONFIG,
        ghToken: 'gho_stale',
      }),
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: `Bad credentials: ${TOKEN_SHAPED}` }), {
          status: 401,
        }),
      env: {},
      requireGithub: false,
      log: captured.log,
    })
    expect(captured.lines()).toHaveLength(1)
    const line = captured.lines()[0] ?? ''
    expect(line).toContain('401')
    expect(line).not.toContain(TOKEN_SHAPED)
    expect(line).not.toContain('ghp_')
  })

  test('an identity failure that reaches the shed is not softened into a warning', async () => {
    // The local rebuild raises the unset `user.email` again and the daemon does
    // NOT continue, so the "continuing without GitHub" line would be a lie.
    const captured = captureLog()
    let thrown: unknown
    try {
      await resolveDirectContext({
        runner: scriptRunner({
          origin: 'git@github.com:acme/revu.git',
          config: { 'user.name': 'Alice' },
          ghToken: 'gho_stale',
        }),
        fetchImpl: failingFetch(401),
        env: {},
        requireGithub: false,
        log: captured.log,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DirectStartupError)
    expect(captured.lines()).toEqual([])
  })
})
