/**
 * Token-custody verification for the broker deployment: the injected GitHub
 * credential is read per request, server-side, and is NEVER serialized into
 * anything the browser can see. The custody claim proven here is precisely
 * "revu adds no new credential and never serializes tokens" — the workspace
 * itself DOES hold a live injected token (that is the deployment model), so
 * what these tests pin is the boundary revu owns:
 *
 *   - a full sweep of the broker HTTP surface — every route in the shared
 *     contract table (the sweep iterates `ROUTES` itself, so a newly added
 *     route cannot silently dodge it), plus the dev and unknown-path branches,
 *     success and failure envelopes alike — never carries the credential-file
 *     token in any response body or header, while the token demonstrably IS
 *     resolved server-side during the sweep (a counting source proves the
 *     reads);
 *   - the real GitHub client confines the token to the outbound
 *     `Authorization` header — never the URL, the request body, or a thrown
 *     error's message/stack;
 *   - a credential-file read failure surfaces at most a sanitized errno
 *     mnemonic (`/^[A-Z][A-Z0-9_]{0,31}$/`) — never reader-controlled content,
 *     so a hostile reader (or hostile file content) cannot smuggle bytes into
 *     an error the router would serialize;
 *   - the served session is identity-only (no token-shaped field), and the
 *     app's HTTP transport source carries no credential vocabulary at all —
 *     the browser side has nothing to receive a token WITH.
 *
 * All file access is per-test temp dirs; no test touches the real
 * `~/.git-credentials`, no test opens a non-loopback socket.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'bun'
import type { Session } from '@revu/shared'
import { fillPath, ROUTES } from '@revu/shared'
import {
  CONFORMANCE_REPO,
  CONFORMANCE_SESSION,
  MOVING_BASE_PR,
  movingBaseClient,
  tokenGated,
} from '../direct/conformance-fakes'
import { createDirectApi } from '../direct/direct-api'
import type { FetchLike } from '../direct/github-client'
import { createGithubClient, GithubRequestError } from '../direct/github-client'
import { openDirectStore } from '../direct/store'
import type { TokenSource } from '../direct/token-source'
import { startServer } from '../server'
import { AwaitingCredentialError, createFileCredentialTokenSource } from './token-source'

/** A distinctive fake token; if it ever appears in a response, custody broke. */
const CANARY = 'ghs_CANARYTOKENNEVERSERIALIZED9f3a'

/** The errno-mnemonic shape a sanitized read-failure tag must match. */
const ERRNO_MNEMONIC = /^[A-Z][A-Z0-9_]{0,31}$/

const STUB_INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>'

function makeStubDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revu-custody-dist-'))
  writeFileSync(join(dir, 'index.html'), STUB_INDEX_HTML, 'utf8')
  return dir
}

/** Wrap a token source so the test can prove the token was actually resolved. */
function countingSource(inner: TokenSource): { source: TokenSource; reads: () => number } {
  let n = 0
  return {
    source: {
      async getToken(): Promise<string> {
        n += 1
        return inner.getToken()
      },
    },
    reads: () => n,
  }
}

const tmpDirs: string[] = []
let server: Server | undefined

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  if (server) {
    server.stop(true)
    server = undefined
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Read a response fully and assert no forbidden string appears in its body,
 * status text, or any header (name or value). Returns the body text so callers
 * can make further shape assertions without re-reading the stream.
 */
async function scanResponse(res: Response, forbidden: readonly string[]): Promise<string> {
  const text = await res.text()
  for (const secret of forbidden) {
    expect(text).not.toContain(secret)
    expect(res.statusText).not.toContain(secret)
    res.headers.forEach((value, key) => {
      expect(key).not.toContain(secret)
      expect(value).not.toContain(secret)
    })
  }
  return text
}

describe('broker HTTP surface never serializes the injected token', () => {
  test('a full route sweep (every ROUTES entry, plus dev and unknown paths) leaks nothing while the token IS read server-side', async () => {
    const dataDir = tmpDir('revu-custody-data-')
    const distDir = makeStubDist()
    const credentialFile = join(dataDir, '.git-credentials')
    writeFileSync(credentialFile, `https://x-access-token:${CANARY}@github.com\n`, 'utf8')

    const counted = countingSource(createFileCredentialTokenSource({ path: credentialFile }))
    const store = openDirectStore({ dataDir })
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      github: tokenGated(
        movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }),
        counted.source,
      ),
      repo: CONFORMANCE_REPO,
      store,
    })
    server = startServer({
      port: 0,
      distDir,
      directSession: CONFORMANCE_SESSION,
      directApi: api,
      mode: 'broker',
      hostname: '127.0.0.1',
    })
    const base = `http://127.0.0.1:${server.port}`
    const forbidden = [CANARY]

    // getSession: identity only, and no token-shaped field anywhere in the JSON.
    const sessionText = await scanResponse(await fetch(`${base}/api/session`), forbidden)
    const session = JSON.parse(sessionText) as Session
    expect(session.human.id).toBe(CONFORMANCE_SESSION.human.id)
    const allowedSessionKeys = new Set(['human', 'brokerLogin', 'workspace', 'viewerLogin'])
    for (const key of Object.keys(session)) expect(allowedSessionKeys.has(key)).toBe(true)
    expect(sessionText.toLowerCase()).not.toContain('token')
    expect(sessionText).not.toContain('ghs_')

    // syncPull: the heaviest read — resolves the token on every wrapped GitHub
    // call and assembles the largest response body served anywhere.
    const readsBefore = counted.reads()
    const syncText = await scanResponse(
      await fetch(`${base}/api/pulls/${MOVING_BASE_PR}/sync`, { method: 'POST' }),
      forbidden,
    )
    const snap = JSON.parse(syncText) as {
      prNumber: number
      immutable: { headSha: string; compareKey: string; files: { filename: string }[]; blobIndex: Record<string, { head?: string }> }
    }
    expect(snap.prNumber).toBe(MOVING_BASE_PR)
    // The sweep is meaningful only if the token really was read server-side.
    expect(counted.reads()).toBeGreaterThan(readsBefore)

    // getSnapshot re-serves the stored snapshot.
    await scanResponse(await fetch(`${base}/api/pulls/${MOVING_BASE_PR}/snapshot`), forbidden)

    // getBlob serves stored content-addressed bytes.
    const blobSha = snap.immutable.blobIndex[snap.immutable.files[0].filename]?.head
    expect(typeof blobSha).toBe('string')
    await scanResponse(await fetch(`${base}/api/blobs/${blobSha as string}`), forbidden)

    // Drafts: save (keyed by the boot-time session, whatever the body claims),
    // read back, and reconcile against the synced snapshot.
    const now = '2026-07-18T00:00:00.000Z'
    const draftBody = JSON.stringify({
      humanId: CONFORMANCE_SESSION.human.id,
      prNumber: MOVING_BASE_PR,
      headSha: snap.immutable.headSha,
      compareKey: snap.immutable.compareKey,
      body: 'custody sweep draft',
      event: 'COMMENT',
      comments: [],
      createdAt: now,
      updatedAt: now,
    })
    await scanResponse(
      await fetch(`${base}/api/pulls/${MOVING_BASE_PR}/draft`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: draftBody,
      }),
      forbidden,
    )
    await scanResponse(await fetch(`${base}/api/pulls/${MOVING_BASE_PR}/draft`), forbidden)
    await scanResponse(await fetch(`${base}/api/pulls/${MOVING_BASE_PR}/reconcile`), forbidden)

    // Viewed state and preferences, both directions.
    await scanResponse(await fetch(`${base}/api/pulls/${MOVING_BASE_PR}/viewed`), forbidden)
    await scanResponse(
      await fetch(`${base}/api/pulls/${MOVING_BASE_PR}/viewed`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'a.ts', viewed: true, blobSha: null }),
      }),
      forbidden,
    )
    await scanResponse(await fetch(`${base}/api/preferences`), forbidden)
    await scanResponse(
      await fetch(`${base}/api/preferences`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      forbidden,
    )

    // The pull list without a poll loop, a gated write on a reads-only broker,
    // the mock-only dev route, and an unknown path: every non-2xx envelope is
    // scanned exactly like the successes.
    await scanResponse(await fetch(`${base}/api/pulls`), forbidden)
    const gated = await fetch(`${base}/api/pulls/${MOVING_BASE_PR}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(gated.status).toBe(501)
    await scanResponse(gated, forbidden)
    const dev = await fetch(`${base}/api/dev`)
    expect(dev.status).toBe(404)
    await scanResponse(dev, forbidden)
    await scanResponse(await fetch(`${base}/api/definitely-not-a-route`), forbidden)

    // Completeness pass, derived from the contract route table itself: EVERY
    // route in `ROUTES` is fetched and its envelope scanned, whatever that
    // envelope is on this reads-only broker (200 value, 400 validation, typed
    // 404, 501 not-implemented/write-gate). A route added to the table later
    // enters this sweep automatically — and a new path parameter makes
    // `fillPath` throw, failing the test loudly instead of skipping the route.
    const sweepParams = { n: MOVING_BASE_PR, sha: blobSha as string, threadId: 'T1', id: 1 }
    for (const route of Object.values(ROUTES)) {
      const hasBody = route.method === 'POST' || route.method === 'PUT'
      const res = await fetch(`${base}${fillPath(route.path, sweepParams)}`, {
        method: route.method,
        ...(hasBody ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      })
      const text = await scanResponse(res, forbidden)
      // Never the unknown-path fallback envelope: proof each sweep request
      // reached its own route handler rather than scanning a meaningless
      // no-route response. (A TYPED 404 from a handler — e.g. the live pull
      // list on an instance without a poll loop — is a legitimate envelope
      // and is still scanned above.)
      expect(text).not.toContain('No route for')
    }

    store.close()
  })

  test('credential-file failure paths surface a typed 502 with no file content and no token', async () => {
    const dataDir = tmpDir('revu-custody-fail-')
    const distDir = makeStubDist()
    const credentialFile = join(dataDir, '.git-credentials')
    writeFileSync(credentialFile, `https://x-access-token:${CANARY}@github.com\n`, 'utf8')

    const store = openDirectStore({ dataDir })
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      github: tokenGated(
        movingBaseClient({ mergeBaseSha: 'MB1', unresolvedComments: 0 }),
        createFileCredentialTokenSource({ path: credentialFile }),
      ),
      repo: CONFORMANCE_REPO,
      store,
    })
    server = startServer({
      port: 0,
      distDir,
      directSession: CONFORMANCE_SESSION,
      directApi: api,
      mode: 'broker',
      hostname: '127.0.0.1',
    })
    const base = `http://127.0.0.1:${server.port}`

    // Hostile file content: a token-looking secret on a non-github host means
    // no usable credential — the 502 envelope must not echo a byte of the file.
    const fileSecret = 'ghs_HOSTILEFILECONTENTSECRET'
    writeFileSync(credentialFile, `https://x-access-token:${fileSecret}@evil.example.com\n`, 'utf8')
    const hostile = await fetch(`${base}/api/pulls/${MOVING_BASE_PR}/sync`, { method: 'POST' })
    expect(hostile.status).toBe(502)
    const hostileText = await scanResponse(hostile, [CANARY, fileSecret, 'evil.example.com'])
    expect((JSON.parse(hostileText) as { code: string }).code).toBe('broker_unreachable')

    // Missing file: the transient pre-injection state, same typed 502.
    rmSync(credentialFile, { force: true })
    const missing = await fetch(`${base}/api/pulls/${MOVING_BASE_PR}/sync`, { method: 'POST' })
    expect(missing.status).toBe(502)
    const missingText = await scanResponse(missing, [CANARY, fileSecret])
    expect((JSON.parse(missingText) as { code: string }).code).toBe('broker_unreachable')

    store.close()
  })
})

describe('the real GitHub client confines the token to the outbound Authorization header', () => {
  function recordingFetch(respond: () => Response): {
    fetchImpl: FetchLike
    calls: { url: string; init: RequestInit | undefined }[]
  } {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return respond()
    }
    return { fetchImpl, calls }
  }

  function fileSource(dir: string): TokenSource {
    const path = join(dir, '.git-credentials')
    writeFileSync(path, `https://x-access-token:${CANARY}@github.com\n`, 'utf8')
    return createFileCredentialTokenSource({ path })
  }

  test('a GET sends Bearer <token> in the header and nowhere else', async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(JSON.stringify({ login: 'app[bot]', id: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const client = createGithubClient({
      tokenSource: fileSource(tmpDir('revu-custody-client-')),
      fetchImpl,
    })
    const viewer = await client.getViewer()
    expect(viewer.login).toBe('app[bot]')
    expect(calls).toHaveLength(1)
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${CANARY}`)
    // The token rides ONLY in the header: never the URL, never a body.
    expect(calls[0].url).not.toContain(CANARY)
    expect(String(calls[0].init?.body ?? '')).not.toContain(CANARY)
    // The resolved value contains no token material either.
    expect(JSON.stringify(viewer)).not.toContain(CANARY)
  })

  test('a non-2xx GET throws with a bounded excerpt that carries no token', async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response('upstream exploded', { status: 500 }),
    )
    const client = createGithubClient({
      tokenSource: fileSource(tmpDir('revu-custody-client-err-')),
      fetchImpl,
    })
    let caught: Error | undefined
    try {
      await client.getViewer()
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(GithubRequestError)
    expect(caught?.message).toContain('HTTP 500')
    expect(caught?.message).not.toContain(CANARY)
    expect(caught?.stack ?? '').not.toContain(CANARY)
  })

  test('a failing POST (write path) neither sends the token in the body nor throws it', async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response('{"message":"Validation Failed"}', { status: 422 }),
    )
    const client = createGithubClient({
      tokenSource: fileSource(tmpDir('revu-custody-client-post-')),
      fetchImpl,
    })
    let caught: GithubRequestError | undefined
    try {
      await client.submitReview('o', 'r', 1, {
        commit_id: 'HEAD',
        event: 'COMMENT',
        body: 'b',
        comments: [],
      })
    } catch (err) {
      caught = err as GithubRequestError
    }
    expect(caught).toBeInstanceOf(GithubRequestError)
    expect(caught?.status).toBe(422)
    expect(caught?.message).not.toContain(CANARY)
    expect(caught?.stack ?? '').not.toContain(CANARY)
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${CANARY}`)
    expect(String(calls[0].init?.body ?? '')).not.toContain(CANARY)
  })
})

describe('a token-file read failure surfaces at most a sanitized errno mnemonic', () => {
  /**
   * Extract the parenthesized detail an awaiting-credential message carries,
   * or null when the message has none. The detail is the ONLY part of the
   * message a reader failure can influence, so it is what the bound applies to.
   */
  function detailOf(message: string): string | null {
    const match = /\(([^)]*)\)\s*$/.exec(message)
    return match ? match[1] : null
  }

  /** The fixed, reader-independent detail phrases the source may emit. */
  const FIXED_DETAILS = new Set(['credential file not found', 'credential file unreadable'])

  async function failWith(thrown: unknown): Promise<AwaitingCredentialError> {
    const src = createFileCredentialTokenSource({
      readFile: () => {
        throw thrown
      },
    })
    let caught: unknown
    try {
      await src.getToken()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AwaitingCredentialError)
    return caught as AwaitingCredentialError
  }

  test('every hostile reader failure yields a fixed phrase or an errno-shaped tag — never reader content', async () => {
    const secret = 'ghs_readerControlledSecret/with spaces!'
    const hostileThrows: unknown[] = [
      new Error(`read failed near ${secret}`),
      { code: secret },
      { code: 'not a mnemonic!!' },
      { code: 'ghs_lowercase_code' },
      { code: 'E'.repeat(40) },
      null,
      'a bare string throw',
      { code: 42 },
    ]
    for (const thrown of hostileThrows) {
      const err = await failWith(thrown)
      expect(err.message).not.toContain(secret)
      expect(err.stack ?? '').not.toContain(secret)
      const detail = detailOf(err.message)
      expect(detail).not.toBeNull()
      if (!FIXED_DETAILS.has(detail as string)) {
        // The only remaining legal shape: a fixed prefix plus an errno tag
        // bounded to the mnemonic charset and length.
        const tagged = /^credential file unreadable: (.+)$/.exec(detail as string)
        expect(tagged).not.toBeNull()
        expect(tagged![1]).toMatch(ERRNO_MNEMONIC)
      }
    }
  })

  test('a genuine errno mnemonic is preserved as the tag and matches the bound', async () => {
    const err = await failWith({ code: 'EACCES' })
    expect(detailOf(err.message)).toBe('credential file unreadable: EACCES')
    expect('EACCES').toMatch(ERRNO_MNEMONIC)
  })

  test('a real GitHub token shape can never pass the mnemonic bound', () => {
    // Installation tokens are prefixed lowercase (`ghs_…`), so the uppercase
    // errno charset structurally cannot carry one.
    expect('ghs_realTokenShape123').not.toMatch(ERRNO_MNEMONIC)
    expect(CANARY).not.toMatch(ERRNO_MNEMONIC)
  })
})

describe('the browser side has nothing to receive a token with', () => {
  test('the app HTTP transport source contains no credential vocabulary', () => {
    // The app talks to revud with plain same-origin fetches: no Authorization
    // header, no bearer scheme, no credential handling of any kind. A change
    // that introduces any of that vocabulary into the transport is a custody
    // regression and must fail here.
    const appApiDir = join(import.meta.dir, '..', '..', '..', 'app', 'src', 'api')
    for (const file of ['http/adapter.ts', 'select.ts', 'index.ts']) {
      const source = readFileSync(join(appApiDir, file), 'utf8')
      expect(source).not.toMatch(/authorization/i)
      expect(source).not.toMatch(/bearer/i)
      expect(source).not.toMatch(/x-access-token/i)
      expect(source).not.toMatch(/credential/i)
    }
  })

  test('the broker token-source module never logs', () => {
    const source = readFileSync(new URL('./token-source.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/console\s*\./)
  })
})
