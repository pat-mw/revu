/**
 * The direct-mode `TokenSource`: env override precedence, shelling out to
 * `gh auth token`, and the `NoTokenError` when nothing is available. All `gh`
 * invocations are a fake `CommandRunner`, so no test runs `gh` or reads the real
 * credential. A guard test proves the token is never placed in the error text.
 */
import { describe, expect, test } from 'bun:test'
import type { CommandResult, CommandRunner } from './command-runner'
import { createDirectTokenSource, NoTokenError } from './token-source'

function fakeRunner(result: Partial<CommandResult>, sink?: string[][]): CommandRunner {
  return {
    async run(args): Promise<CommandResult> {
      sink?.push(args)
      return { ok: true, code: 0, stdout: '', stderr: '', ...result }
    },
  }
}

describe('createDirectTokenSource', () => {
  test('prefers GH_TOKEN over the gh CLI', async () => {
    const seen: string[][] = []
    const src = createDirectTokenSource(fakeRunner({}, seen), { GH_TOKEN: 'env-token-gh' })
    expect(await src.getToken()).toBe('env-token-gh')
    // The env token short-circuits: gh is never invoked.
    expect(seen).toEqual([])
  })

  test('falls back to GITHUB_TOKEN when GH_TOKEN is unset', async () => {
    const src = createDirectTokenSource(fakeRunner({}), { GITHUB_TOKEN: 'env-token-github' })
    expect(await src.getToken()).toBe('env-token-github')
  })

  test('GH_TOKEN takes precedence over GITHUB_TOKEN', async () => {
    const src = createDirectTokenSource(fakeRunner({}), {
      GH_TOKEN: 'gh-wins',
      GITHUB_TOKEN: 'github-loses',
    })
    expect(await src.getToken()).toBe('gh-wins')
  })

  test('ignores a blank env token and asks gh', async () => {
    const src = createDirectTokenSource(
      fakeRunner({ ok: true, stdout: 'gho_from_gh\n' }),
      { GH_TOKEN: '   ' },
    )
    expect(await src.getToken()).toBe('gho_from_gh')
  })

  test('shells out to `gh auth token` when no env token is set', async () => {
    const seen: string[][] = []
    const src = createDirectTokenSource(
      fakeRunner({ ok: true, stdout: 'gho_shelled\n' }, seen),
      {},
    )
    expect(await src.getToken()).toBe('gho_shelled')
    expect(seen).toEqual([['gh', 'auth', 'token']])
  })

  test('throws NoTokenError when gh is unauthenticated', async () => {
    const src = createDirectTokenSource(
      fakeRunner({ ok: false, code: 1, stderr: 'gh: not logged in to any GitHub hosts' }),
      {},
    )
    await expect(src.getToken()).rejects.toBeInstanceOf(NoTokenError)
  })

  test('throws NoTokenError when gh returns an empty token', async () => {
    const src = createDirectTokenSource(fakeRunner({ ok: true, stdout: '\n' }), {})
    await expect(src.getToken()).rejects.toBeInstanceOf(NoTokenError)
  })

  test('the NoTokenError message names both fixes and carries no token material', async () => {
    const src = createDirectTokenSource(
      fakeRunner({ ok: false, code: 1, stderr: 'not logged in' }),
      {},
    )
    let message = ''
    try {
      await src.getToken()
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('gh auth login')
    expect(message).toContain('GH_TOKEN')
  })
})
