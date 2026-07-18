/**
 * Repo resolution for direct mode: parsing the `origin` remote (https and ssh
 * forms), honoring an explicit `owner/name` override, and reporting a typed
 * failure when there is no valid GitHub repo. Every git command is a fake
 * `CommandRunner`, so no test spawns `git` or touches a real clone.
 */
import { describe, expect, test } from 'bun:test'
import type { CommandResult, CommandRunner } from './command-runner'
import { parseOriginUrl, parseRepoOverride, resolveRepo } from './repo'

/** A CommandRunner that returns one canned result and records the args it saw. */
function fakeRunner(result: Partial<CommandResult>, sink?: string[][]): CommandRunner {
  return {
    async run(args): Promise<CommandResult> {
      sink?.push(args)
      return { ok: true, code: 0, stdout: '', stderr: '', ...result }
    },
  }
}

describe('parseOriginUrl', () => {
  test('parses https with a .git suffix', () => {
    expect(parseOriginUrl('https://github.com/octocat/hello-world.git')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
    })
  })

  test('parses https without a .git suffix and a trailing slash', () => {
    expect(parseOriginUrl('https://github.com/octocat/Hello-World/')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
    })
  })

  test('parses https with an embedded credential', () => {
    expect(parseOriginUrl('https://user:token@github.com/acme/revu.git')).toEqual({
      owner: 'acme',
      repo: 'revu',
    })
  })

  test('parses the scp-like ssh form', () => {
    expect(parseOriginUrl('git@github.com:octocat/hello-world.git')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
    })
  })

  test('parses the explicit ssh:// form', () => {
    expect(parseOriginUrl('ssh://git@github.com/octocat/hello-world.git')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
    })
  })

  test('preserves dots, underscores, and hyphens in names', () => {
    expect(parseOriginUrl('git@github.com:my-org/my.cool_repo.git')).toEqual({
      owner: 'my-org',
      repo: 'my.cool_repo',
    })
  })

  test('rejects a non-github.com host (https)', () => {
    expect(parseOriginUrl('https://gitlab.com/octocat/hello-world.git')).toBeNull()
  })

  test('rejects a non-github.com host (ssh)', () => {
    expect(parseOriginUrl('git@gitlab.com:octocat/hello-world.git')).toBeNull()
  })

  test('rejects a GitHub Enterprise host', () => {
    expect(parseOriginUrl('https://github.example.com/octocat/hello-world.git')).toBeNull()
  })

  test('rejects a URL without exactly two path segments', () => {
    expect(parseOriginUrl('https://github.com/octocat')).toBeNull()
    expect(parseOriginUrl('https://github.com/octocat/a/b')).toBeNull()
  })

  test('rejects an empty string', () => {
    expect(parseOriginUrl('')).toBeNull()
    expect(parseOriginUrl('   ')).toBeNull()
  })
})

describe('parseRepoOverride', () => {
  test('parses owner/name', () => {
    expect(parseRepoOverride('octocat/hello-world')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
    })
  })

  test('strips a trailing .git', () => {
    expect(parseRepoOverride('octocat/hello-world.git')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
    })
  })

  test('rejects a bare name, extra slashes, and a blank side', () => {
    expect(parseRepoOverride('hello-world')).toBeNull()
    expect(parseRepoOverride('a/b/c')).toBeNull()
    expect(parseRepoOverride('/hello-world')).toBeNull()
    expect(parseRepoOverride('octocat/')).toBeNull()
  })

  test('rejects an illegal character', () => {
    expect(parseRepoOverride('octo cat/repo')).toBeNull()
    expect(parseRepoOverride('octocat/re:po')).toBeNull()
  })
})

describe('resolveRepo', () => {
  test('override wins and is validated', async () => {
    const seen: string[][] = []
    const runner = fakeRunner({}, seen)
    const res = await resolveRepo(runner, { override: 'acme/revu' })
    expect(res).toEqual({ ok: true, repo: { owner: 'acme', repo: 'revu' }, source: 'override' })
    // The override short-circuits: git is never asked.
    expect(seen).toEqual([])
  })

  test('a malformed override is a typed bad-override error', async () => {
    const res = await resolveRepo(fakeRunner({}), { override: 'not-a-repo' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.kind).toBe('bad-override')
  })

  test('falls back to the origin remote when no override is given', async () => {
    const seen: string[][] = []
    const runner = fakeRunner(
      { ok: true, stdout: 'git@github.com:acme/revu.git\n' },
      seen,
    )
    const res = await resolveRepo(runner, {})
    expect(res).toEqual({ ok: true, repo: { owner: 'acme', repo: 'revu' }, source: 'origin' })
    expect(seen).toEqual([['git', 'remote', 'get-url', 'origin']])
  })

  test('a failed git remote command is a typed no-remote error', async () => {
    const runner = fakeRunner({ ok: false, code: 128, stderr: 'fatal: no such remote' })
    const res = await resolveRepo(runner, {})
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.kind).toBe('no-remote')
      if (res.error.kind === 'no-remote') expect(res.error.detail).toContain('no such remote')
    }
  })

  test('an unparsable origin is a typed unparsable error', async () => {
    const runner = fakeRunner({ ok: true, stdout: 'https://gitlab.com/acme/revu.git\n' })
    const res = await resolveRepo(runner, {})
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.kind).toBe('unparsable')
      if (res.error.kind === 'unparsable') expect(res.error.originUrl).toContain('gitlab.com')
    }
  })
})
