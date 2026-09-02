/**
 * The network guard, asserted at the level a driver cannot: which URLs it calls
 * outbound, what it writes when one is attempted, and the property that makes
 * it safe to import from anywhere — it wraps nothing unless a netlog path names
 * a file for it to write to.
 *
 * That last property is why the import below is DYNAMIC. A static import is
 * hoisted above every statement in the file, so there would be no moment
 * "before the module loaded" in which to capture the original `fetch` and
 * nothing to compare the reference against afterwards. Capturing first and
 * importing second turns "importing this module is inert" into an assertion
 * rather than a promise.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The `fetch` this process had before the module under test was loaded. */
const fetchBeforeImport = globalThis.fetch

// The guard installs itself when this variable names a file. A suite that
// inherited it from the shell that started it would be asserting the opposite
// of what it claims — and would be writing into someone else's log — so it is
// cleared rather than assumed absent.
delete process.env.REVU_E2E_NETLOG

const { install, isOutboundUrl } = await import('./no-github-guard')

/** The `fetch` this process has now. Read at import time so a later test that
 *  installs the guard on purpose cannot disturb the comparison. */
const fetchAfterImport = globalThis.fetch

/** URLs that reach nothing beyond this machine's loopback interface. */
const LOOPBACK: readonly string[] = [
  'http://127.0.0.1:5173/api/x',
  'http://localhost:53219/',
  'http://[::1]:9/',
  // Every address in 127.0.0.0/8 is loopback, not just the .1 everyone types.
  'http://127.0.0.2:80/',
]

/** URLs that leave the machine. The GitHub tiers are named individually
 *  because the daemon addresses three of them and a guard that knew only the
 *  api host would wave the other two through. */
const OUTBOUND: readonly string[] = [
  'https://api.github.com/rate_limit',
  'https://github.com/o/r.git',
  'https://uploads.github.com/x',
  'http://10.0.0.1/',
]

/** Strings that are not absolute URLs at all. */
const UNPARSEABLE: readonly string[] = ['not a url', '/api/relative']

describe('isOutboundUrl', () => {
  test('loopback destinations are not outbound', () => {
    for (const url of LOOPBACK) {
      expect(`${url} → ${isOutboundUrl(url)}`).toBe(`${url} → false`)
    }
  })

  test('everything past the loopback interface is outbound', () => {
    for (const url of OUTBOUND) {
      expect(`${url} → ${isOutboundUrl(url)}`).toBe(`${url} → true`)
    }
  })

  test('a string that is not an absolute URL is outbound', () => {
    // The conservative answer, and the only safe one: a daemon has no base URL
    // for a relative fetch, so a caller that hands one over is doing something
    // this guard did not anticipate. Recording a surprise costs a line in a log;
    // ignoring one costs the whole claim the log exists to make.
    for (const url of UNPARSEABLE) {
      expect(`${url} → ${isOutboundUrl(url)}`).toBe(`${url} → true`)
    }
  })
})

describe('install', () => {
  test('importing the module wraps nothing when no netlog is named', () => {
    expect(fetchAfterImport === fetchBeforeImport).toBe(true)
  })

  test('records the installation, refuses outbound calls, passes loopback through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'revu-guard-test-'))
    const netlog = join(dir, 'outbound.jsonl')
    const before = globalThis.fetch
    // The wrapper calls through to whatever `fetch` was when it installed, so a
    // stub put here beforehand is how "passed through" becomes observable
    // without a listening socket.
    const passedThrough: string[] = []
    globalThis.fetch = ((input: unknown): Promise<Response> => {
      // The wrapper forwards its argument unchanged, so the stub names it the
      // same way `fetch` itself would rather than stringifying an object.
      passedThrough.push(input instanceof Request ? input.url : String(input))
      return Promise.resolve(new Response('ok'))
    }) as unknown as typeof fetch

    try {
      install(netlog)

      // The first line is the proof the guard was in the process at all. A
      // reader of the log that found only an empty file could not tell a clean
      // run from a run where the preload never loaded.
      expect(readFileSync(netlog, 'utf8')).toBe('{"installed":true}\n')

      await globalThis.fetch('http://127.0.0.1:1/x')
      expect(passedThrough).toEqual(['http://127.0.0.1:1/x'])

      let refusal = ''
      try {
        await globalThis.fetch('https://api.github.com/rate_limit')
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error)
      }
      expect(refusal).toContain('https://api.github.com/rate_limit')
      // Refused means refused: the original was never reached.
      expect(passedThrough).toEqual(['http://127.0.0.1:1/x'])

      expect(readFileSync(netlog, 'utf8')).toBe(
        '{"installed":true}\n' +
          '{"method":"GET","url":"https://api.github.com/rate_limit"}\n',
      )

      // A `Request` and a `URL` are as ordinary an argument to `fetch` as a
      // string, and a guard that only understood strings would report the other
      // two as unparseable — outbound, but nameless in the log.
      await globalThis.fetch(new Request('http://localhost:1/y', { method: 'POST' }))
      expect(passedThrough).toEqual(['http://127.0.0.1:1/x', 'http://localhost:1/y'])

      let urlRefusal = ''
      try {
        await globalThis.fetch(new URL('https://uploads.github.com/x'))
      } catch (error) {
        urlRefusal = error instanceof Error ? error.message : String(error)
      }
      expect(urlRefusal).toContain('https://uploads.github.com/x')
      expect(readFileSync(netlog, 'utf8')).toContain(
        '{"method":"GET","url":"https://uploads.github.com/x"}\n',
      )
    } finally {
      globalThis.fetch = before
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
