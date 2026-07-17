/**
 * Containment proof for `resolveStaticPath` and the handler's static-serving
 * path.
 *
 * The resolver maps a URL pathname to an absolute path INSIDE `distDir` or
 * returns null. The historical hazard is a prefix check: `abs.startsWith(distDir)`
 * accepts a SIBLING directory that merely shares the prefix — an `abs` of
 * `${distDir}-evil/x` string-prefixes `distDir` yet sits OUTSIDE it, so a crafted
 * path could escape. The current implementation compares via
 * `relative(distDir, abs)` and rejects anything that climbs out (a `..` prefix)
 * or resolves absolute, which the sibling-prefix case cannot fool.
 *
 * A rooted pathname (every real URL pathname begins with `/`) can never escape:
 * `normalize` collapses a leading `..` against the root before `join` runs, so
 * `/../secret` becomes `/secret` and stays inside `distDir` (then falls through to
 * the SPA index because no such file exists). The containment check earns its
 * keep on a NON-rooted input such as `../dist-evil/x`, whose resolved absolute
 * path leaves `distDir` — exactly the sibling-prefix escape a bare `startsWith`
 * would wrongly accept.
 *
 * The unit suite asserts the resolver directly; the handler suite drives
 * `createFetchHandler` with a real stub dist and a throwing-proxy mock (a
 * traversal path is never `/api/*`, so the mock must never be reached) and
 * confirms traversal encodings fall through to the SPA index rather than
 * escaping or leaking a sibling directory.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { RevuApi } from '@revu/shared'
import type { MockBundle } from './mock-bridge'
import { createFetchHandler, resolveStaticPath } from './server'

describe('resolveStaticPath: containment', () => {
  const distDir = '/srv/app/dist'

  test('a normal asset path resolves inside distDir', () => {
    const abs = resolveStaticPath(distDir, '/assets/app.js')
    expect(abs).toBe(join(distDir, 'assets/app.js'))
    expect(abs?.startsWith(distDir + '/')).toBe(true)
  })

  test('a nested asset path resolves inside distDir', () => {
    expect(resolveStaticPath(distDir, '/assets/img/logo.svg')).toBe(
      join(distDir, 'assets/img/logo.svg'),
    )
  })

  test('a rooted `/../secret` cannot escape and resolves inside distDir', () => {
    // Rooted: `normalize` collapses the leading `..` against root → `/secret`,
    // which joins back INSIDE distDir. This is contained (points at a file that
    // does not exist), so the resolver returns the in-dir path and the handler
    // serves the SPA index for it.
    expect(resolveStaticPath(distDir, '/../secret')).toBe(join(distDir, 'secret'))
  })

  test('a rooted `%2e%2e%2f` encoding decodes, collapses, and stays inside distDir', () => {
    // `%2e%2e%2f` decodes to `../`. Because the pathname is rooted, the collapsed
    // result is still inside distDir — the encoded form is no more dangerous than
    // the literal one and never escapes.
    expect(resolveStaticPath(distDir, '/%2e%2e%2fsecret')).toBe(join(distDir, 'secret'))
    expect(resolveStaticPath(distDir, '/%2e%2e%2f%2e%2e%2fetc/passwd')).toBe(
      join(distDir, 'etc/passwd'),
    )
  })

  test('a NON-rooted `../secret` traversal returns null', () => {
    // Without a leading slash there is no root to collapse against, so `..`
    // survives and the resolved path leaves distDir — the resolver rejects it.
    expect(resolveStaticPath(distDir, '../secret')).toBeNull()
    expect(resolveStaticPath(distDir, '../../etc/passwd')).toBeNull()
  })

  test('a NON-rooted `%2e%2e%2f` encoding that escapes returns null', () => {
    expect(resolveStaticPath(distDir, '%2e%2e%2f%2e%2e%2fetc/passwd')).toBeNull()
  })

  test('a sibling-prefix path the old startsWith check would have accepted returns null', () => {
    // The sibling-prefix flaw: `../dist-evil/x` resolves to an absolute path that
    // shares distDir's STRING prefix (`/srv/app/dist-evil/x` starts with
    // `/srv/app/dist`) yet lives OUTSIDE distDir. A bare `abs.startsWith(distDir)`
    // guard accepts it; the `relative`-based check rejects it.
    const siblingName = basename(distDir) + '-evil'
    const pathname = `../${siblingName}/x`
    const escaped = join(dirname(distDir), siblingName, 'x')

    // The escaped absolute path DOES satisfy the old prefix test, proving the
    // hole the fix closes.
    expect(escaped).toBe(distDir + '-evil/x')
    expect(escaped.startsWith(distDir)).toBe(true)

    // The current resolver refuses it.
    expect(resolveStaticPath(distDir, pathname)).toBeNull()
  })

  test('the bare root path resolves inside distDir (the caller treats it as SPA)', () => {
    // `/` normalizes to distDir; the handler serves the SPA index for it. The
    // resolved path is contained, never null.
    const abs = resolveStaticPath(distDir, '/')
    expect(abs).not.toBeNull()
    expect(abs?.startsWith(distDir)).toBe(true)
  })
})

/**
 * A MockBundle whose every access throws. A static/traversal request must never
 * reach the API surface, so touching any member is a test failure.
 */
function throwingMock(): MockBundle {
  const trap = new Proxy(
    {},
    {
      get() {
        throw new Error('the mock must not be reached for a static/traversal path')
      },
    },
  )
  return { api: trap as RevuApi, dev: trap as MockBundle['dev'], store: trap as MockBundle['store'] }
}

describe('createFetchHandler: traversal falls through to the SPA index', () => {
  const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>'
  const ASSET_BODY = 'console.log("ok")'

  function makeStubDist(): string {
    const dir = mkdtempSync(join(tmpdir(), 'revud-static-'))
    writeFileSync(join(dir, 'index.html'), INDEX_HTML, 'utf8')
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'assets', 'app.js'), ASSET_BODY, 'utf8')
    return dir
  }

  test('a real asset is served, and traversal encodings return the SPA index (200)', async () => {
    const distDir = makeStubDist()
    // A sibling directory sharing distDir's prefix, holding a secret the prefix
    // flaw would have exposed. It must remain unreachable over HTTP.
    const siblingSecret = distDir + '-evil'
    mkdirSync(siblingSecret, { recursive: true })
    writeFileSync(join(siblingSecret, 'secret.txt'), 'TOP SECRET', 'utf8')

    try {
      const handler = createFetchHandler(distDir, throwingMock(), 'mock')

      // A genuine asset resolves and is served verbatim.
      const asset = await handler(new Request('http://localhost/assets/app.js'))
      expect(asset.status).toBe(200)
      expect(await asset.text()).toBe(ASSET_BODY)

      // A literal `/../secret` falls through to the SPA index, never escaping.
      const literal = await handler(new Request('http://localhost/../secret'))
      expect(literal.status).toBe(200)
      expect(await literal.text()).toBe(INDEX_HTML)

      // The percent-encoded `%2e%2e%2f` form does the same.
      const encoded = await handler(new Request('http://localhost/%2e%2e%2fsecret'))
      expect(encoded.status).toBe(200)
      expect(await encoded.text()).toBe(INDEX_HTML)

      // A sibling-prefix escape aimed at `${distDir}-evil/secret.txt` must not
      // leak the sibling's contents — it also falls through to the index. (The
      // URL parser roots the pathname, so this is doubly safe, but the assertion
      // pins the observable no-leak contract.)
      const siblingName = basename(distDir) + '-evil'
      const sibling = await handler(
        new Request(`http://localhost/../${siblingName}/secret.txt`),
      )
      expect(sibling.status).toBe(200)
      expect(await sibling.text()).toBe(INDEX_HTML)
    } finally {
      rmSync(distDir, { recursive: true, force: true })
      rmSync(siblingSecret, { recursive: true, force: true })
    }
  })
})
