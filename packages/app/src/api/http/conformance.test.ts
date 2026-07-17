/**
 * Conformance runner: drives the shared `RevuApi` conformance suite against
 * revud-mock over REAL HTTP. The assertions live in `@revu/shared/conformance`
 * and are run identically against the in-process mock by a sibling runner, so
 * both transports are held to the same contract from one source of truth.
 *
 * The daemon is spawned on an ephemeral port with a per-run temp data dir and a
 * STUB dist — only a minimal `index.html` is needed to start, so the suite is
 * hermetic on a fresh checkout where the real frontend has not been built yet
 * (the gate runs `bun test` before the app build). revud serves `/api/*` from
 * its reused mock regardless of dist, and conformance only touches `/api/*`.
 * The fresh temp data dir isolates this run from every other `bun test` file.
 *
 * The restart hook — which the durability scenario drives — stops the daemon
 * and starts a new one against the SAME data dir, so a saved draft must reload
 * from the on-disk broker document. The daemon rebinds to a new port, so the
 * hook hands back a fresh `createHttpApi` pointed at the new base.
 *
 * The spawn harness mirrors `packages/revud/src/revud.test.ts`.
 */
import { afterAll, beforeAll, describe } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import { runConformanceSuite } from '@revu/shared/conformance'
import { createHttpApi } from './adapter'

const REVUD_ENTRY = join(import.meta.dir, '..', '..', '..', '..', 'revud', 'src', 'index.ts')

const STUB_INDEX_HTML =
  '<!doctype html><html><head><title>revud stub</title></head>' +
  '<body><div id="root"></div></body></html>'

/** A temp stub dist with just enough for the daemon to start. */
function makeStubDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revud-conf-dist-'))
  writeFileSync(join(dir, 'index.html'), STUB_INDEX_HTML, 'utf8')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  return dir
}

interface Daemon {
  proc: Subprocess
  base: string
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
      // Not listening yet — retry.
    }
    await Bun.sleep(50)
  }
  throw new Error(`revud did not become ready at ${base}`)
}

/** Start a revud child on an ephemeral port against the given data + dist dirs. */
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
  // Drop simulated latency so the conformance flows run fast and deterministically.
  const res = await fetch(`${base}/api/dev`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ latency: 'zero' }),
  })
  await res.body?.cancel()
  return { proc, base }
}

async function stopDaemon(d: Daemon): Promise<void> {
  d.proc.kill('SIGTERM')
  await d.proc.exited
}

let daemon: Daemon
let dataDir: string
let distDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'revud-conf-data-'))
  distDir = makeStubDist()
  daemon = await startDaemon(dataDir, distDir)
})

afterAll(async () => {
  if (daemon) await stopDaemon(daemon)
  // Best-effort cleanup so temp dirs never accumulate across runs.
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  if (distDir) rmSync(distDir, { recursive: true, force: true })
})

describe('revud-mock over HTTP conformance', () => {
  runConformanceSuite({
    label: 'revud-mock over HTTP',
    makeApi: () => createHttpApi(daemon.base),
    scenarios: {
      baseline: 101,
      seededDraft: 312,
      baseAdvanced: 410,
      mutableDrift: 415,
      partialSync: 401,
      reconcile: 389,
    },
    restart: async () => {
      // Restart against the SAME data dir so the on-disk broker document must
      // rehydrate the saved draft. The new process rebinds a fresh port, so the
      // returned adapter points at the new base.
      await stopDaemon(daemon)
      daemon = await startDaemon(dataDir, distDir)
      return createHttpApi(daemon.base)
    },
  })
})
