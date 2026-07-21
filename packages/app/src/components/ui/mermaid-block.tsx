import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * A mermaid diagram rendered from an attacker-controlled fence body, contained
 * in a sandboxed iframe.
 *
 * Two containment decisions, both deliberate:
 *
 * - The library is loaded via a dynamic `import()` only when a diagram is
 *   actually on screen, so mermaid's ~1 MB never enters the main bundle and a
 *   session that opens no diagrams never fetches it.
 * - Mermaid renders imperatively and hands back an SVG string, which can only
 *   reach the page via `dangerouslySetInnerHTML` — exactly the injection class
 *   the markdown sanitizer exists to close, with only mermaid's bundled
 *   DOMPurify in the way. Instead the SVG goes into an `<iframe srcdoc>` with
 *   an EMPTY `sandbox` attribute: no `allow-scripts`, no `allow-same-origin`,
 *   no popups, no navigation. Whatever survives inside the string runs with no
 *   script execution, an opaque origin, and no handle on the parent. This is
 *   stricter than mermaid's own `securityLevel: 'sandbox'`, whose wrapper
 *   iframe grants `allow-popups` and top-navigation and loads a `data:` URL
 *   that a CSP would have to open `frame-src data:` for; a srcdoc document
 *   instead inherits this page's CSP, so the inherited `script-src` backstops
 *   the sandbox attribute and only the inline `<style>` mermaid emits needs
 *   the style allowance the app already carries.
 *
 * Every instance is individually error-isolated: a malformed diagram (bots emit
 * them) or a load failure falls back to `fallback` — the ordinary fenced code
 * block, which renders the source legibly. Until the async render completes the
 * fallback is shown too, so a static render (tests, SSR) is always the code
 * block and never a blank region.
 */
export interface MermaidBlockProps {
  /** The fence body: untrusted mermaid source. */
  source: string
  /** Rendered while loading and whenever rendering fails. */
  fallback: ReactNode
}

/** Monotonic id source: mermaid requires a unique element id per render call. */
let renderSeq = 0

/**
 * Fixed dimensions used when the SVG carries no readable viewBox; matches
 * mermaid's own fallback aspect for small diagrams.
 */
const DEFAULT_WIDTH = 600
const DEFAULT_HEIGHT = 300

/** Pull `width height` out of the SVG's viewBox to size the iframe without scripts. */
function viewBoxSize(svg: string): { width: number; height: number } {
  const match = /viewBox="[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/.exec(svg)
  const width = match ? Number(match[1]) : Number.NaN
  const height = match ? Number(match[2]) : Number.NaN
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  }
  return { width, height }
}

export function MermaidBlock({ source, fallback }: MermaidBlockProps) {
  const [svg, setSvg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    ;(async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          // 'strict' encodes labels and disables click bindings; the sandbox
          // iframe is the real barrier, this keeps the SVG itself tame.
          securityLevel: 'strict',
          theme: document.documentElement.classList.contains('light') ? 'neutral' : 'dark',
          // On failure, throw to our catch instead of injecting an error
          // graphic into the live DOM.
          suppressErrorRendering: true,
        })
        const { svg: rendered } = await mermaid.render(`revu-mermaid-${++renderSeq}`, source)
        if (!cancelled) setSvg(rendered)
      } catch {
        // Malformed source or a failed dynamic import: stay on the fallback
        // code block. Nothing here is worth surfacing as an error state — the
        // source is still fully readable.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source])

  if (svg === null) return <>{fallback}</>

  const { width, height } = viewBoxSize(svg)
  return (
    <iframe
      sandbox=""
      loading="lazy"
      title="Mermaid diagram"
      className="my-2 block w-full rounded-(--radius-sm) border border-line bg-panel"
      style={{ aspectRatio: `${width} / ${height}`, maxWidth: `${Math.ceil(width) + 2}px` }}
      srcDoc={`<!doctype html><style>html,body{margin:0;overflow:hidden}svg{display:block;width:100%;height:100%}</style>${svg}`}
    />
  )
}
MermaidBlock.displayName = 'MermaidBlock'
