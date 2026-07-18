/**
 * Mode selection from CLI args and the environment. The default is mock (the
 * daemon's historical behavior, unchanged); `--direct` or `REVU_MODE=direct`
 * selects direct mode; a bogus mode is rejected loudly. The repo override reader
 * accepts `--repo owner/name`, `--repo=owner/name`, and `REVU_REPO`, with the
 * flag winning over the env var.
 */
import { describe, expect, test } from 'bun:test'
import { resolveMode, resolveRepoOverride } from './index'

describe('resolveMode', () => {
  test('defaults to mock with no flags or env', () => {
    expect(resolveMode([], {})).toBe('mock')
  })

  test('--direct selects direct mode', () => {
    expect(resolveMode(['--direct'], {})).toBe('direct')
  })

  test('REVU_MODE=direct selects direct mode', () => {
    expect(resolveMode([], { REVU_MODE: 'direct' })).toBe('direct')
  })

  test('the --direct flag wins even if REVU_MODE says mock', () => {
    expect(resolveMode(['--direct'], { REVU_MODE: 'mock' })).toBe('direct')
  })

  test('REVU_MODE=mock stays mock', () => {
    expect(resolveMode([], { REVU_MODE: 'mock' })).toBe('mock')
  })

  test('REVU_MODE=broker selects broker mode', () => {
    expect(resolveMode([], { REVU_MODE: 'broker' })).toBe('broker')
  })

  test('a bogus mode throws a clear error listing all three modes', () => {
    expect(() => resolveMode([], { REVU_MODE: 'nonsense' })).toThrow()
    // The message names every accepted mode so a mistype is self-correcting.
    let message = ''
    try {
      resolveMode([], { REVU_MODE: 'nonsense' })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('mock')
    expect(message).toContain('direct')
    expect(message).toContain('broker')
  })
})

describe('resolveRepoOverride', () => {
  test('reads --repo owner/name (space form)', () => {
    expect(resolveRepoOverride(['--repo', 'acme/revu'], {})).toBe('acme/revu')
  })

  test('reads --repo=owner/name (inline form)', () => {
    expect(resolveRepoOverride(['--repo=acme/revu'], {})).toBe('acme/revu')
  })

  test('reads REVU_REPO', () => {
    expect(resolveRepoOverride([], { REVU_REPO: 'acme/revu' })).toBe('acme/revu')
  })

  test('the flag wins over REVU_REPO', () => {
    expect(resolveRepoOverride(['--repo', 'flag/wins'], { REVU_REPO: 'env/loses' })).toBe('flag/wins')
  })

  test('returns undefined when neither is set', () => {
    expect(resolveRepoOverride([], {})).toBeUndefined()
  })
})
