/**
 * Cross-human draft isolation verification, at both trust boundaries:
 *
 *   - HOST STORE: a draft landed for one human is unreachable through any
 *     other human's channel-authentic `coder.owner`; access is authorized by
 *     the owner binding and by NOTHING a caller claims — there is no method
 *     that accepts an email, and an unknown owner fails loud rather than
 *     reading empty.
 *   - HTTP SURFACE: no route addresses per-human state by an identity path
 *     parameter. A path-embedded email (`/…/drafts/<email>/<n>` in any
 *     spelling) would let any workspace read any human's drafts, so the route
 *     table is pinned to carry ONLY resource params (`:n`, `:sha`, `:threadId`,
 *     `:id`) and every email-addressed probe must fall outside the API surface
 *     entirely. In-workspace draft writes are keyed by the boot-time session
 *     identity: a spoofed `humanId` in a PUT body is overwritten before it
 *     touches the store.
 *   - The mock-only dev routes — the one surface that lets a caller PICK the
 *     acting human — must not exist in broker mode.
 *
 * Store tests are disk-local temp dirs; HTTP tests run against a real
 * loopback server in broker mode with a stub frontend.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { Server } from 'bun'
import type { ReviewDraft } from '@revu/shared'
import { ROUTES } from '@revu/shared'
import { createMapCoderOwnerResolver } from './collector/identity-binding'
import { openHostStore, UnboundOwnerError, type HostStore } from './collector/host-store'
import { CONFORMANCE_REPO, CONFORMANCE_SESSION } from './direct/conformance-fakes'
import { createDirectApi } from './direct/direct-api'
import { throwingGithubClient } from './direct/github-write-stubs'
import { openDirectStore, type DirectStore } from './direct/store'
import { startServer } from './server'

const NOW = '2026-07-18T00:00:00.000Z'

function draft(humanId: string, prNumber: number, body: string): ReviewDraft {
  return {
    humanId,
    prNumber,
    headSha: 'head',
    compareKey: 'base...head',
    body,
    event: 'COMMENT',
    comments: [],
    createdAt: NOW,
    updatedAt: NOW,
  }
}

describe('host store: drafts are reachable only through the owning coder.owner binding', () => {
  let dir: string
  const resolver = createMapCoderOwnerResolver({
    alice: { email: 'alice@corp.com' },
    bob: { email: 'bob@corp.com' },
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'revu-draft-iso-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function open(): HostStore {
    return openHostStore({ resolver, dataDir: dir })
  }

  test("human A's landed draft is not reachable via human B's channel", () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'alice private notes'))
    // Bob's channel sees nothing of Alice's draft — null, not an error, and
    // never Alice's content.
    expect(store.getDraft('bob', 204)).toBeNull()
    expect(store.getDraft('alice', 204)?.body).toBe('alice private notes')
    store.close()
  })

  test('an unknown owner cannot read ANY draft — fail-loud, never an empty-but-authorized read', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'alice private notes'))
    expect(() => store.getDraft('mallory', 204)).toThrow(UnboundOwnerError)
    store.close()
  })

  test('a caller-claimed email is NOT a key: passing an email as the owner label resolves nothing', () => {
    const store = open()
    store.landDraft('alice', draft('alice@corp.com', 204, 'alice private notes'))
    // The store's argument is a coder.owner label resolved through the
    // binding. An email is a store KEY, not a credential — so presenting the
    // very email the row is stored under does not authorize the read.
    expect(() => store.getDraft('alice@corp.com', 204)).toThrow(UnboundOwnerError)
    expect(() => store.listAuditForOwner('alice@corp.com')).toThrow(UnboundOwnerError)
    store.close()
  })

  test('a spoofed embedded humanId cannot place a draft in another keyspace', () => {
    const store = open()
    // Alice's workspace claims the draft belongs to Bob; the channel wins.
    store.landDraft('alice', draft('bob@corp.com', 204, 'misdirected'))
    expect(store.getDraft('bob', 204)).toBeNull()
    expect(store.getDraft('alice', 204)?.humanId).toBe('alice@corp.com')
    store.close()
    const raw = new Database(join(dir, 'host.sqlite'))
    const rows = raw.query('SELECT human_id FROM drafts').all() as { human_id: string }[]
    raw.close()
    expect(rows).toEqual([{ human_id: 'alice@corp.com' }])
  })
})

describe('route table: per-human state is never addressed by an identity path param', () => {
  test('every path parameter is a resource id — :n, :sha, :threadId, :id — never an email or human id', () => {
    const allowed = new Set(['n', 'sha', 'threadId', 'id'])
    for (const route of Object.values(ROUTES)) {
      for (const segment of route.path.split('/')) {
        if (!segment.startsWith(':')) continue
        expect(allowed.has(segment.slice(1))).toBe(true)
      }
      // No route path names an identity dimension at all: the acting human is
      // established by the channel (the session), never by the URL.
      expect(route.path).not.toMatch(/email|human|owner|user/i)
    }
  })

  test('the draft routes carry exactly the pull number — no identity segment exists to traverse', () => {
    expect(ROUTES.getDraft.path).toBe('/api/pulls/:n/draft')
    expect(ROUTES.saveDraft.path).toBe('/api/pulls/:n/draft')
    expect(ROUTES.discardDraft.path).toBe('/api/pulls/:n/draft')
  })
})

describe('broker HTTP surface: email-addressed probes and identity-selection routes do not exist', () => {
  const STUB_INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>'
  const DRAFT_BODY_TEXT = 'session-keyed private draft body'

  let dataDir: string
  let distDir: string
  let store: DirectStore
  let server: Server
  let base: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'revu-draft-iso-http-'))
    distDir = mkdtempSync(join(tmpdir(), 'revu-draft-iso-dist-'))
    writeFileSync(join(distDir, 'index.html'), STUB_INDEX_HTML, 'utf8')
    store = openDirectStore({ dataDir })
    // Draft routes are pure store traffic: a GitHub client that throws on any
    // call proves no probe below ever reaches GitHub.
    const api = createDirectApi({
      session: CONFORMANCE_SESSION,
      github: throwingGithubClient(),
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
    base = `http://127.0.0.1:${server.port}`
  })

  afterEach(() => {
    server.stop(true)
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(distDir, { recursive: true, force: true })
  })

  test('a saved draft is keyed by the session identity, overriding a spoofed body humanId', async () => {
    const res = await fetch(`${base}/api/pulls/204/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft('victim@corp.com', 204, DRAFT_BODY_TEXT)),
    })
    expect(res.status).toBe(200)
    const saved = (await res.json()) as ReviewDraft
    // The claimed identity is discarded before the store is touched.
    expect(saved.humanId).toBe(CONFORMANCE_SESSION.human.id)
    expect(store.getDraft(CONFORMANCE_SESSION.human.id, 204)?.body).toBe(DRAFT_BODY_TEXT)
    expect(store.getDraft('victim@corp.com', 204)).toBeNull()
  })

  test('no email-addressed draft path exists — every spelling misses the API surface and leaks nothing', async () => {
    // Seed the session human's draft so a leak would have content to show.
    await fetch(`${base}/api/pulls/204/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft(CONFORMANCE_SESSION.human.id, 204, DRAFT_BODY_TEXT)),
    })

    const email = encodeURIComponent(CONFORMANCE_SESSION.human.id)
    const probes = [
      `/api/drafts/${email}/204`,
      `/api/drafts/${email}`,
      `/api/humans/${email}/drafts/204`,
      `/api/pulls/204/draft/${email}`,
      `/api/pulls/204/drafts/${email}`,
      `/v1/drafts/${email}/204`,
    ]
    for (const probe of probes) {
      const res = await fetch(`${base}${probe}`)
      const text = await res.text()
      // Inside /api the probe is a JSON 404; outside it falls to the SPA
      // fallback. Either way NO route serves a draft there, so the stored
      // draft's content must never appear.
      if (probe.startsWith('/api/')) {
        expect(res.status).toBe(404)
        expect((JSON.parse(text) as { code: string }).code).toBe('not_found')
      } else {
        expect(text).toBe(STUB_INDEX_HTML)
      }
      expect(text).not.toContain(DRAFT_BODY_TEXT)
      expect(text).not.toContain(CONFORMANCE_SESSION.human.id)
    }
  })

  test('the identity-selection dev routes are unreachable in broker mode', async () => {
    // In mock mode `/api/dev` lets a caller pick the acting human and
    // `/api/dev/reset` wipes every human's drafts; both must 404 here.
    const devGet = await fetch(`${base}/api/dev`)
    expect(devGet.status).toBe(404)
    const devPut = await fetch(`${base}/api/dev`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ humanId: 'someone-else@corp.com' }),
    })
    expect(devPut.status).toBe(404)
    const devReset = await fetch(`${base}/api/dev/reset`, { method: 'POST' })
    expect(devReset.status).toBe(404)
    // And the session identity is untouched by the attempted selection.
    const session = (await (await fetch(`${base}/api/session`)).json()) as {
      human: { id: string }
    }
    expect(session.human.id).toBe(CONFORMANCE_SESSION.human.id)
  })
})
