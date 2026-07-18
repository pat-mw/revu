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
import { startServer } from './server'

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
