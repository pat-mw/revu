import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * Renders a chrome component to HTML with no DOM and no jsdom, so component
 * markup is assertable from a plain `.ts` test file.
 *
 * The node is wrapped in the two contexts a chrome component needs before it
 * can render at all:
 *
 * - `StaticRouter`, because `Link`/`NavLink` throw without a router context.
 * - `TooltipProvider`, because a bare `Tooltip` throws
 *   "`Tooltip` must be used within `TooltipProvider`".
 *
 * Both wrappers are unconditional: a caller cannot know whether a component
 * three levels down reaches for a router or a tooltip, and providing a context
 * nothing consumes costs nothing.
 *
 * KNOWN LIMIT — portalled content is absent from the output. Radix renders
 * `TooltipContent`, `PopoverContent` and `DialogContent` through a portal, and
 * a portal has no target during static rendering, so a closed tooltip renders
 * as its trigger and nothing more. A `not.toContain(...)` written against
 * portal copy therefore passes vacuously and asserts nothing; assert portal
 * copy against the module that produces it, not against this markup.
 * `render-test.test.ts` pins that limit executably.
 */
export function renderStatic(node: ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location: '/' },
      createElement(TooltipProvider, null, node),
    ),
  )
}
