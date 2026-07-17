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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import type {
  FileViewedState,
  PendingComment,
  PullListResponse,
  ReviewDraft,
  Session,
  Snapshot,
  SubmitResult,
} from '@revu/shared'

const ENTRY = join(import.meta.dir, 'index.ts')

// Permission-based failure injection (a read-only dir, an unreadable file) is
// a no-op for root, which bypasses mode bits — skip those tests rather than
// let them fail for the wrong reason.
const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0

// These tests only need the daemon to START, which requires SOME valid dist with
// an `index.html`; they do not need the real built frontend. A per-run stub dist
// keeps the suite hermetic — it passes on a fresh checkout where the app has not
// been built yet, and never depends on stale build output. `STUB_INDEX_HTML` and
// `STUB_ASSET_*` are what the static/SPA tests assert against.
const STUB_INDEX_HTML =
  '<!doctype html><html><head><title>revud stub</title></head>' +
  '<body><div id="root"></div></body></html>'
const STUB_ASSET_PATH = 'favicon.svg'
const STUB_ASSET_BODY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>'

/** Build a temp stub dist with a minimal `index.html` and one static asset. */
function makeStubDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revud-dist-'))
  writeFileSync(join(dir, 'index.html'), STUB_INDEX_HTML, 'utf8')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, STUB_ASSET_PATH), STUB_ASSET_BODY, 'utf8')
  return dir
}

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
async function startDaemon(dataDir: string, distDir: string): Promise<Daemon> {
  const proc = Bun.spawn(['bun', 'run', ENTRY], {
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
let distDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'revud-it-'))
  distDir = makeStubDist()
  daemon = await startDaemon(dataDir, distDir)
})

afterAll(async () => {
  if (daemon) await stopDaemon(daemon)
  // Best-effort cleanup so temp dirs never accumulate across runs.
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  if (distDir) rmSync(distDir, { recursive: true, force: true })
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
    expect(await res.text()).toBe(STUB_INDEX_HTML)
  })

  test('serves a real static asset from dist', async () => {
    const res = await api(`/${STUB_ASSET_PATH}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(STUB_ASSET_BODY)
  })

  test('SPA fallback: unknown non-file path returns index.html', async () => {
    const res = await api('/pulls/204/files')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') ?? '').toContain('text/html')
    expect(await res.text()).toBe(STUB_INDEX_HTML)
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

  test('a preferences PUT persists and the GET reads it back', async () => {
    const put = await api('/api/preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diffMode: 'split' }),
    })
    expect(put.status).toBe(200)
    const saved = await json<{ diffMode: string }>(put)
    expect(saved.diffMode).toBe('split')

    const get = await api('/api/preferences')
    expect(get.status).toBe(200)
    const read = await json<{ diffMode: string }>(get)
    expect(read.diffMode).toBe('split')
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
    daemon = await startDaemon(dataDir, distDir)

    const reload = await api('/api/pulls/204/draft')
    expect(reload.status).toBe(200)
    const loaded = await json<ReviewDraft | null>(reload)
    expect(loaded).not.toBeNull()
    expect(loaded?.body).toContain('must survive a restart')
    expect(loaded?.headSha).toBe('draft-head-sha')
  })
})

describe('cross-version durability: an older document is migrated, not wiped', () => {
  // The same-version restart above proves a draft survives a restart on THIS
  // build. It cannot catch the upgrade case: an on-disk document written by an
  // EARLIER build (before per-human preferences existed) has a lower store
  // version and no `preferences` field. If load() treated that as corruption it
  // would reseed from fixtures and flush the reseed over the file — permanently
  // wiping every draft, viewed entry, and overlay. This test writes exactly such
  // an older document (a draft + viewed entry that are NOT in the fixtures) and
  // asserts both survive the boot intact.
  let migDir: string
  let migDaemon: Daemon

  afterAll(async () => {
    if (migDaemon) await stopDaemon(migDaemon)
    if (migDir) rmSync(migDir, { recursive: true, force: true })
  })

  test('a pre-preferences (v1) document keeps its draft and viewed state on boot', async () => {
    migDir = mkdtempSync(join(tmpdir(), 'revud-mig-'))

    // A NON-fixture draft under PR 204 (no fixture seeds a draft there) with a
    // distinctive body: a reseed produces zero drafts for 204, so its presence
    // afterward proves the document was migrated rather than reseeded.
    const draft: ReviewDraft = {
      humanId: 'h-priya',
      prNumber: 204,
      headSha: 'legacy-head-sha',
      compareKey: 'base...legacy-head-sha',
      body: 'Legacy draft written before preferences existed — must survive the upgrade.',
      event: 'COMMENT',
      comments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const viewed: FileViewedState = {
      'src/legacy.ts': { viewed: true, blobSha: 'legacy-blob-sha', at: new Date().toISOString() },
    }

    // The shape a PRE-preferences build persisted: version 1, and crucially NO
    // `preferences` key. Everything else is a structurally sound document. The
    // `dev.humanId` selects which human the daemon's session reads back as, so
    // it must match the draft/viewed owner.
    const legacyDoc = {
      v: 1,
      dev: { humanId: 'h-priya', latency: 'zero', failureMode: 'none' },
      drafts: { 'h-priya': { '204': draft } },
      viewed: { 'h-priya': { '204': viewed } },
      snapshots: {},
      blobs: {},
      remoteMut: {},
      syncAttempts: {},
      rate: { remaining: 5000, reset: new Date(Date.now() + 3_600_000).toISOString() },
      counter: 0,
    }

    mkdirSync(migDir, { recursive: true })
    const docPath = join(migDir, 'revu.broker.v1.json')
    writeFileSync(docPath, JSON.stringify(legacyDoc), 'utf8')

    // Boot the daemon against the data dir that already holds the v1 document.
    migDaemon = await startDaemon(migDir, distDir)

    // The draft must still be there — migration, not reseed.
    const draftRes = await fetch(`${migDaemon.base}/api/pulls/204/draft`)
    expect(draftRes.status).toBe(200)
    const loadedDraft = await json<ReviewDraft | null>(draftRes)
    expect(loadedDraft).not.toBeNull()
    expect(loadedDraft?.body).toContain('must survive the upgrade')
    expect(loadedDraft?.headSha).toBe('legacy-head-sha')

    // The viewed entry must still be there too.
    const viewedRes = await fetch(`${migDaemon.base}/api/pulls/204/viewed`)
    expect(viewedRes.status).toBe(200)
    const loadedViewed = await json<FileViewedState>(viewedRes)
    expect(loadedViewed['src/legacy.ts']?.viewed).toBe(true)
    expect(loadedViewed['src/legacy.ts']?.blobSha).toBe('legacy-blob-sha')

    // The migration stamps the current version and defaults the new field. The
    // daemon writes on any mutation; force a flush by saving the preference,
    // then confirm the on-disk document upgraded and STILL holds the draft.
    const put = await fetch(`${migDaemon.base}/api/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diffMode: 'split' }),
    })
    expect(put.status).toBe(200)
    await put.body?.cancel()

    const onDisk = JSON.parse(readFileSync(docPath, 'utf8')) as {
      v: number
      preferences: Record<string, { diffMode: string }>
      drafts: Record<string, Record<string, ReviewDraft>>
    }
    expect(onDisk.v).toBeGreaterThan(1)
    expect(onDisk.preferences['h-priya']?.diffMode).toBe('split')
    expect(onDisk.drafts['h-priya']?.['204']?.body).toContain('must survive the upgrade')
  })
})

describe('cross-version durability: a v2 document upgrades to v3 without wiping drafts', () => {
  // Draft comments gained an optional `anchor.startLineText` (reconcile uses it
  // to validate a ranged comment's start line). That store change bumps the
  // version 2 → 3. A v2 document's draft comments have NO `startLineText`; if
  // load() treated the bump as reason to reseed it would flush fixtures over the
  // file and destroy every draft — the exact "drafts survive everything" failure.
  // This test writes a v2 document holding a draft with a RANGED comment that
  // lacks `startLineText` (a non-fixture PR so a reseed would produce nothing
  // there) and asserts the draft, its ranged comment, and its start_line all
  // survive the v2 → v3 boot intact.
  let migDir: string
  let migDaemon: Daemon

  afterAll(async () => {
    if (migDaemon) await stopDaemon(migDaemon)
    if (migDir) rmSync(migDir, { recursive: true, force: true })
  })

  test('a v2 document keeps a ranged draft comment lacking startLineText on boot', async () => {
    migDir = mkdtempSync(join(tmpdir(), 'revud-mig-v2-'))

    // A v2-shaped ranged comment: it spans start_line 8 → line 12 and its anchor
    // has NO `startLineText` (that field did not exist when v2 was written).
    const rangedComment: PendingComment = {
      key: 'legacy-ranged-key',
      path: 'src/legacy.ts',
      side: 'RIGHT',
      start_side: 'RIGHT',
      line: 12,
      start_line: 8,
      body: 'Ranged draft comment from a v2 document — must survive the upgrade.',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      anchor: {
        lineText: 'const end = compute()',
        contextBefore: ['  const mid = step()'],
        contextAfter: ['}'],
        // No startLineText — this is the whole point of the regression.
      },
    }

    // A NON-fixture draft under PR 204 with the ranged comment above.
    const draft: ReviewDraft = {
      humanId: 'h-priya',
      prNumber: 204,
      headSha: 'v2-head-sha',
      compareKey: 'base...v2-head-sha',
      body: 'v2 draft with a ranged comment — must survive the upgrade to v3.',
      event: 'COMMENT',
      comments: [rangedComment],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // The shape a v2 build persisted: version 2, WITH `preferences` (added in v2)
    // but no `startLineText` on any draft comment. Everything else is sound.
    const v2Doc = {
      v: 2,
      dev: { humanId: 'h-priya', latency: 'zero', failureMode: 'none' },
      drafts: { 'h-priya': { '204': draft } },
      viewed: {},
      preferences: { 'h-priya': { diffMode: 'unified' } },
      snapshots: {},
      blobs: {},
      remoteMut: {},
      syncAttempts: {},
      rate: { remaining: 5000, reset: new Date(Date.now() + 3_600_000).toISOString() },
      counter: 0,
    }

    mkdirSync(migDir, { recursive: true })
    const docPath = join(migDir, 'revu.broker.v1.json')
    writeFileSync(docPath, JSON.stringify(v2Doc), 'utf8')

    // Boot the daemon against the data dir that already holds the v2 document.
    migDaemon = await startDaemon(migDir, distDir)

    // The ranged draft comment must still be there — migration, not reseed —
    // with its start_line and its startLineText-less anchor intact.
    const draftRes = await fetch(`${migDaemon.base}/api/pulls/204/draft`)
    expect(draftRes.status).toBe(200)
    const loadedDraft = await json<ReviewDraft | null>(draftRes)
    expect(loadedDraft).not.toBeNull()
    expect(loadedDraft?.body).toContain('must survive the upgrade to v3')
    expect(loadedDraft?.comments).toHaveLength(1)
    const loadedComment = loadedDraft?.comments[0]
    expect(loadedComment?.start_line).toBe(8)
    expect(loadedComment?.line).toBe(12)
    expect(loadedComment?.anchor.lineText).toBe('const end = compute()')
    // The field never existed on this document; it stays absent, which makes
    // reconcile fall back to the old rigid start shift — no behavior change.
    expect(loadedComment?.anchor.startLineText).toBeUndefined()

    // Force a flush (any mutation persists) and confirm the on-disk document
    // upgraded to v3 while STILL holding the draft.
    const put = await fetch(`${migDaemon.base}/api/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diffMode: 'split' }),
    })
    expect(put.status).toBe(200)
    await put.body?.cancel()

    const onDisk = JSON.parse(readFileSync(docPath, 'utf8')) as {
      v: number
      drafts: Record<string, Record<string, ReviewDraft>>
    }
    expect(onDisk.v).toBe(3)
    expect(onDisk.drafts['h-priya']?.['204']?.body).toContain('must survive the upgrade to v3')
    expect(onDisk.drafts['h-priya']?.['204']?.comments[0]?.start_line).toBe(8)
  })
})

describe('durability: a failed disk write is a persist_failed 5xx, text retained', () => {
  // The store applies every mutation in memory and flushes to disk before the
  // response. When the disk refuses the write (here: the data dir made
  // read-only mid-session, so the atomic tmp-file write fails), the daemon must
  // NOT answer 200 — the UI would report the draft saved when it never reached
  // disk. It must answer the typed persist_failed envelope while keeping the
  // draft readable in memory, so nothing the user wrote is lost and a retry
  // after the disk recovers persists it.
  let roDir: string
  let roDaemon: Daemon

  afterAll(async () => {
    // Restore write permission first: tearing down a still-read-only dir would
    // fail, and the daemon's shutdown flush needs a writable dir to be clean.
    if (roDir) {
      try {
        chmodSync(roDir, 0o755)
      } catch {
        // Already writable or already gone.
      }
    }
    if (roDaemon) await stopDaemon(roDaemon)
    if (roDir) rmSync(roDir, { recursive: true, force: true })
  })

  test.skipIf(runningAsRoot)(
    'a read-only data dir mid-session: saveDraft answers 500 persist_failed, the draft stays readable, and a retry after recovery lands on disk',
    async () => {
      roDir = mkdtempSync(join(tmpdir(), 'revud-ro-'))
      roDaemon = await startDaemon(roDir, distDir)
      const docPath = join(roDir, 'revu.broker.v1.json')

      // A first draft persists normally and is on disk.
      const before: ReviewDraft = {
        humanId: 'h-priya',
        prNumber: 204,
        headSha: 'ro-head-sha',
        compareKey: 'base...ro-head-sha',
        body: 'Saved while the disk was healthy.',
        event: 'COMMENT',
        comments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      const okSave = await fetch(`${roDaemon.base}/api/pulls/204/draft`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(before),
      })
      expect(okSave.status).toBe(200)
      await okSave.body?.cancel()
      expect(readFileSync(docPath, 'utf8')).toContain('Saved while the disk was healthy.')

      // The disk goes read-only. The atomic write path (tmp file + rename)
      // needs a writable directory, so the next flush throws server-side.
      chmodSync(roDir, 0o555)
      const edited: ReviewDraft = {
        ...before,
        body: 'Edited while the disk was read-only — must not be lost.',
        updatedAt: new Date().toISOString(),
      }
      try {
        const failed = await fetch(`${roDaemon.base}/api/pulls/204/draft`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(edited),
        })
        expect(failed.status).toBe(500)
        const envelope = await json<{ code: string; message: string }>(failed)
        expect(envelope.code).toBe('persist_failed')
        expect(envelope.message.length).toBeGreaterThan(0)

        // The edit was applied in memory before the flush failed: reading the
        // draft back returns the NEW text — surfaced error, retained text.
        const read = await fetch(`${roDaemon.base}/api/pulls/204/draft`)
        expect(read.status).toBe(200)
        const kept = await json<ReviewDraft | null>(read)
        expect(kept?.body).toBe('Edited while the disk was read-only — must not be lost.')

        // The on-disk document still holds the pre-failure copy — the failed
        // write neither corrupted nor truncated it (atomic tmp+rename).
        expect(readFileSync(docPath, 'utf8')).toContain('Saved while the disk was healthy.')
      } finally {
        chmodSync(roDir, 0o755)
      }

      // The disk recovered: retrying the same save now succeeds and persists.
      const retry = await fetch(`${roDaemon.base}/api/pulls/204/draft`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(edited),
      })
      expect(retry.status).toBe(200)
      await retry.body?.cancel()
      expect(readFileSync(docPath, 'utf8')).toContain(
        'Edited while the disk was read-only — must not be lost.',
      )
    },
  )
})

describe('boot: unreadable is not absent — never reseed over a present store file', () => {
  // DiskStorage returns null only for a genuinely ABSENT document (never
  // persisted — seeding is correct). A PRESENT file that cannot be read must
  // fail the boot loudly instead: the store treats null as absent and reseeds,
  // and the next flush would overwrite the real document — full of drafts —
  // with fresh seed state, turning a transient I/O error into permanent loss.
  test.skipIf(runningAsRoot)(
    'a present-but-unreadable store file refuses to boot and is left untouched',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'revud-unreadable-'))
      const docPath = join(dir, 'revu.broker.v1.json')
      try {
        const original = JSON.stringify({ sentinel: 'irreplaceable document — must never be reseeded over' })
        writeFileSync(docPath, original, 'utf8')
        chmodSync(docPath, 0o000)

        const proc = Bun.spawn(['bun', 'run', ENTRY], {
          env: {
            ...process.env,
            REVU_PORT: '0',
            REVU_DATA_DIR: dir,
            REVU_DIST_DIR: distDir,
            REVU_MODE: 'mock',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const exitCode = await proc.exited
        const stderr = await new Response(proc.stderr).text()

        // A hard startup failure with a message that names the file and the fix.
        expect(exitCode).not.toBe(0)
        expect(stderr).toContain(docPath)
        expect(stderr).toContain('could not be read')

        // The file was not overwritten with seed state — byte-identical.
        chmodSync(docPath, 0o644)
        expect(readFileSync(docPath, 'utf8')).toBe(original)
      } finally {
        try {
          chmodSync(docPath, 0o644)
        } catch {
          // Already readable or already gone.
        }
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  test('a genuinely absent store file still seeds normally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'revud-fresh-'))
    let fresh: Daemon | null = null
    try {
      fresh = await startDaemon(dir, distDir)
      const res = await fetch(`${fresh.base}/api/pulls`)
      expect(res.status).toBe(200)
      const list = await json<PullListResponse>(res)
      expect(list.items.length).toBeGreaterThan(0)
    } finally {
      if (fresh) await stopDaemon(fresh)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
