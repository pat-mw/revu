/**
 * The broker-mode file-credential `TokenSource`: parsing the injected
 * git-credential-store file, preferring the `x-access-token` github.com entry,
 * re-reading the file on every call (rotation), and the typed
 * `AwaitingCredentialError` for every no-usable-token state. All file access is
 * a per-test temp file or an injected reader — no test touches the real
 * `~/.git-credentials`. Guard tests prove no token material ever reaches an
 * error's message or stack, and that the module never logs.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoTokenError } from '../direct/token-source'
import { AwaitingCredentialError, createFileCredentialTokenSource } from './token-source'

const tmpDirs: string[] = []

/** Create a temp credential file with the given content; cleaned up after each test. */
function tmpCredFile(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'revu-cred-'))
  tmpDirs.push(dir)
  const path = join(dir, 'git-credentials')
  if (content !== null) writeFileSync(path, content)
  return path
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('createFileCredentialTokenSource', () => {
  test('reads the x-access-token github.com entry (default reader, real file)', async () => {
    const path = tmpCredFile('https://x-access-token:ghs_tok123@github.com\n')
    const src = createFileCredentialTokenSource({ path })
    expect(await src.getToken()).toBe('ghs_tok123')
  })

  test('selects the github.com entry from a multi-host file, not the first line', async () => {
    const path = tmpCredFile(
      'https://alice:glpat-not-this@gitlab.com\n' +
        'https://x-access-token:ghs_the-one@github.com\n' +
        'https://bob:also-not-this@bitbucket.org\n',
    )
    const src = createFileCredentialTokenSource({ path })
    expect(await src.getToken()).toBe('ghs_the-one')
  })

  test('prefers x-access-token over another github.com user, in any order', async () => {
    const path = tmpCredFile(
      'https://someone-else:not-preferred@github.com\n' +
        'https://x-access-token:ghs_preferred@github.com\n',
    )
    const src = createFileCredentialTokenSource({ path })
    expect(await src.getToken()).toBe('ghs_preferred')
  })

  test('falls back to another github.com user when no x-access-token entry exists', async () => {
    const path = tmpCredFile('https://someone-else:gho_fallback@github.com\n')
    const src = createFileCredentialTokenSource({ path })
    expect(await src.getToken()).toBe('gho_fallback')
  })

  test('tolerates CRLF line endings and blank/malformed lines', async () => {
    const path = tmpCredFile(
      '\r\nnot a url at all\r\nhttps://github.com\r\n' +
        'https://x-access-token:ghs_crlf@github.com\r\n\r\n',
    )
    const src = createFileCredentialTokenSource({ path })
    expect(await src.getToken()).toBe('ghs_crlf')
  })

  test('re-reads the file per call: rotation between two calls yields each token', async () => {
    const path = tmpCredFile('https://x-access-token:ghs_first@github.com\n')
    const src = createFileCredentialTokenSource({ path })
    expect(await src.getToken()).toBe('ghs_first')
    writeFileSync(path, 'https://x-access-token:ghs_second@github.com\n')
    expect(await src.getToken()).toBe('ghs_second')
  })

  test('a transiently erased file becomes AwaitingCredentialError, then recovers', async () => {
    const path = tmpCredFile('https://x-access-token:ghs_alive@github.com\n')
    const src = createFileCredentialTokenSource({ path })
    expect(await src.getToken()).toBe('ghs_alive')
    writeFileSync(path, '')
    await expect(src.getToken()).rejects.toBeInstanceOf(AwaitingCredentialError)
    writeFileSync(path, 'https://x-access-token:ghs_back@github.com\n')
    expect(await src.getToken()).toBe('ghs_back')
  })

  test('zero-byte file throws AwaitingCredentialError, not a crash', async () => {
    const src = createFileCredentialTokenSource({ path: tmpCredFile('') })
    await expect(src.getToken()).rejects.toBeInstanceOf(AwaitingCredentialError)
  })

  test('missing file (ENOENT) throws AwaitingCredentialError, not the raw fs error', async () => {
    const src = createFileCredentialTokenSource({ path: tmpCredFile(null) })
    await expect(src.getToken()).rejects.toBeInstanceOf(AwaitingCredentialError)
  })

  test('no github.com entry throws AwaitingCredentialError', async () => {
    const src = createFileCredentialTokenSource({
      path: tmpCredFile('https://alice:glpat-x@gitlab.com\ngarbage line\n'),
    })
    await expect(src.getToken()).rejects.toBeInstanceOf(AwaitingCredentialError)
  })

  test('a github.com entry with an empty password is not a usable credential', async () => {
    const src = createFileCredentialTokenSource({
      path: tmpCredFile('https://x-access-token:@github.com\n'),
    })
    await expect(src.getToken()).rejects.toBeInstanceOf(AwaitingCredentialError)
  })

  test('AwaitingCredentialError is distinct from NoTokenError', async () => {
    const src = createFileCredentialTokenSource({ path: tmpCredFile('') })
    let caught: unknown
    try {
      await src.getToken()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AwaitingCredentialError)
    expect(caught).not.toBeInstanceOf(NoTokenError)
    expect((caught as Error).name).toBe('AwaitingCredentialError')
  })

  test('decodes a percent-encoded password as git wrote it', async () => {
    const src = createFileCredentialTokenSource({
      path: tmpCredFile('https://x-access-token:abc%2Fdef%3A1@github.com\n'),
    })
    expect(await src.getToken()).toBe('abc/def:1')
  })

  test('injected readFile is used instead of the filesystem', async () => {
    const seen: string[] = []
    const src = createFileCredentialTokenSource({
      path: '/nowhere/credentials',
      readFile: (p) => {
        seen.push(p)
        return 'https://x-access-token:ghs_injected@github.com\n'
      },
    })
    expect(await src.getToken()).toBe('ghs_injected')
    expect(seen).toEqual(['/nowhere/credentials'])
  })

  test('REVU_CREDENTIALS_FILE overrides the default path; an explicit path wins over it', async () => {
    const envPath = tmpCredFile('https://x-access-token:ghs_from-env@github.com\n')
    const fromEnv = createFileCredentialTokenSource({
      env: { REVU_CREDENTIALS_FILE: envPath },
    })
    expect(await fromEnv.getToken()).toBe('ghs_from-env')

    const optPath = tmpCredFile('https://x-access-token:ghs_from-opt@github.com\n')
    const fromOpt = createFileCredentialTokenSource({
      path: optPath,
      env: { REVU_CREDENTIALS_FILE: envPath },
    })
    expect(await fromOpt.getToken()).toBe('ghs_from-opt')
  })

  test('a parse failure never places token-looking content in the error message or stack', async () => {
    // The token-looking string sits on a non-github host, so parsing finds no
    // usable entry — the thrown error must not echo any of the file's content.
    const secret = 'ghs_SUPERSECRETVALUE1234'
    const src = createFileCredentialTokenSource({
      path: tmpCredFile(`https://x-access-token:${secret}@evil.example.com\n`),
    })
    let caught: Error | undefined
    try {
      await src.getToken()
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(AwaitingCredentialError)
    expect(caught?.message).not.toContain(secret)
    expect(caught?.stack ?? '').not.toContain(secret)
  })

  test('a throwing reader cannot smuggle content into the error text', async () => {
    const secret = 'ghs_LEAKYREADERSECRET'
    const src = createFileCredentialTokenSource({
      readFile: () => {
        throw new Error(`read exploded near ${secret}`)
      },
    })
    let caught: Error | undefined
    try {
      await src.getToken()
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(AwaitingCredentialError)
    expect(caught?.message).not.toContain(secret)
    expect(caught?.stack ?? '').not.toContain(secret)
  })

  test('a reader that throws a non-object (throw null) still yields AwaitingCredentialError', async () => {
    const src = createFileCredentialTokenSource({
      readFile: () => {
        throw null
      },
    })
    await expect(src.getToken()).rejects.toBeInstanceOf(AwaitingCredentialError)
  })

  test('a reader whose thrown code is not an errno mnemonic surfaces no code (no smuggling)', async () => {
    const secret = 'ghs_CODEFIELDSECRET'
    const src = createFileCredentialTokenSource({
      readFile: () => {
        throw { code: secret }
      },
    })
    let caught: Error | undefined
    try {
      await src.getToken()
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(AwaitingCredentialError)
    expect(caught?.message).not.toContain(secret)
    expect(caught?.stack ?? '').not.toContain(secret)
  })

  test('a genuine errno mnemonic (EACCES) is surfaced as a tag', async () => {
    const src = createFileCredentialTokenSource({
      readFile: () => {
        throw { code: 'EACCES' }
      },
    })
    let caught: Error | undefined
    try {
      await src.getToken()
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(AwaitingCredentialError)
    expect(caught?.message).toContain('EACCES')
  })

  test('a lookalike host is never matched as github.com', async () => {
    const src = createFileCredentialTokenSource({
      path: tmpCredFile(
        'https://x-access-token:ghs_evil-sub@evil.github.com\n' +
          'https://x-access-token:ghs_evil-suffix@github.com.attacker.com\n' +
          'https://x-access-token:ghs_api@api.github.com\n',
      ),
    })
    await expect(src.getToken()).rejects.toBeInstanceOf(AwaitingCredentialError)
  })

  test('an http (non-https) github.com entry is skipped', async () => {
    const src = createFileCredentialTokenSource({
      path: tmpCredFile('http://x-access-token:ghs_insecure@github.com\n'),
    })
    await expect(src.getToken()).rejects.toBeInstanceOf(AwaitingCredentialError)
  })

  test('an entry with an undecodable percent-encoding is skipped as malformed', async () => {
    // A lone `%` is not a valid percent-escape; decodeURIComponent throws, so the
    // only github.com entry is skipped and no usable token remains.
    const src = createFileCredentialTokenSource({
      path: tmpCredFile('https://x-access-token:bad%passwd@github.com\n'),
    })
    await expect(src.getToken()).rejects.toBeInstanceOf(AwaitingCredentialError)
  })

  test('among multiple x-access-token github.com entries, the first wins', async () => {
    const src = createFileCredentialTokenSource({
      path: tmpCredFile(
        'https://x-access-token:ghs_current@github.com\n' +
          'https://x-access-token:ghs_older@github.com\n',
      ),
    })
    expect(await src.getToken()).toBe('ghs_current')
  })

  test('the module source never logs (no console usage)', () => {
    const source = readFileSync(new URL('./token-source.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/console\s*\./)
  })
})
