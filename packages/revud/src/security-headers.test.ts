import { createHash } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import { applySecurityHeaders, buildContentSecurityPolicy } from './server'

/**
 * The header layer that backstops the markdown sanitizer: the CSP built from
 * the served `index.html`, and the base headers stamped on every response.
 */

describe('buildContentSecurityPolicy', () => {
  const inline = "console.log('theme')"
  const html = [
    '<!doctype html><html><head>',
    `<script>${inline}</script>`,
    '<script type="module" src="/assets/index.js"></script>',
    '</head><body></body></html>',
  ].join('\n')

  it('hashes each inline script so the no-flash snippet keeps running', () => {
    const expected = createHash('sha256').update(inline).digest('base64')
    expect(buildContentSecurityPolicy(html)).toContain(`script-src 'self' 'sha256-${expected}'`)
  })

  it('does not hash external scripts', () => {
    const csp = buildContentSecurityPolicy(html)
    const hashes = csp.match(/'sha256-[^']+'/g) ?? []
    expect(hashes.length).toBe(1)
  })

  it('locks the directions an injection would need', () => {
    const csp = buildContentSecurityPolicy(html)
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("img-src 'self'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('emits a hashless (fail-closed) policy for markup with no inline scripts', () => {
    const csp = buildContentSecurityPolicy('<!doctype html><html><body></body></html>')
    expect(csp).toContain("script-src 'self';")
    expect(csp).not.toContain('sha256-')
  })
})

describe('applySecurityHeaders', () => {
  it('stamps nosniff and a referrer policy on every response', () => {
    const res = applySecurityHeaders(new Response('{}'))
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  it('adds the CSP only when one is provided', () => {
    const res = applySecurityHeaders(new Response('<html></html>'), "default-src 'self'")
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'")
  })
})
