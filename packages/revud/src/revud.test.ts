/**
 * Integration + durability proof for revud over REAL HTTP.
 *
 * The daemon is started on an ephemeral port with a temp data directory, and
 * representative `RevuApi` flows are driven through `fetch` against it. The
 * suite asserts the contract's three non-error transport semantics
 * (`getSnapshot` null-is-200, `syncPull` partial-is-200, `submitReview`
 * head_moved-is-200), the error envelope mapping, the `listPulls` ETag/304
 * rule, and — the exit criterion — that a saved draft survives a full daemon
 * restart because every mutation is flushed to disk atomically.
 *
 * Each test process gets its own data directory so the on-disk broker document
 * never bleeds between runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import type {
  PullListResponse,
  ReviewDraft,
  Session,
  Snapshot,
  SubmitResult,
} from '@revu/shared'

const ENTRY = join(import.meta.dir, 'index.ts')
const DIST = join(import.meta.dir, '..', '..', 'app', 'dist')

interface Daemon {
  proc: Subprocess
  base: string
  dataDir: string
}

/** Wait until `GET /api/session` answers, or throw after a bounded number of tries. */
async function waitReady(base: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/session`)
      if (res.ok) {
        await res.body?.cancel()
        return
      }
    } catch {
      // Not listening yet — retry.
    }
    await Bun.sleep(50)
  }
  throw new Error(`revud did not become ready at ${base}`)
}

/** Start a revud child process on an ephemeral port with zero simulated latency. */
async function startDaemon(dataDir: string): Promise<Daemon> {
  const proc = Bun.spawn(['bun', 'run', ENTRY], {
    env: {
      ...process.env,
      REVU_PORT: '0',
      REVU_DATA_DIR: dataDir,
      REVU_DIST_DIR: DIST,
      REVU_MODE: 'mock',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // The startup line reports the bound port: "... on http://localhost:PORT ...".
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let port = 0
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (value) buffer += decoder.decode(value)
    const m = /http:\/\/localhost:(\d+)/.exec(buffer)
    if (m) {
      port = Number(m[1])
      break
    }
    if (done) break
  }
  reader.releaseLock()
  if (port === 0) {
    proc.kill()
    throw new Error(`revud did not report a port. Output so far:\n${buffer}`)
  }

  const base = `http://localhost:${port}`
  await waitReady(base)
  // Drop simulated latency so the flows run fast and deterministically.
  const res = await fetch(`${base}/api/dev`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ latency: 'zero' }),
  })
  await res.body?.cancel()
  return { proc, base, dataDir }
}

async function stopDaemon(d: Daemon): Promise<void> {
  d.proc.kill('SIGTERM')
  await d.proc.exited
}

let daemon: Daemon
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'revud-it-'))
  daemon = await startDaemon(dataDir)
})

afterAll(async () => {
  if (daemon) await stopDaemon(daemon)
})

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.base}${path}`, init)
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

describe('static + session', () => {
  test('serves index.html at the root', async () => {
    const res = await api('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') ?? '').toContain('text/html')
    expect(await res.text()).toContain('<!doctype html>')
  })

  test('SPA fallback: unknown non-file path returns index.html', async () => {
    const res = await api('/pulls/204/files')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') ?? '').toContain('text/html')
  })

  test('getSession returns the session identity', async () => {
    const res = await api('/api/session')
    expect(res.status).toBe(200)
    const session = await json<Session>(res)
    expect(session.human.id.length).toBeGreaterThan(0)
    expect(session.brokerLogin.length).toBeGreaterThan(0)
    expect(session.workspace).toContain(session.human.id)
  })
})

describe('listPulls + ETag/304', () => {
  test('lists pulls and emits an ETag', async () => {
    const res = await api('/api/pulls')
    expect(res.status).toBe(200)
    const etag = res.headers.get('etag')
    expect(etag).toBeTruthy()
    const body = await json<PullListResponse>(res)
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.notModified).toBe(false)
  })

  test('a matching If-None-Match yields 304 with no body', async () => {
    const first = await api('/api/pulls')
    const etag = first.headers.get('etag') as string
    await first.body?.cancel()
    const second = await api('/api/pulls', { headers: { 'if-none-match': etag } })
    expect(second.status).toBe(304)
    expect(second.headers.get('etag')).toBe(etag)
    expect(await second.text()).toBe('')
  })
})

describe('the three non-error transport semantics', () => {
  test('getSnapshot on a never-synced PR is HTTP 200 with a null body', async () => {
    const res = await api('/api/pulls/101/snapshot')
    expect(res.status).toBe(200)
    expect(await json<Snapshot | null>(res)).toBeNull()
  })

  test('syncPull then getSnapshot returns the cached snapshot', async () => {
    const sync = await api('/api/pulls/101/sync', { method: 'POST' })
    expect(sync.status).toBe(200)
    const snapshot = await json<Snapshot>(sync)
    expect(snapshot.prNumber).toBe(101)

    const cached = await api('/api/pulls/101/snapshot')
    expect(cached.status).toBe(200)
    const got = await json<Snapshot | null>(cached)
    expect(got).not.toBeNull()
    expect(got?.prNumber).toBe(101)
  })

  test('syncPull that dies partway keeps a partial snapshot (HTTP 200), retry completes', async () => {
    // PR 401 carries `scenario.failSyncAfterBlobs: 3`: the FIRST sync fetches a
    // few blobs, then the connection drops. The adapter keeps a PARTIAL
    // snapshot naming the missing blobs and reports the drop as a network
    // envelope; the retry fetches the rest and completes. The observable
    // contract is: after the first attempt the cached snapshot is partial and
    // served as a plain HTTP 200 (never 404-as-error), and the retry lands a
    // full 200 snapshot with `partial: null`.
    const first = await api('/api/pulls/401/sync', { method: 'POST' })
    // The first attempt surfaces the mid-sync drop as a network envelope
    // (client-side 'network' has no wire status, so the broker maps it via the
    // adapter's thrown ApiError). The partial is on disk regardless.
    await first.body?.cancel()

    // getSnapshot must serve the kept partial as a 200 with a non-null partial.
    const partialRead = await api('/api/pulls/401/snapshot')
    expect(partialRead.status).toBe(200)
    const partialSnap = await json<Snapshot | null>(partialRead)
    expect(partialSnap).not.toBeNull()
    expect(partialSnap?.partial).not.toBeNull()

    const retry = await api('/api/pulls/401/sync', { method: 'POST' })
    expect(retry.status).toBe(200)
    const snap = await json<Snapshot>(retry)
    expect(snap.prNumber).toBe(401)
    expect(snap.partial).toBeNull()
  })

  test('submitReview head-guard mismatch is HTTP 200 with status head_moved', async () => {
    // Sync so a snapshot exists, then submit with a deliberately stale head SHA.
    const sync = await api('/api/pulls/204/sync', { method: 'POST' })
    await sync.body?.cancel()
    const res = await api('/api/pulls/204/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prNumber: 204,
        expectedHeadSha: 'stale-sha-that-does-not-match',
        event: 'COMMENT',
        body: 'looks good',
        comments: [],
      }),
    })
    expect(res.status).toBe(200)
    const result = await json<SubmitResult>(res)
    expect(result.status).toBe('head_moved')
  })
})

describe('writes + error envelope', () => {
  test('a reply write returns the created comment and is durable', async () => {
    // Sync 204 to populate its cached threads, then reply to the first thread.
    const sync = await api('/api/pulls/204/sync', { method: 'POST' })
    const snap = await json<Snapshot>(sync)
    const threadId = snap.mutable.threads[0]?.id
    expect(threadId).toBeTruthy()

    const res = await api(`/api/pulls/204/threads/${encodeURIComponent(threadId as string)}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Thanks for the fix.' }),
    })
    expect(res.status).toBe(200)
    const comment = await json<{ body: string }>(res)
    expect(comment.body).toContain('Thanks for the fix.')
  })

  test('a resolve write flips the thread state', async () => {
    const sync = await api('/api/pulls/204/sync', { method: 'POST' })
    const snap = await json<Snapshot>(sync)
    const threadId = snap.mutable.threads[0]?.id as string
    const res = await api(`/api/pulls/204/threads/${encodeURIComponent(threadId)}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resolved: true }),
    })
    expect(res.status).toBe(200)
    const thread = await json<{ isResolved: boolean }>(res)
    expect(thread.isResolved).toBe(true)
  })

  test('a reaction write returns the rollup', async () => {
    const sync = await api('/api/pulls/204/sync', { method: 'POST' })
    const snap = await json<Snapshot>(sync)
    const commentId = snap.mutable.threads[0]?.comments[0]?.id
    expect(typeof commentId).toBe('number')
    const res = await api(`/api/comments/${commentId}/reactions?pr=204`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reaction: 'rocket' }),
    })
    expect(res.status).toBe(200)
    const rollup = await json<{ total_count: number }>(res)
    expect(rollup.total_count).toBeGreaterThan(0)
  })

  test('failureMode maps a thrown ApiError to its envelope status', async () => {
    // Force remote reads to fail, then hit a remote read (getRateLimit). The
    // adapter throws broker_unreachable → HTTP 502 with a { code, message } body.
    const set = await api('/api/dev', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ failureMode: 'all' }),
    })
    await set.body?.cancel()
    try {
      const res = await api('/api/rate-limit')
      expect(res.status).toBe(502)
      const body = await json<{ code: string; message: string }>(res)
      expect(body.code).toBe('broker_unreachable')
      expect(body.message.length).toBeGreaterThan(0)
    } finally {
      const reset = await api('/api/dev', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ failureMode: 'none' }),
      })
      await reset.body?.cancel()
    }
  })
})

describe('untrusted body hardening', () => {
  test('saveDraft with a prototype-polluting humanId is rejected and does not pollute', async () => {
    const attack = {
      humanId: '__proto__',
      prNumber: 204,
      headSha: 'attack-head-sha',
      compareKey: 'base...attack-head-sha',
      body: 'prototype pollution attempt',
      event: 'COMMENT',
      comments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // The vector: a store write of `state.drafts['__proto__'][204]` on a
      // prototype resolves against `Object.prototype`; a following key write
      // would land on the shared prototype. A polluted prototype would surface
      // `polluted` on every plain object.
      polluted: 'yes',
    }
    const res = await api('/api/pulls/204/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(attack),
    })
    expect(res.status).toBe(400)
    await res.body?.cancel()

    // The daemon's own object prototype is not observable from this test
    // process, but the request must not have set a `polluted` key on any plain
    // object here either; assert this side is clean as a sanity guard.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect('polluted' in {}).toBe(false)

    // A normal, valid draft still saves (200) and round-trips.
    const good: ReviewDraft = {
      humanId: 'h-priya',
      prNumber: 204,
      headSha: 'clean-head-sha',
      compareKey: 'base...clean-head-sha',
      body: 'A perfectly ordinary draft.',
      event: 'COMMENT',
      comments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const save = await api('/api/pulls/204/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(good),
    })
    expect(save.status).toBe(200)
    await save.body?.cancel()

    const reload = await api('/api/pulls/204/draft')
    expect(reload.status).toBe(200)
    const loaded = await json<ReviewDraft | null>(reload)
    expect(loaded?.body).toContain('perfectly ordinary draft')
    expect(loaded?.headSha).toBe('clean-head-sha')
  })

  test('a malformed JSON body is a 400, not a 500 broker_unreachable', async () => {
    const res = await api('/api/pulls/204/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{', // not valid JSON → SyntaxError, must map to a client 400
    })
    expect(res.status).toBe(400)
    const body = await json<{ code: string; message: string }>(res)
    expect(body.code).not.toBe('broker_unreachable')
  })

  test('a body missing a required field is a 400, not a 500', async () => {
    const res = await api('/api/pulls/204/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Valid JSON but not a SubmitReviewInput (no expectedHeadSha/event/...).
      body: JSON.stringify({ prNumber: 204 }),
    })
    expect(res.status).toBe(400)
    const body = await json<{ code: string; message: string }>(res)
    expect(body.code).not.toBe('broker_unreachable')
  })

  test('submitReview with path :n ≠ body prNumber is a 400', async () => {
    const res = await api('/api/pulls/999/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prNumber: 204,
        expectedHeadSha: 'some-sha',
        event: 'COMMENT',
        body: 'mismatched pull number',
        comments: [],
      }),
    })
    expect(res.status).toBe(400)
    await res.body?.cancel()
  })

  test('saveDraft with path :n ≠ body prNumber is a 400', async () => {
    const draft: ReviewDraft = {
      humanId: 'h-priya',
      prNumber: 204,
      headSha: 'mismatch-head-sha',
      compareKey: 'base...mismatch-head-sha',
      body: 'draft for 204 posted to 999',
      event: 'COMMENT',
      comments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const res = await api('/api/pulls/999/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    })
    expect(res.status).toBe(400)
    await res.body?.cancel()
  })
})

describe('durability: a saved draft survives a restart', () => {
  test('saveDraft is flushed to disk and reloads after the daemon restarts', async () => {
    const draft: ReviewDraft = {
      humanId: 'h-priya',
      prNumber: 204,
      headSha: 'draft-head-sha',
      compareKey: 'base...draft-head-sha',
      body: 'Durable draft body — must survive a restart.',
      event: 'COMMENT',
      comments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const save = await api('/api/pulls/204/draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    })
    expect(save.status).toBe(200)
    await save.body?.cancel()

    // The on-disk document must already hold the draft (flush ran on the write).
    const docPath = join(dataDir, 'revu.broker.v1.json')
    const onDisk = JSON.parse(readFileSync(docPath, 'utf8')) as {
      drafts: Record<string, Record<string, ReviewDraft>>
    }
    expect(onDisk.drafts['h-priya']?.['204']?.body).toContain('must survive a restart')

    // Restart the daemon against the SAME data dir: a fresh store instance must
    // hydrate the draft from disk.
    await stopDaemon(daemon)
    daemon = await startDaemon(dataDir)

    const reload = await api('/api/pulls/204/draft')
    expect(reload.status).toBe(200)
    const loaded = await json<ReviewDraft | null>(reload)
    expect(loaded).not.toBeNull()
    expect(loaded?.body).toContain('must survive a restart')
    expect(loaded?.headSha).toBe('draft-head-sha')
  })
})
