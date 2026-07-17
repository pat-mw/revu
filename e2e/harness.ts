/**
 * End-to-end harness: boots the real built app behind the revud daemon and
 * drives it with a headless system Chrome.
 *
 * The daemon serves the actual `packages/app/dist` (built in HTTP mode, so the
 * app makes same-origin `/api/*` calls) on an ephemeral port with a fresh temp
 * data directory, so every run starts from pristine fixtures and never touches
 * a real data dir. Simulated latency is zeroed after ready so flows are fast
 * and deterministic. `stop()` tears everything down: it closes the browser,
 * SIGTERMs the daemon, and removes the temp data dir.
 *
 * The browser uses the installed system Chrome via playwright-core
 * (`channel: 'chrome'`) — no browser downloads. `E2E_CHROME_PATH` overrides the
 * resolved binary as an escape hatch for runners where the channel lookup fails.
 */
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Subprocess } from 'bun'

/** Absolute path to the revud entrypoint and the real built app dist. */
const REVUD_ENTRY = resolve(import.meta.dir, '../packages/revud/src/index.ts')
const DIST_DIR = resolve(import.meta.dir, '../packages/app/dist')

/** Where screenshots-on-failure land. */
export const ARTIFACTS_DIR = resolve(import.meta.dir, 'artifacts')

export interface Harness {
  page: Page
  context: BrowserContext
  browser: Browser
  /** Base URL of the running daemon, e.g. `http://localhost:53219`. */
  base: string
  /** Close the browser, kill the daemon, and remove the temp data dir. */
  stop(): Promise<void>
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

/**
 * Start a revud child process serving the real built dist on an ephemeral port
 * with a fresh temp data directory and zero simulated latency.
 */
async function startDaemon(): Promise<Daemon> {
  const dataDir = mkdtempSync(join(tmpdir(), 'revu-e2e-'))
  const proc = Bun.spawn(['bun', 'run', REVUD_ENTRY], {
    env: {
      ...process.env,
      REVU_PORT: '0',
      REVU_DATA_DIR: dataDir,
      REVU_DIST_DIR: DIST_DIR,
      REVU_MODE: 'mock',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Everything past the spawn can throw (a wedged daemon, a failed readiness
  // probe); on any failure kill the child and remove the temp dir so a failed
  // start never leaks a live process holding a port or an orphaned data dir.
  try {
    // The startup line reports the bound port: "... on http://localhost:PORT ...".
    // A timer kills the child after a bound so a daemon that opens stdout but
    // never logs cannot block the read forever — the kill closes stdout, which
    // ends the pending read (so releasing the lock afterward is always safe).
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let port = 0
    const timer = setTimeout(() => proc.kill(), 10_000)
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (value) buffer += decoder.decode(value)
        const m = /http:\/\/localhost:(\d+)/.exec(buffer)
        if (m) {
          port = Number(m[1])
          break
        }
        if (done) break
      }
    } finally {
      clearTimeout(timer)
      reader.releaseLock()
    }
    if (port === 0) {
      // A fatal startup error is written to the daemon's stderr — drain and
      // include it (bounded), so the one failure that most needs debugging in
      // CI does not arrive blind.
      const stderr = await Promise.race([
        new Response(proc.stderr).text(),
        Bun.sleep(2_000).then(() => ''),
      ])
      proc.kill()
      throw new Error(`revud did not report a port.\nstdout:\n${buffer}\nstderr:\n${stderr}`)
    }

    const base = `http://localhost:${port}`
    await waitReady(base)
    // Drop simulated latency so the flow runs fast and deterministically.
    const res = await fetch(`${base}/api/dev`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ latency: 'zero' }),
    })
    await res.body?.cancel()
    return { proc, base, dataDir }
  } catch (error) {
    proc.kill()
    rmSync(dataDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * Boot the daemon against the real dist, then launch a headless system Chrome
 * and open a page. The returned `stop()` cleans up everything.
 */
export async function startHarness(): Promise<Harness> {
  const daemon = await startDaemon()

  const killDaemon = async (): Promise<void> => {
    daemon.proc.kill('SIGTERM')
    await daemon.proc.exited
    rmSync(daemon.dataDir, { recursive: true, force: true })
  }

  // The daemon is already up; from here any failure must still tear it down and
  // clean the temp dir before rethrowing, or a failed launch leaks both.
  let browser: Browser
  const chromePath = process.env.E2E_CHROME_PATH
  try {
    browser = await chromium.launch(
      chromePath !== undefined && chromePath.length > 0
        ? { executablePath: chromePath, headless: true }
        : { channel: 'chrome', headless: true },
    )
  } catch (error) {
    await killDaemon()
    throw error
  }

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()

    const stop = async (): Promise<void> => {
      try {
        await browser.close()
      } finally {
        await killDaemon()
      }
    }

    return { page, context, browser, base: daemon.base, stop }
  } catch (error) {
    await browser.close().catch(() => {})
    await killDaemon()
    throw error
  }
}

/**
 * Save a PNG of the current page state under `e2e/artifacts/`. Used to capture
 * evidence when a step fails; best-effort, so a screenshot error never masks
 * the original failure.
 */
export async function screenshot(page: Page, name: string): Promise<void> {
  try {
    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS_DIR, name) })
  } catch (error) {
    console.error(`  (could not write screenshot ${name})`, error)
  }
}
