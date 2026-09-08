/**
 * A `bun --preload` module that makes "this process reached nothing outside the
 * machine" a recorded property of the process rather than an assumption about
 * its configuration.
 *
 * Loaded with `bun run --preload <this module> <entry>`, its top level runs
 * before the entry module is evaluated, so `globalThis.fetch` is already
 * wrapped by the time any application code could reach for it. The wrapper
 * appends one JSON line per outbound attempt to the file named by
 * `REVU_E2E_NETLOG` and rejects it without calling through; a loopback call is
 * passed to the original `fetch` untouched and is not recorded.
 *
 * The log opens with the single line `{"installed":true}`. Without it a reader
 * could not tell a clean run from a run in which the preload never loaded at
 * all — an empty file would look identical, and the whole claim rests on the
 * guard having actually been present.
 *
 * ## Installing is opt-in, and that is what makes the module importable
 *
 * The self-install at the bottom runs only when `REVU_E2E_NETLOG` names a file.
 * Any other process — a driver that wants the predicate, a test suite that
 * wants the wrapper's contract — imports this module and gets its `fetch` back
 * exactly as it was. A module that patched a global merely because it was
 * imported could not be tested without first being installed.
 *
 * ## What this does NOT cover
 *
 * It replaces `fetch` in ONE process and nothing else. A raw socket, a
 * WebSocket, a bare DNS lookup, and — most importantly — every request made by
 * a SUBPROCESS pass straight through: a child process gets its own globals and
 * never sees this patch. That exclusion is load-bearing rather than an
 * oversight, because the flows this guards run real `git` subprocesses and
 * patching what those can do would break the thing under test. It is why a
 * driver relying on this guard also has to assert that the repository it runs
 * against has no remotes at all: a `git fetch` would go around the wrapper
 * completely, and the only thing standing in its way is that there is nowhere
 * for it to go.
 *
 * So a clean log says: no code path evaluated in this process called `fetch`.
 * Every hosted call in the daemon is a `fetch` call today, which is what makes
 * the approximation worth its cost — and what would make it worth revisiting
 * the day one is not.
 */
import { appendFileSync } from 'node:fs'

/** Hostnames that name this machine's loopback interface and nothing else. */
function isLoopbackHost(hostname: string): boolean {
  // The WHATWG parser keeps the brackets on an IPv6 host, so both spellings are
  // accepted rather than one being normalized into the other here.
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  // The whole of 127.0.0.0/8 is loopback, not only the .1 everyone types. A
  // daemon bound to 127.0.0.2 is as local as one bound to 127.0.0.1, and a
  // guard that knew only the common spelling would report it as an escape.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/**
 * Whether a URL would leave this machine.
 *
 * A string that is not an absolute URL answers TRUE — deliberately, and it is
 * the only safe answer. A process with no base URL cannot resolve a relative
 * fetch, so a caller handing one over is doing something this guard did not
 * anticipate; recording a surprise costs a line in a log, while ignoring one
 * costs the entire claim the log exists to make. The same reasoning covers a
 * scheme with no host at all: unrecognized is not the same as harmless.
 */
export function isOutboundUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  return !isLoopbackHost(parsed.hostname)
}

/**
 * Name whatever `fetch` was handed. It accepts a string, a `URL` and a
 * `Request`, and a caller can hand it anything at all; the fallback
 * stringification is there because naming what actually arrived — even when it
 * is not a URL — is more useful than recording an unnamed request.
 */
function requestedUrl(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return String(input)
}

/** The method the call would have used, for the record it leaves behind. */
function requestedMethod(input: unknown, init: RequestInit | undefined): string {
  if (init?.method !== undefined) return init.method
  if (input instanceof Request) return input.method
  return 'GET'
}

/**
 * Wrap `globalThis.fetch` so every outbound attempt is recorded and refused,
 * and note in the log that the wrapper is in place.
 *
 * Exported rather than left inline so the wrapper's contract — the opening
 * line, the recorded shape, the pass-through — is assertable without a
 * subprocess and without a listening socket.
 */
export function install(netlogPath: string): void {
  appendFileSync(netlogPath, '{"installed":true}\n')
  const original = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: RequestInit): Promise<Response> => {
    const url = requestedUrl(input)
    if (!isOutboundUrl(url)) {
      return (original as (i: unknown, n?: RequestInit) => Promise<Response>)(input, init)
    }
    appendFileSync(
      netlogPath,
      `${JSON.stringify({ method: requestedMethod(input, init), url })}\n`,
    )
    // A rejection rather than a synchronous throw: `fetch` answers with a
    // promise, and a caller that only attached a `.catch` would otherwise be
    // torn down by an exception it had every reason to think it had handled —
    // turning a recorded escape into an unrelated crash somewhere upstream.
    // The log is what fails the run; this only makes sure the request is not
    // actually made.
    return Promise.reject(
      new Error(
        'this process runs under the no-outbound-network guard and must issue no ' +
          `outbound request, but fetch() was called for ${url}.`,
      ),
    )
  }) as unknown as typeof fetch
}

// Self-install only when a log has been named. See the header: an import must
// be inert, or the module cannot be tested without first being installed.
const netlogPath = process.env.REVU_E2E_NETLOG
if (netlogPath !== undefined && netlogPath.length > 0) install(netlogPath)
