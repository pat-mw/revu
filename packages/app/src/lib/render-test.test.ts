import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { NavLink } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { renderStatic } from './render-test'

/**
 * The static-render harness, asserted on itself: what it can see, and — the
 * part that matters — what it structurally cannot.
 */

describe('renderStatic reaches real component markup', () => {
  it('a Badge renders its child text', () => {
    const html = renderStatic(createElement(Badge, { variant: 'draft' }, 'local'))
    expect(html).toContain('local')
    expect(html).toContain('<span')
  })

  it('a NavLink renders an anchor, so the router context is wired', () => {
    const html = renderStatic(createElement(NavLink, { to: '/inbox' }, 'Inbox'))
    expect(html).toContain('<a')
    expect(html).toContain('href="/inbox"')
    expect(html).toContain('Inbox')
  })
})

describe('portalled tooltip content is absent from static markup', () => {
  /**
   * The load-bearing limit of this harness. Radix portals `TooltipContent`,
   * and a portal has nowhere to land without a DOM, so a closed tooltip
   * renders as its trigger alone. Any assertion of the form
   * `expect(html).not.toContain(<some tooltip copy>)` therefore passes for a
   * reason that has nothing to do with the copy, and would keep passing after
   * the copy was reintroduced — assert tooltip text against the module that
   * produces it instead.
   *
   * If a future Radix release starts emitting portal content statically, this
   * test goes red. That failure is good news: it means tooltip copy becomes
   * directly assertable in rendered markup, and the indirect assertions
   * written around this limit can be tightened.
   */
  const SENTINEL = 'renderStatic-portal-sentinel-8f3a'

  it('the trigger survives, the content does not', () => {
    const html = renderStatic(
      createElement(
        Tooltip,
        null,
        createElement(TooltipTrigger, null, 'open the hint'),
        createElement(TooltipContent, null, SENTINEL),
      ),
    )
    expect(html).toContain('open the hint')
    expect(html).not.toContain(SENTINEL)
  })
})
