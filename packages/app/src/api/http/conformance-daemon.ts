import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'

/**
 * Spawning a real `revud` child and waiting until it answers, shared by every
 * suite that drives the HTTP adapter against a live daemon. Keeping one copy
 * means the two suites cannot drift on the parts that are easy to get subtly
 * wrong — where the entry point is, how the ephemeral port is learned, and the
 * latency reset that has to happen before the first assertion. Test-support
 * code: imported only by `*.test.ts`, carries no assertions of its own, and
 * nothing here runs in a live daemon.
 *
 * The daemon is started on an ephemeral port with a caller-supplied data dir
 * and a STUB dist — only a minimal `index.html` is needed to start, so a suite
 * built on this is hermetic on a fresh checkout where the real frontend has not
 * been built yet (the gate runs `bun test` before the app build). revud serves
 * `/api/*` from its reused mock regardless of dist, and conformance only
 * touches `/api/*`. A per-run temp data dir is what isolates one suite's daemon
 * from every other `bun test` file's.
 *
 * `startDaemon` is deliberately callable twice against the SAME data dir: the
 * second call is a restart, and everything the first process wrote must reload
 * from the on-disk broker document. Each start rebinds a fresh port, so the
 * caller must rebuild its adapter from the returned base rather than reuse the
 * old one.
 */

/** The daemon's entry point, resolved from this module's own location. */
const REVUD_ENTRY = join(import.meta.dir, '..', '..', '..', '..', 'revud', 'src', 'index.ts')

const STUB_INDEX_HTML =
  '<!doctype html><html><head><title>revud stub</title></head>' +
  '<body><div id="root"></div></body></html>'

/** A temp stub dist with just enough for the daemon to start. */
export function makeStubDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revud-conf-dist-'))
  writeFileSync(join(dir, 'index.html'), STUB_INDEX_HTML, 'utf8')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  return dir
}

/** A running daemon: the child handle, and the base URL it bound to. */
export interface Daemon {
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
export async function startDaemon(dataDir: string, distDir: string): Promise<Daemon> {
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

/** Stop a daemon and wait for the child to actually exit, so no port leaks. */
export async function stopDaemon(d: Daemon): Promise<void> {
  d.proc.kill('SIGTERM')
  await d.proc.exited
}
