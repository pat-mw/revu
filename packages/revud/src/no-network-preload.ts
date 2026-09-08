/**
 * A `bun --preload` module that turns any outbound HTTP request into an
 * immediate, named failure.
 *
 * Loading it with `bun --preload <this module> <entry>` runs it before the entry
 * module is evaluated, so `globalThis.fetch` is already replaced by the time any
 * application code could reach for it. The replacement throws, naming the URL it
 * was handed. `--preload` does not change how the entry is treated: the entry is
 * still the main module, so a daemon started this way boots normally.
 *
 * ## Why a preload rather than a fixture
 *
 * A daemon assembled without a GitHub repository is supposed to reach nothing at
 * all. Proving that by pointing it at a fixture that would fail if contacted
 * proves a property of the FIXTURE — that the endpoint was unreachable — and
 * leaves the process free to have tried. Installing the tripwire into the
 * process instead makes "no outbound request" a property of the process under
 * test, and turns an attempted request into a failure that names its
 * destination, which is the one detail worth having when a route starts
 * reaching somewhere it should not.
 *
 * ## What this does NOT cover, and why it is still worth having
 *
 * It replaces `fetch` and nothing else. A raw TCP socket, `Bun.connect`, a
 * WebSocket, a bare DNS lookup, and — importantly — any request made by a
 * SUBPROCESS this process spawns all pass straight through: a subprocess gets
 * its own globals and never sees this patch. That last exclusion is deliberate
 * and load-bearing rather than an oversight, because the flows this guards
 * depend on real `git` subprocesses; patching what they can do would break the
 * very thing under test.
 *
 * So this is the closest durable approximation to "the process made no outbound
 * request", not a proof of it. A green run says: no code path evaluated in this
 * process called `fetch`. Every hosted call in this package is a `fetch` call
 * today, which is what makes the approximation worth its cost — and what would
 * make it worth revisiting the day one is not.
 *
 * Nothing in the daemon imports this module. It is test support in the same
 * shape as the throwing GitHub client stubs, and it is installed from the
 * command line of the process under test rather than from its import graph.
 */

/**
 * Render whatever `fetch` was handed into a string for the failure message.
 *
 * `fetch` accepts a string, a `URL` and a `Request`, and a caller can hand it
 * anything at all. The fallback stringification is there because naming what
 * actually arrived — even when it is not a URL — is more useful than reporting
 * an unnamed request, and this runs only on the path that is already failing.
 */
function requestedUrl(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return String(input)
}

globalThis.fetch = ((input: unknown): never => {
  throw new Error(
    'revud: this process runs under the no-network tripwire and must issue no outbound ' +
      `request, but fetch() was called for ${requestedUrl(input)}.`,
  )
}) as unknown as typeof fetch
