import { defaultSchema } from 'rehype-sanitize'
import type { Options as SanitizeSchema } from 'rehype-sanitize'

/**
 * The sanitization schema for comment/prose markdown, and the URL rewrites that
 * route remote images through the daemon's image proxy (with a narrow
 * pass-through for GitHub's session-gated attachment hosts).
 *
 * Comment bodies are hostile input: anyone who can comment on the client's repo
 * (or author a CI check summary) controls them, and the SPA shares its origin
 * with the daemon's unauthenticated `/api/*` write surface — script that runs
 * here submits reviews as the shared bot. Raw HTML is therefore parsed
 * (`rehype-raw`) and then filtered through this schema (`rehype-sanitize`), in
 * that order: sanitize must see real element nodes, not opaque raw text.
 *
 * The schema is `defaultSchema` (GitHub-style: allows `details`/`summary`,
 * `picture`/`source`/`img`, `sub`/`sup`, tables; forbids `script`, `style`,
 * `iframe`, `object`, `embed`, `form`, `meta`, `base`, `svg`, `math`; filters
 * `class` per token against `language-*` so fence-language conventions survive)
 * with two gaps closed:
 *
 * - `strip` gains `style`: the default strips only `script` element CONTENT and
 *   merely unwraps other disallowed tags, so a `<style>` sheet's text would
 *   otherwise land in the DOM as visible junk.
 * - `protocols` gains `srcSet`: the default allows `srcSet` on `source` but
 *   never protocol-checks it (and react-markdown's URL transform does not cover
 *   it either), so `<source srcset="javascript:…">` would pass both layers.
 *   The protocol check sees only the first candidate's scheme, so the `source`
 *   renderer additionally filters per candidate via `proxiedSrcSet`.
 */
export const MARKDOWN_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  strip: ['script', 'style'],
  protocols: {
    ...defaultSchema.protocols,
    srcSet: ['http', 'https'],
  },
}

/** The daemon route that fetches a remote image server-side and streams it back. */
export const IMAGE_PROXY_PATH = '/image-proxy'

/**
 * True for URLs on GitHub's own attachment/asset hosts, which must reach the
 * browser unproxied.
 *
 * Screenshots pasted into comments on a private repo live at
 * `https://github.com/user-attachments/assets/<uuid>` (and historically on
 * `*.githubusercontent.com`, e.g. `private-user-images.` / `user-images.`).
 * Access is authorised by the viewer's GitHub session cookie — no App or
 * installation token can read them — so the credential-less image proxy gets a
 * 404 and the only way to render them is a direct browser fetch riding the
 * reviewer's own GitHub session, exactly as github.com renders them itself.
 *
 * Matching is on the parsed hostname, never a substring of the URL, so
 * `https://evil.example/?x=github.com`, `https://github.com.evil.example/`,
 * and `https://github.com@evil.example/` all fail. `https` is required. The
 * `github.com` case is additionally pinned to the `/user-attachments/` path:
 * github.com serves far more than attachments, and since allowlisted URLs are
 * fetched by the browser with the reviewer's GitHub cookies, the
 * cookie-bearing surface a hostile comment can aim at is kept to the one path
 * that needs it. `*.githubusercontent.com` needs no path pin — every
 * subdomain is GitHub-operated static asset hosting.
 */
export function isGithubAttachmentUrl(src: string): boolean {
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.hostname === 'github.com') return url.pathname.startsWith('/user-attachments/')
  return url.hostname.endsWith('.githubusercontent.com')
}

/**
 * Rewrite a remote image URL to the daemon's image proxy.
 *
 * Absolute `http(s)` URLs become `/image-proxy?url=…` so the page itself never
 * dials a third-party host: the fetch happens in the daemon's process (in
 * broker mode, inside the workspace rather than on the reviewer's machine), a
 * strict `img-src 'self'` stays enforceable, and content-type/size limits are
 * applied at one chokepoint. The single exception is GitHub's own attachment
 * hosts (`isGithubAttachmentUrl`), which pass through unrewritten: they are
 * gated on the viewer's GitHub session cookie, which the proxy by design never
 * carries, and the CSP's `img-src` names exactly these hosts. Relative URLs
 * pass through untouched (they resolve against the daemon's own origin).
 * Anything else — including the empty string an upstream URL transform
 * substitutes for a disallowed scheme — yields `undefined` so no `src` is
 * emitted at all.
 */
export function proxiedImageUrl(src: string | undefined | null): string | undefined {
  if (src === undefined || src === null || src === '') return undefined
  if (/^https?:\/\//i.test(src)) {
    if (isGithubAttachmentUrl(src)) return src
    return `${IMAGE_PROXY_PATH}?url=${encodeURIComponent(src)}`
  }
  // Protocol-relative URLs would resolve to a third-party host; refuse them
  // rather than guessing a scheme.
  if (src.startsWith('//')) return undefined
  // A scheme other than http(s) (javascript:, data:, vbscript:, …) never
  // becomes a src. Scheme-less strings are relative paths and pass through.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return undefined
  return src
}

/**
 * Rewrite every candidate of a `srcset` through the image proxy.
 *
 * `srcset` is a comma-separated list of `URL [descriptor]` candidates; the
 * sanitize schema's protocol check only inspects the first candidate, so this
 * filters per candidate: `http(s)` URLs are proxied (or, for GitHub attachment
 * hosts, passed through unrewritten), everything else is dropped. An empty
 * result yields `undefined` so no attribute is emitted.
 * (Candidate URLs containing literal commas are not representable in `srcset`
 * without escaping and are treated as separate — malformed — candidates.)
 */
export function proxiedSrcSet(srcSet: string | undefined | null): string | undefined {
  if (srcSet === undefined || srcSet === null || srcSet === '') return undefined
  const rewritten: string[] = []
  for (const candidate of srcSet.split(',')) {
    const trimmed = candidate.trim()
    if (trimmed === '') continue
    const spaceAt = trimmed.search(/\s/)
    const url = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt)
    const descriptor = spaceAt === -1 ? '' : trimmed.slice(spaceAt)
    const proxied = proxiedImageUrl(url)
    // Only absolute URLs survive — proxied, or passed through because the
    // host is a GitHub attachment host; a relative candidate inside a bot
    // comment is meaningless and a non-http scheme is hostile.
    if (proxied === undefined) continue
    if (!proxied.startsWith(IMAGE_PROXY_PATH) && !isGithubAttachmentUrl(proxied)) continue
    rewritten.push(`${proxied}${descriptor}`)
  }
  return rewritten.length > 0 ? rewritten.join(', ') : undefined
}
