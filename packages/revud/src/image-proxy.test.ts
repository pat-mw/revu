import { describe, expect, it } from 'bun:test'
import type { ImageProxyDeps, ResolvedAddress } from './image-proxy'
import { handleImageProxy, isForbiddenAddress } from './image-proxy'

/**
 * The image proxy's SSRF and containment posture, exercised entirely offline:
 * `fetch` and DNS resolution are injected fakes, so every case — including the
 * redirect-to-metadata-endpoint one — runs without a socket.
 */

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

/** A scripted fetch: answers each URL from `routes`, recording every call. */
function scriptedFetch(routes: Record<string, () => Response>): {
  fetch: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    const route = routes[url]
    if (!route) throw new Error(`scripted fetch has no route for ${url}`)
    return route()
  }) as typeof fetch
  return { fetch: impl, calls }
}

/** A scripted resolver: hostnames map to address lists; anything else fails. */
function scriptedLookup(hosts: Record<string, string[]>): ImageProxyDeps['lookup'] {
  return async (hostname: string): Promise<ResolvedAddress[]> => {
    const addresses = hosts[hostname]
    if (!addresses) throw new Error(`no DNS for ${hostname}`)
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
}

function proxyRequest(target: string): Request {
  return new Request(`http://127.0.0.1:4200/image-proxy?url=${encodeURIComponent(target)}`)
}

function png(bytes = 32): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })
}

const PUBLIC_HOST = { 'cdn.example': ['93.184.216.34'] }

describe('isForbiddenAddress', () => {
  const forbidden = [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.192',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'fec0::1',
    'not-an-ip',
  ]
  const allowed = ['8.8.8.8', '93.184.216.34', '172.32.0.1', '198.51.101.1', '2606:4700::1111', '2a00:1450::8a']

  for (const ip of forbidden) {
    it(`refuses ${ip}`, () => {
      expect(isForbiddenAddress(ip)).toBe(true)
    })
  }
  for (const ip of allowed) {
    it(`allows ${ip}`, () => {
      expect(isForbiddenAddress(ip)).toBe(false)
    })
  }
})

describe('request validation', () => {
  const deps: ImageProxyDeps = { fetch: scriptedFetch({}).fetch, lookup: scriptedLookup({}) }

  it('ignores other paths', async () => {
    expect(await handleImageProxy(new Request('http://127.0.0.1:4200/api/pulls'), deps)).toBeNull()
  })

  it('rejects non-GET', async () => {
    const res = await handleImageProxy(
      new Request('http://127.0.0.1:4200/image-proxy?url=https%3A%2F%2Fcdn.example%2Fa.png', {
        method: 'POST',
      }),
      deps,
    )
    expect(res?.status).toBe(405)
  })

  it('rejects a missing url parameter', async () => {
    const res = await handleImageProxy(new Request('http://127.0.0.1:4200/image-proxy'), deps)
    expect(res?.status).toBe(400)
  })

  it('rejects relative and non-http(s) targets', async () => {
    for (const target of ['/etc/passwd', 'ftp://cdn.example/a.png', 'file:///etc/passwd', 'data:image/png;base64,AA']) {
      const res = await handleImageProxy(proxyRequest(target), deps)
      expect(res?.status).toBe(400)
    }
  })

  it('rejects credentialed URLs', async () => {
    const res = await handleImageProxy(proxyRequest('https://user:pw@cdn.example/a.png'), deps)
    expect(res?.status).toBe(400)
  })
})

describe('SSRF containment', () => {
  it('refuses literal loopback, private, link-local, and CGNAT targets without fetching', async () => {
    const { fetch, calls } = scriptedFetch({})
    const deps: ImageProxyDeps = { fetch, lookup: scriptedLookup({}) }
    const targets = [
      'http://127.0.0.1/x.png',
      'http://127.1/x.png',
      'http://[::1]/x.png',
      'http://10.0.0.8/x.png',
      'http://192.168.1.5/x.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.3.4/x.png',
      'http://localhost:9464/x.png',
      'http://internal.localhost/x.png',
      'http://printer.local/x.png',
    ]
    for (const target of targets) {
      const res = await handleImageProxy(proxyRequest(target), deps)
      expect(res?.status).toBe(403)
    }
    expect(calls.length).toBe(0)
  })

  it('refuses a hostname that resolves to a private address', async () => {
    const { fetch, calls } = scriptedFetch({})
    const deps: ImageProxyDeps = {
      fetch,
      lookup: scriptedLookup({ 'internal.example': ['10.20.30.40'] }),
    }
    const res = await handleImageProxy(proxyRequest('https://internal.example/a.png'), deps)
    expect(res?.status).toBe(403)
    expect(calls.length).toBe(0)
  })

  it('refuses when ANY resolved address is private (dual answers)', async () => {
    const { fetch, calls } = scriptedFetch({})
    const deps: ImageProxyDeps = {
      fetch,
      lookup: scriptedLookup({ 'dual.example': ['93.184.216.34', '192.168.0.10'] }),
    }
    const res = await handleImageProxy(proxyRequest('https://dual.example/a.png'), deps)
    expect(res?.status).toBe(403)
    expect(calls.length).toBe(0)
  })

  it('refuses a redirect hop to a private literal — the metadata pivot', async () => {
    const { fetch, calls } = scriptedFetch({
      'https://cdn.example/a.png': () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
    })
    const deps: ImageProxyDeps = { fetch, lookup: scriptedLookup(PUBLIC_HOST) }
    const res = await handleImageProxy(proxyRequest('https://cdn.example/a.png'), deps)
    expect(res?.status).toBe(403)
    expect(calls.length).toBe(1)
  })

  it('refuses a redirect hop to a hostname resolving privately', async () => {
    const { fetch, calls } = scriptedFetch({
      'https://cdn.example/a.png': () =>
        new Response(null, { status: 302, headers: { location: 'https://internal.example/b.png' } }),
    })
    const deps: ImageProxyDeps = {
      fetch,
      lookup: scriptedLookup({ ...PUBLIC_HOST, 'internal.example': ['172.16.9.9'] }),
    }
    const res = await handleImageProxy(proxyRequest('https://cdn.example/a.png'), deps)
    expect(res?.status).toBe(403)
    expect(calls.length).toBe(1)
  })

  it('refuses a redirect to a non-http scheme', async () => {
    const { fetch } = scriptedFetch({
      'https://cdn.example/a.png': () =>
        new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }),
    })
    const deps: ImageProxyDeps = { fetch, lookup: scriptedLookup(PUBLIC_HOST) }
    const res = await handleImageProxy(proxyRequest('https://cdn.example/a.png'), deps)
    expect(res?.status).toBe(400)
  })

  it('caps the redirect chain', async () => {
    const { fetch, calls } = scriptedFetch({
      'https://cdn.example/a.png': () =>
        new Response(null, { status: 302, headers: { location: 'https://cdn.example/a.png' } }),
    })
    const deps: ImageProxyDeps = { fetch, lookup: scriptedLookup(PUBLIC_HOST) }
    const res = await handleImageProxy(proxyRequest('https://cdn.example/a.png'), deps)
    expect(res?.status).toBe(502)
    expect(calls.length).toBe(4)
  })
})

describe('response handling', () => {
  it('streams an allowed image back with containment headers', async () => {
    const { fetch, calls } = scriptedFetch({ 'https://cdn.example/a.png': () => png(64) })
    const deps: ImageProxyDeps = { fetch, lookup: scriptedLookup(PUBLIC_HOST) }
    const res = await handleImageProxy(proxyRequest('https://cdn.example/a.png'), deps)
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('image/png')
    expect(res?.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res?.headers.get('content-security-policy')).toContain('sandbox')
    expect((await res!.arrayBuffer()).byteLength).toBe(64)

    // The upstream request must carry no ambient authority or provenance.
    const sent = new Headers(calls[0]!.init?.headers)
    expect(sent.get('authorization')).toBeNull()
    expect(sent.get('cookie')).toBeNull()
    expect(sent.get('referer')).toBeNull()
    expect(calls[0]!.init?.redirect).toBe('manual')
  })

  it('follows an allowed public redirect and serves the final image', async () => {
    const { fetch, calls } = scriptedFetch({
      'https://cdn.example/a.png': () =>
        new Response(null, { status: 301, headers: { location: '/moved/a.png' } }),
      'https://cdn.example/moved/a.png': () => png(16),
    })
    const deps: ImageProxyDeps = { fetch, lookup: scriptedLookup(PUBLIC_HOST) }
    const res = await handleImageProxy(proxyRequest('https://cdn.example/a.png'), deps)
    expect(res?.status).toBe(200)
    expect(calls.length).toBe(2)
  })

  it('serves SVG only with the neutering response policy', async () => {
    const { fetch } = scriptedFetch({
      'https://cdn.example/badge.svg': () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
          status: 200,
          headers: { 'content-type': 'image/svg+xml; charset=utf-8' },
        }),
    })
    const deps: ImageProxyDeps = { fetch, lookup: scriptedLookup(PUBLIC_HOST) }
    const res = await handleImageProxy(proxyRequest('https://cdn.example/badge.svg'), deps)
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('image/svg+xml')
    const csp = res?.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('sandbox')
  })

  it('refuses non-image content types', async () => {
    const { fetch } = scriptedFetch({
      'https://cdn.example/a.png': () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    })
    const deps: ImageProxyDeps = { fetch, lookup: scriptedLookup(PUBLIC_HOST) }
    const res = await handleImageProxy(proxyRequest('https://cdn.example/a.png'), deps)
    expect(res?.status).toBe(415)
  })

  it('refuses a declared oversize body without reading it', async () => {
    const { fetch } = scriptedFetch({
      'https://cdn.example/a.png': () =>
        new Response(new Uint8Array(8), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(64 * 1024 * 1024) },
        }),
    })
    const deps: ImageProxyDeps = { fetch, lookup: scriptedLookup(PUBLIC_HOST) }
    const res = await handleImageProxy(proxyRequest('https://cdn.example/a.png'), deps)
    expect(res?.status).toBe(413)
  })

  it('aborts an undeclared oversize body at the cap', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8) {
          controller.close()
          return
        }
        sent += 1
        controller.enqueue(chunk)
      },
    })
    const { fetch } = scriptedFetch({
      'https://cdn.example/a.png': () =>
        new Response(body, { status: 200, headers: { 'content-type': 'image/png' } }),
    })
    const deps: ImageProxyDeps = { fetch, lookup: scriptedLookup(PUBLIC_HOST) }
    const res = await handleImageProxy(proxyRequest('https://cdn.example/a.png'), deps)
    expect(res?.status).toBe(413)
  })

  it('maps an upstream error status to a bad-gateway refusal', async () => {
    const { fetch } = scriptedFetch({
      'https://cdn.example/a.png': () => new Response('nope', { status: 500 }),
    })
    const deps: ImageProxyDeps = { fetch, lookup: scriptedLookup(PUBLIC_HOST) }
    const res = await handleImageProxy(proxyRequest('https://cdn.example/a.png'), deps)
    expect(res?.status).toBe(502)
  })
})
