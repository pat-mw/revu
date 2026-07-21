/**
 * Broker-mode serve wiring: the daemon binds loopback only, serves the SPA
 * `dist/` and `/api/*` on one port through the same handler direct mode uses, and
 * answers the real session at `GET /api/session`. These prove the boot+serve
 * plumbing that turns direct mode into broker mode — the loopback bind and the
 * one-port serve — without a real network dependency (the store/API are fakes and
 * the bind is to 127.0.0.1).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'bun'
import type { Session } from '@revu/shared'
import { DEFAULT_PREFERENCES } from '@revu/shared'
import type { DirectApi } from './direct/direct-api'
import { startLoopbackAlias, startServer } from './server'

/**
 * Run `startServer` while capturing the options the first `Bun.serve` call
 * receives, then restore the real `Bun.serve`. This proves the `hostname` bind is
 * plumbed through the call rather than left to Bun's default, without depending on
 * a typed accessor for the bound host.
 */
function captureServeOptions(run: () => Server): {
  server: Server
  opts: { hostname?: string } | undefined
} {
  const realServe = Bun.serve.bind(Bun)
  let captured: { hostname?: string } | undefined
  ;(Bun as { serve: typeof Bun.serve }).serve = ((options: Parameters<typeof Bun.serve>[0]) => {
    captured = options as { hostname?: string }
    return realServe(options as Parameters<typeof Bun.serve>[0])
  }) as typeof Bun.serve
  try {
    const server = run()
    return { server, opts: captured }
  } finally {
    ;(Bun as { serve: typeof Bun.serve }).serve = realServe
  }
}

const SESSION: Session = {
  human: { id: 'h@x.io', name: 'H', role: 'contractor', email: 'h@x.io' },
  brokerLogin: '',
  workspace: 'direct-o-r',
}

const STUB_INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>'

function makeStubDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revud-broker-serve-'))
  writeFileSync(join(dir, 'index.html'), STUB_INDEX_HTML, 'utf8')
  return dir
}

/** A minimal read/persist surface — enough to answer preferences and route. */
function stubApi(): DirectApi {
  return {
    // No broker write decorator behind this stub, so it honestly lacks the
    // broker write capability; these serve tests exercise reads only.
    brokerWritesEnabled: false,
    listPulls: () => {
      throw new Error('not used')
    },
    syncPull: async () => {
      throw new Error('not used')
    },
    getSnapshot: () => null,
    getBlob: () => {
      throw new Error('not used')
    },
    getDraft: () => null,
    saveDraft: (d) => d,
    discardDraft: () => {},
    reconcileDraft: () => {
      throw new Error('not used')
    },
    getFileViewed: () => ({}),
    setFileViewed: () => ({}),
    getPreferences: () => ({ ...DEFAULT_PREFERENCES }),
    setPreferences: () => ({ ...DEFAULT_PREFERENCES }),
    submitReview: async () => {
      throw new Error('not used')
    },
    replyToThread: async () => {
      throw new Error('not used')
    },
    resolveThread: async () => {
      throw new Error('not used')
    },
    addReaction: async () => {
      throw new Error('not used')
    },
  }
}

let server: Server | undefined
let distDir: string | undefined

afterEach(() => {
  if (server) {
    server.stop(true)
    server = undefined
  }
  if (distDir) {
    rmSync(distDir, { recursive: true, force: true })
    distDir = undefined
  }
})

describe('broker mode serve wiring', () => {
  test('threads hostname 127.0.0.1 into Bun.serve for broker mode', () => {
    distDir = makeStubDist()
    const captured = captureServeOptions(() =>
      startServer({
        port: 0,
        distDir: distDir as string,
        directSession: SESSION,
        directApi: stubApi(),
        mode: 'broker',
        hostname: '127.0.0.1',
      }),
    )
    server = captured.server
    expect(captured.opts?.hostname).toBe('127.0.0.1')
    expect(server.port).toBeGreaterThan(0)
  })

  test('serves the real session and the SPA on one loopback port', async () => {
    distDir = makeStubDist()
    server = startServer({
      port: 0,
      distDir,
      directSession: SESSION,
      directApi: stubApi(),
      mode: 'broker',
      hostname: '127.0.0.1',
    })
    const base = `http://127.0.0.1:${server.port}`

    // /api/session returns the real broker session (no viewerLogin under the bot).
    const sessionRes = await fetch(`${base}/api/session`)
    expect(sessionRes.status).toBe(200)
    const body = (await sessionRes.json()) as Session
    expect(body.human.id).toBe('h@x.io')
    expect(body.viewerLogin).toBeUndefined()

    // A non-API path falls back to the SPA index.html on the same port.
    const spaRes = await fetch(`${base}/some/client/route`)
    expect(spaRes.status).toBe(200)
    expect(await spaRes.text()).toContain('id="root"')
  })

  test('direct mode leaves the bind unchanged (no hostname threaded)', () => {
    // Direct mode passes no hostname, so `startServer` must not put one in the
    // Bun.serve opts — the default all-interfaces bind is preserved unchanged.
    distDir = makeStubDist()
    const captured = captureServeOptions(() =>
      startServer({
        port: 0,
        distDir: distDir as string,
        directSession: SESSION,
        directApi: stubApi(),
        mode: 'direct',
      }),
    )
    server = captured.server
    expect(captured.opts?.hostname).toBeUndefined()
    expect(server.port).toBeGreaterThan(0)
  })
})

describe('the IPv6 loopback alias', () => {
  let primary: Server | undefined
  let alias: Server | null | undefined
  let dist: string | undefined

  afterEach(() => {
    alias?.stop(true)
    primary?.stop(true)
    if (dist !== undefined) rmSync(dist, { recursive: true, force: true })
    alias = undefined
    primary = undefined
    dist = undefined
  })

  // Binding 127.0.0.1 alone leaves `localhost` broken wherever it resolves to
  // ::1 first, which is the common case inside a container — the port reads as
  // closed to anything that dials the name rather than the address.
  test('serves the same port over ::1 as well as 127.0.0.1', async () => {
    dist = makeStubDist()
    const opts = {
      port: 0,
      distDir: dist,
      directSession: SESSION,
      directApi: stubApi(),
      mode: 'broker' as const,
      hostname: '127.0.0.1',
    }
    primary = startServer(opts)
    alias = startLoopbackAlias({ ...opts, port: primary.port })
    if (alias === null) return // no IPv6 in this environment; nothing to assert

    const v4 = await fetch(`http://127.0.0.1:${primary.port}/api/session`)
    const v6 = await fetch(`http://[::1]:${primary.port}/api/session`)
    expect(v4.status).toBe(200)
    expect(v6.status).toBe(200)
    expect(((await v6.json()) as Session).human.id).toBe(SESSION.human.id)
  })

  test('asks for ::1, not the address the primary listener already holds', () => {
    dist = makeStubDist()
    const captured = captureServeOptions(
      () =>
        startLoopbackAlias({
          port: 0,
          distDir: dist as string,
          directSession: SESSION,
          directApi: stubApi(),
          mode: 'broker',
          hostname: '127.0.0.1',
        }) as Server,
    )
    alias = captured.server
    expect(captured.opts?.hostname).toBe('::1')
  })

  // A container with IPv6 disabled cannot bind ::1 at all. Serving on one
  // family is a great deal better than refusing to serve, so the failure is
  // absorbed rather than propagated to boot.
  test('returns null instead of throwing when the bind fails', () => {
    dist = makeStubDist()
    const realServe = Bun.serve.bind(Bun)
    ;(Bun as { serve: typeof Bun.serve }).serve = (() => {
      throw new Error('EAFNOSUPPORT')
    }) as typeof Bun.serve
    try {
      expect(
        startLoopbackAlias({
          port: 0,
          distDir: dist as string,
          directSession: SESSION,
          directApi: stubApi(),
          mode: 'broker',
          hostname: '127.0.0.1',
        }),
      ).toBeNull()
    } finally {
      ;(Bun as { serve: typeof Bun.serve }).serve = realServe
    }
  })
})
