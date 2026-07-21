import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * The image proxy: `GET /image-proxy?url=<absolute http(s) URL>` fetches the
 * remote image in the daemon's process and streams the bytes back, so the page
 * itself never dials a third-party host. That keeps `img-src 'self'`
 * enforceable, gives content-type and size limits one chokepoint, and — in
 * broker mode, where the daemon runs in the workspace while the browser is on
 * the reviewer's machine — moves the fetch (and the reviewer's IP) off the
 * reviewer's machine. It is NOT anonymity: the workspace's egress address
 * still reaches the remote host, and when daemon and browser share a machine
 * the privacy axis buys nothing.
 *
 * The proxy is itself an attack surface (a hostile comment picks the URL), so:
 *
 * - Targets must be absolute `http(s)`. Loopback, private, link-local, CGNAT,
 *   unique-local, and other non-global ranges are refused — and re-checked on
 *   EVERY redirect hop, because an allowed host can 302 to an internal
 *   address. Hostnames are resolved first and every resolved address must be
 *   global. Residual gap, stated plainly: the pre-flight resolution and the
 *   fetch's own resolution are separate DNS queries, so a rebinding server
 *   that answers them differently can slip one request through; closing it
 *   needs a socket pinned to the checked address, which this runtime's fetch
 *   does not expose.
 * - Redirect count, response size, and total wall time are capped.
 * - Only image content types are accepted, the response carries
 *   `X-Content-Type-Options: nosniff`, and every proxied response carries a
 *   `Content-Security-Policy` with `sandbox` so a response opened as a
 *   top-level document (an SVG most notably — scriptable when navigated to
 *   directly on this origin) runs nothing and holds no origin.
 * - The upstream request carries no cookies, no `Authorization`, and no
 *   `Referer` — only an `Accept` and a self-identifying `User-Agent`.
 * - This module never sees the GitHub token or the credential file: it imports
 *   nothing from the credential, session, or GitHub-client code and receives
 *   only the `Request`.
 *
 * Proxy URLs are deliberately NOT signed. An HMAC would only gate WHO may use
 * the proxy — and everyone who can reach this port at all can already drive
 * the unauthenticated `/api/*` write surface next to it, which is strictly
 * more authority than "fetch a public image". Signing would add a key to
 * manage and imply a trust boundary the port does not have; the real
 * boundaries are the loopback bind and the target checks above.
 */

export const IMAGE_PROXY_PATH = '/image-proxy'

const MAX_REDIRECTS = 3
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const TOTAL_DEADLINE_MS = 10_000

/**
 * Content types the proxy will serve. SVG is included — badge services emit
 * it — because the response-level CSP (`sandbox`, no script sources) keeps a
 * directly-navigated SVG inert; everything else is raster.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  'image/apng',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
])

/** One resolved address, in the shape `dns.lookup(host, { all: true })` yields. */
export interface ResolvedAddress {
  address: string
  family: number
}

/** Injection points so every network-touching path is testable offline. */
export interface ImageProxyDeps {
  fetch: typeof fetch
  lookup: (hostname: string) => Promise<ResolvedAddress[]>
}

const defaultDeps: ImageProxyDeps = {
  fetch: (input, init) => fetch(input, init),
  lookup: async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
}

/** True for an IPv4 address outside the globally-routable public space. */
function isForbiddenIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true
  }
  const [a, b, c] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 169 && b === 254) return true // link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return true // private 172.16/12
  if (a === 192 && b === 168) return true // private 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF protocol assignments + TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

/**
 * True for any address the proxy must never connect to: loopback, private,
 * link-local, CGNAT, unique-local, site-local, or otherwise non-global. IPv6
 * is allowed ONLY in the global-unicast `2000::/3` block, which conservatively
 * rejects mapped/translated forms (`::ffff:…`, `64:ff9b::…`) that smuggle an
 * IPv4 address past a v4-shaped check.
 */
export function isForbiddenAddress(address: string): boolean {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  const family = isIP(bare)
  if (family === 4) return isForbiddenIpv4(bare)
  if (family === 6) {
    // Zone index (fe80::1%eth0) never names a global address.
    if (bare.includes('%')) return true
    const first = bare.split(':', 1)[0]!.toLowerCase()
    const lead = Number.parseInt(first === '' ? '0' : first, 16)
    return Number.isNaN(lead) || lead < 0x2000 || lead > 0x3fff
  }
  // Not an IP literal at all — callers resolve hostnames before checking.
  return true
}

class ProxyRefusal extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Parse and vet the requested target: absolute, http(s), no credentials. */
function parseTarget(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ProxyRefusal(400, 'invalid_url', 'url must be an absolute URL')
  }
  return vetTarget(url)
}

function vetTarget(url: URL): URL {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxyRefusal(400, 'invalid_url', 'only http and https targets are proxied')
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProxyRefusal(400, 'invalid_url', 'credentialed URLs are not proxied')
  }
  return url
}

/**
 * Refuse a target whose host is, or resolves to, a non-global address. The
 * WHATWG URL parser has already normalized IPv4 spellings (decimal, octal,
 * hex) to dotted-quad, so a literal is checked directly; a hostname must
 * resolve, and every resolved address must be global.
 */
async function assertPublicHost(url: URL, deps: ImageProxyDeps): Promise<void> {
  const host = url.hostname
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (isIP(bare) !== 0) {
    if (isForbiddenAddress(bare)) {
      throw new ProxyRefusal(403, 'forbidden_target', 'target address is not publicly routable')
    }
    return
  }
  const lower = host.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) {
    throw new ProxyRefusal(403, 'forbidden_target', 'target host is local')
  }
  let resolved: ResolvedAddress[]
  try {
    resolved = await deps.lookup(host)
  } catch {
    throw new ProxyRefusal(502, 'resolve_failed', 'target host did not resolve')
  }
  if (resolved.length === 0) {
    throw new ProxyRefusal(502, 'resolve_failed', 'target host did not resolve')
  }
  if (resolved.some((r) => isForbiddenAddress(r.address))) {
    throw new ProxyRefusal(403, 'forbidden_target', 'target resolves to a non-public address')
  }
}

/** Headers every proxied response carries, success or refusal. */
function baseHeaders(): Headers {
  return new Headers({
    'x-content-type-options': 'nosniff',
    // `sandbox` strips scripting and origin from a directly-navigated
    // response document; the source list backstops it.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cache-control': 'private, max-age=3600',
  })
}

function refusalResponse(refusal: ProxyRefusal): Response {
  const headers = baseHeaders()
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify({ code: refusal.code, message: refusal.message }), {
    status: refusal.status,
    headers,
  })
}

/**
 * Read the upstream body fully, refusing past the size cap. Buffering (rather
 * than streaming through) is deliberate: the cap must abort a lying or
 * unbounded upstream mid-transfer, and a buffered read can refuse cleanly with
 * a 413 instead of snapping a stream the browser already started painting.
 */
async function readCapped(res: Response): Promise<Uint8Array<ArrayBuffer>> {
  const declared = res.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new ProxyRefusal(413, 'too_large', 'image exceeds the proxy size limit')
  }
  if (res.body === null) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new ProxyRefusal(413, 'too_large', 'image exceeds the proxy size limit')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function proxyImage(target: URL, deps: ImageProxyDeps): Promise<Response> {
  const signal = AbortSignal.timeout(TOTAL_DEADLINE_MS)
  let current = target
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(current, deps)
    let upstream: Response
    try {
      upstream = await deps.fetch(current.href, {
        redirect: 'manual',
        signal,
        headers: {
          accept: 'image/*',
          'user-agent': 'revud-image-proxy',
        },
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new ProxyRefusal(504, 'upstream_timeout', 'image fetch timed out')
      }
      throw new ProxyRefusal(502, 'upstream_error', 'image fetch failed')
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location')
      await upstream.body?.cancel()
      if (location === null) {
        throw new ProxyRefusal(502, 'upstream_error', 'redirect without a location')
      }
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new ProxyRefusal(502, 'upstream_error', 'redirect to an unparsable location')
      }
      current = vetTarget(next)
      continue
    }

    if (!upstream.ok) {
      await upstream.body?.cancel()
      throw new ProxyRefusal(502, 'upstream_error', `upstream answered ${upstream.status}`)
    }

    const contentType = (upstream.headers.get('content-type') ?? '')
      .split(';', 1)[0]!
      .trim()
      .toLowerCase()
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      await upstream.body?.cancel()
      throw new ProxyRefusal(415, 'unsupported_type', 'upstream is not an allowed image type')
    }

    let body: Uint8Array<ArrayBuffer>
    try {
      body = await readCapped(upstream)
    } catch (err) {
      if (err instanceof ProxyRefusal) throw err
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new ProxyRefusal(504, 'upstream_timeout', 'image fetch timed out')
      }
      throw new ProxyRefusal(502, 'upstream_error', 'image body read failed')
    }

    const headers = baseHeaders()
    headers.set('content-type', contentType)
    headers.set('content-length', String(body.byteLength))
    return new Response(body, { status: 200, headers })
  }
  throw new ProxyRefusal(502, 'upstream_error', 'too many redirects')
}

/**
 * Handle an image-proxy request; `null` when the path is not the proxy's, so
 * callers fall through to their own routing.
 */
export async function handleImageProxy(
  req: Request,
  deps: ImageProxyDeps = defaultDeps,
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== IMAGE_PROXY_PATH) return null

  if (req.method !== 'GET') {
    return refusalResponse(new ProxyRefusal(405, 'method_not_allowed', 'proxy accepts GET only'))
  }
  const raw = url.searchParams.get('url')
  if (raw === null || raw === '') {
    return refusalResponse(new ProxyRefusal(400, 'invalid_url', 'missing url parameter'))
  }

  try {
    return await proxyImage(parseTarget(raw), deps)
  } catch (err) {
    if (err instanceof ProxyRefusal) return refusalResponse(err)
    return refusalResponse(new ProxyRefusal(502, 'upstream_error', 'image fetch failed'))
  }
}
