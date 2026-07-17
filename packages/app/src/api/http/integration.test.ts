/**
 * Integration proof for `createHttpApi` against a REAL revud over HTTP, plus
 * mock↔http parity. A daemon is spawned on an ephemeral port with a temp data
 * dir and a stub dist (it only needs SOME valid `index.html` to start), then the
 * fetch adapter is driven through the flows the app's state layer depends on:
 *
 *   - session, listPulls + ETag/304 reconstruction, sync → getSnapshot,
 *     never-synced → null, getBlob, reply/resolve/reaction, submitReview
 *     head-guard (a 200 value), an error path under a forced failure mode,
 *     `addReaction` carrying `?pr`, and an aborted sync rejecting.
 *
 * Parity: for reply/resolve/reaction, the same call against revud and against
 * the in-browser `createMockApi()` returns structurally the same result and,
 * under a forced write failure, throws the same `ApiError` code. Because the
 * daemon reuses the mock's semantics, the adapter is a faithful shell — so the
 * unchanged state-layer optimistic rollback behaves identically in both modes.
 *
 * The daemon-spawn harness mirrors `packages/revud/src/revud.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import { ApiError } from '@revu/shared'
import type { RevuApi } from '@revu/shared'
import { createHttpApi } from './adapter'
import { createMockApi } from '../mock/adapter'
import { mockDev } from '../mock/devtools'

const REVUD_ENTRY = join(import.meta.dir, '..', '..', '..', '..', 'revud', 'src', 'index.ts')

const STUB_INDEX_HTML =
  '<!doctype html><html><head><title>revud stub</title></head>' +
  '<body><div id="root"></div></body></html>'

function makeStubDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revud-http-dist-'))
  writeFileSync(join(dir, 'index.html'), STUB_INDEX_HTML, 'utf8')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  return dir
}

interface Daemon {
  proc: Subprocess
  base: string
  dataDir: string
}

async function waitReady(base: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/session`)
      if (res.ok) {
        await res.body?.cancel()
        return
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(50)
  }
  throw new Error(`revud did not become ready at ${base}`)
}

async function startDaemon(dataDir: string, distDir: string): Promise<Daemon> {
  const proc = Bun.spawn(['bun', 'run', REVUD_ENTRY], {
    env: {
      ...process.env,
      REVU_PORT: '0',
      REVU_DATA_DIR: dataDir,
      REVU_DIST_DIR: distDir,
      REVU_MODE: 'mock',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

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
  // Zero simulated latency so the flows run fast and deterministically.
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

/** Force a failure mode on the daemon's reused mock via its dev surface. */
async function setDaemonFailureMode(base: string, mode: string): Promise<void> {
  const res = await fetch(`${base}/api/dev`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ failureMode: mode }),
  })
  await res.body?.cancel()
}

let daemon: Daemon
let dataDir: string
let distDir: string
let http: RevuApi

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'revud-http-it-'))
  distDir = makeStubDist()
  daemon = await startDaemon(dataDir, distDir)
  http = createHttpApi(daemon.base)
})

afterAll(async () => {
  if (daemon) await stopDaemon(daemon)
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  if (distDir) rmSync(distDir, { recursive: true, force: true })
  // The parity checks drive an in-process mock whose store is shared across the
  // whole `bun test` process; reseed it so this file leaves no state behind for
  // another file to trip over.
  mockDev.reset()
})

describe('createHttpApi against revud', () => {
  test('getSession returns the workspace identity', async () => {
    const session = await http.getSession()
    expect(session.human.id.length).toBeGreaterThan(0)
    expect(session.brokerLogin.length).toBeGreaterThan(0)
    expect(session.workspace).toContain(session.human.id)
  })

  test('listPulls, then a conditional call with the etag → notModified reconstruction', async () => {
    const first = await http.listPulls()
    expect(first.notModified).toBe(false)
    expect(first.items.length).toBeGreaterThan(0)
    expect(first.etag.length).toBeGreaterThan(0)

    const second = await http.listPulls({ etag: first.etag })
    expect(second.notModified).toBe(true)
    expect(second.etag).toBe(first.etag)
    // The 304 carried no body: items and rateLimit were replayed from cache.
    expect(second.items).toEqual(first.items)
    expect(second.rateLimit).toEqual(first.rateLimit)
  })

  test('syncPull then getSnapshot returns the synced snapshot', async () => {
    const synced = await http.syncPull(101)
    expect(synced.prNumber).toBe(101)
    const cached = await http.getSnapshot(101)
    expect(cached).not.toBeNull()
    expect(cached?.prNumber).toBe(101)
  })

  test('getSnapshot on a never-synced PR is null (200 value, not an error)', async () => {
    const snap = await http.getSnapshot(355)
    expect(snap).toBeNull()
  })

  test('getBlob returns a content-addressed blob after a sync', async () => {
    const synced = await http.syncPull(101)
    const sha = Object.values(synced.immutable.blobIndex)
      .map((e) => e.head ?? e.base)
      .find((s): s is string => typeof s === 'string')
    expect(sha).toBeTruthy()
    const blob = await http.getBlob(sha as string)
    expect(blob.sha).toBe(sha as string)
  })

  test('submitReview head-guard returns head_moved as a 200 value (never throws)', async () => {
    await http.syncPull(204)
    const result = await http.submitReview({
      prNumber: 204,
      expectedHeadSha: 'stale-sha-that-does-not-match',
      event: 'COMMENT',
      body: 'looks good',
      comments: [],
    })
    expect(result.status).toBe('head_moved')
  })

  test('addReaction sends ?pr and returns the rollup', async () => {
    const snap = await http.syncPull(204)
    const commentId = snap.mutable.threads[0]?.comments[0]?.id
    expect(typeof commentId).toBe('number')
    const rollup = await http.addReaction(204, commentId as number, 'rocket')
    expect(rollup.total_count).toBeGreaterThan(0)
  })

  test('an aborted syncPull rejects (never resolves silently)', async () => {
    const controller = new AbortController()
    controller.abort()
    const err = await http.syncPull(312, { signal: controller.signal }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
  })

  test('a forced failure mode surfaces a typed ApiError on a write', async () => {
    await http.syncPull(204)
    await setDaemonFailureMode(daemon.base, 'writes')
    try {
      const err = await http.replyToThread(204, 'nonexistent', 'hi').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      // A failed write is the client-side network code (an enveloped 5xx that
      // the adapter reconstructs), matching the mock's write-failure throw.
      expect((err as ApiError).code).toBe('network')
    } finally {
      await setDaemonFailureMode(daemon.base, 'none')
    }
  })
})

describe('mock ↔ http parity: faithful adapter → identical rollback', () => {
  // A fresh mock instance seeded from the same fixtures at latency zero, driven
  // through the same calls as the daemon. Reset both stores' dev knobs first so
  // neither carries state from an earlier test.
  let mockApi: RevuApi

  beforeAll(async () => {
    mockDev.reset()
    mockDev.setLatency('zero')
    mockApi = createMockApi()
    await setDaemonFailureMode(daemon.base, 'none')
  })

  test('reply returns structurally the same shape from both adapters', async () => {
    const [httpSnap, mockSnap] = await Promise.all([http.syncPull(312), mockApi.syncPull(312)])
    const httpThread = httpSnap.mutable.threads[0]?.id
    const mockThread = mockSnap.mutable.threads[0]?.id
    expect(httpThread).toBeTruthy()

    const [httpComment, mockComment] = await Promise.all([
      http.replyToThread(312, httpThread as string, 'Parity check reply.'),
      mockApi.replyToThread(312, mockThread as string, 'Parity check reply.'),
    ])
    // Same structural keys and same value-carrying fields the UI renders.
    expect(Object.keys(httpComment).sort()).toEqual(Object.keys(mockComment).sort())
    expect(httpComment.body).toBe(mockComment.body)
    expect(httpComment.path).toBe(mockComment.path)
    expect(httpComment.side).toBe(mockComment.side)
    expect(httpComment.user.login).toBe(mockComment.user.login)
  })

  test('resolve returns the same thread-resolution shape from both adapters', async () => {
    const [httpSnap, mockSnap] = await Promise.all([http.syncPull(415), mockApi.syncPull(415)])
    const httpThread = httpSnap.mutable.threads.find((t) => !t.isResolved)?.id
    const mockThread = mockSnap.mutable.threads.find((t) => !t.isResolved)?.id
    expect(httpThread).toBeTruthy()

    const [httpRes, mockRes] = await Promise.all([
      http.resolveThread(415, httpThread as string, true),
      mockApi.resolveThread(415, mockThread as string, true),
    ])
    expect(httpRes.isResolved).toBe(true)
    expect(mockRes.isResolved).toBe(true)
    expect(httpRes.resolvedBy?.login).toBe(mockRes.resolvedBy?.login)
  })

  test('reaction returns the same rollup from both adapters', async () => {
    const [httpSnap, mockSnap] = await Promise.all([http.syncPull(347), mockApi.syncPull(347)])
    const httpId = httpSnap.mutable.threads[0]?.comments[0]?.id
    const mockId = mockSnap.mutable.threads[0]?.comments[0]?.id
    expect(typeof httpId).toBe('number')

    const [httpRollup, mockRollup] = await Promise.all([
      http.addReaction(347, httpId as number, 'heart'),
      mockApi.addReaction(347, mockId as number, 'heart'),
    ])
    expect(Object.keys(httpRollup).sort()).toEqual(Object.keys(mockRollup).sort())
    expect(httpRollup.heart).toBe(mockRollup.heart)
    expect(httpRollup.total_count).toBe(mockRollup.total_count)
  })

  test('under a forced write failure, both adapters throw the same ApiError code', async () => {
    await Promise.all([http.syncPull(101), mockApi.syncPull(101)])
    await setDaemonFailureMode(daemon.base, 'writes')
    mockDev.setFailureMode('writes')
    try {
      const httpErr = await http
        .replyToThread(101, 'no-such-thread', 'x')
        .catch((e: unknown) => e)
      const mockErr = await mockApi
        .replyToThread(101, 'no-such-thread', 'x')
        .catch((e: unknown) => e)
      expect(httpErr).toBeInstanceOf(ApiError)
      expect(mockErr).toBeInstanceOf(ApiError)
      // Identical failure code → the state layer's optimistic rollback fires
      // the same way in both transports.
      expect((httpErr as ApiError).code).toBe((mockErr as ApiError).code)
    } finally {
      await setDaemonFailureMode(daemon.base, 'none')
      mockDev.setFailureMode('none')
    }
  })
})
