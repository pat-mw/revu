import { isValidElement } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import type { Root, RootContent } from 'hast'
import { cn } from '@/lib/cn'
import {
  MARKDOWN_SANITIZE_SCHEMA,
  proxiedImageUrl,
  proxiedSrcSet,
} from '@/lib/markdown-security'
import { MermaidBlock } from './mermaid-block'

/**
 * Dense comment/prose markdown. Typography is tuned for review threads, not an
 * article: 13px body, tight lists, monospace inline code on the raised surface, a
 * hairline blockquote, and links in the add-teal accent. GFM tables/strikethrough/
 * task lists are on.
 *
 * Raw HTML is rendered, not escaped: bot authors (issue-tracker linkbacks,
 * review bots) write `<details>`, `<picture>`, `<sub>`, and HTML tables. The
 * body is hostile input — any repo commenter controls it, and this page shares
 * an origin with the daemon's write API — so raw nodes are parsed by
 * `rehype-raw` and then filtered by `rehype-sanitize` with the app schema. The
 * plugin order is load-bearing: raw must run first so sanitize sees real
 * element nodes; reversed, raw HTML would reach the DOM unfiltered. On top of
 * the schema, every remote image is rewritten to the daemon's image proxy, and
 * `mermaid` fences render as sandboxed diagrams.
 *
 * Two app-specific fence rules: ```suggestion renders as a `SuggestionBlock`
 * (a proposed change, the GitHub convention) and ```mermaid renders as a
 * `MermaidBlock` diagram with the plain code block as its fallback.
 */
export interface MarkdownProps {
  children: string
  className?: string
}

/** Pull the raw text out of a markdown code node's children. */
function nodeText(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(nodeText).join('')
  if (isValidElement(children)) {
    return nodeText((children.props as { children?: ReactNode }).children)
  }
  return ''
}

/**
 * True when the sanitized tree would paint anything: a non-whitespace text
 * node, or a void element that is content by itself. Used to detect bodies
 * that sanitize down to nothing (most commonly an unterminated `<!--`, which
 * the HTML parser treats as a comment swallowing the rest of the input).
 */
function hasRenderableContent(node: Root | RootContent): boolean {
  if (node.type === 'text') return /\S/.test(node.value)
  if (node.type === 'element') {
    if (node.tagName === 'img' || node.tagName === 'hr' || node.tagName === 'input') return true
    return node.children.some(hasRenderableContent)
  }
  if (node.type === 'root') return node.children.some(hasRenderableContent)
  return false
}

/**
 * Last-in-chain rehype plugin: when the sanitized tree is empty but the input
 * was not blank, render the raw source as muted preformatted text instead.
 * Silently showing nothing where a comment exists would hide content from the
 * reviewer — visible source is the honest failure mode. The injected node
 * carries the source as a TEXT child, so it is escaped on render and reopens
 * nothing that sanitization closed.
 */
function sourceFallback(source: string) {
  return function rehypeSourceFallback() {
    return (tree: Root) => {
      if (/^\s*$/.test(source) || hasRenderableContent(tree)) return
      tree.children = [
        {
          type: 'element',
          tagName: 'div',
          properties: {
            className: ['my-1.5', 'whitespace-pre-wrap', 'font-mono', 'text-code', 'text-ink-mut'],
          },
          children: [{ type: 'text', value: source }],
        },
      ]
    }
  }
}

/**
 * Renderer overrides. Every override drops the `node` prop before spreading
 * (react-markdown passes the hast node to custom components; spread onto a DOM
 * element it would serialize as a junk attribute), and elements with
 * security-relevant attributes spread `props` FIRST so a raw-HTML attribute
 * can never override the safe values set after it.
 */
const components: Components = {
  p: ({ node: _node, className, ...props }) => (
    <p className={cn('my-1.5 leading-relaxed first:mt-0 last:mb-0', className)} {...props} />
  ),
  a: ({ node: _node, className, ...props }) => (
    <a
      {...props}
      className={cn(
        'text-add underline decoration-add/40 underline-offset-2 hover:decoration-add',
        className,
      )}
      target="_blank"
      rel="noreferrer noopener"
    />
  ),
  ul: ({ node: _node, className, ...props }) => (
    <ul className={cn('my-1.5 ml-4 list-disc space-y-0.5 marker:text-ink-faint', className)} {...props} />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol className={cn('my-1.5 ml-4 list-decimal space-y-0.5 marker:text-ink-faint', className)} {...props} />
  ),
  li: ({ node: _node, className, ...props }) => (
    <li className={cn('leading-relaxed', className)} {...props} />
  ),
  h1: ({ node: _node, className, ...props }) => (
    <h1 className={cn('mb-1.5 mt-3 font-display text-base font-semibold text-ink first:mt-0', className)} {...props} />
  ),
  h2: ({ node: _node, className, ...props }) => (
    <h2 className={cn('mb-1 mt-3 font-display text-sm font-semibold text-ink first:mt-0', className)} {...props} />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h3 className={cn('mb-1 mt-2 text-sm font-semibold text-ink first:mt-0', className)} {...props} />
  ),
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote
      className={cn('my-1.5 border-l-2 border-line-strong pl-3 text-ink-mut', className)}
      {...props}
    />
  ),
  hr: ({ node: _node, className, ...props }) => (
    <hr className={cn('my-3 border-line', className)} {...props} />
  ),
  table: ({ node: _node, className, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className={cn('w-full border-collapse text-xs', className)} {...props} />
    </div>
  ),
  th: ({ node: _node, className, ...props }) => (
    <th
      className={cn(
        'border border-line bg-raised px-2 py-1 text-left font-medium text-ink-mut',
        className,
      )}
      {...props}
    />
  ),
  td: ({ node: _node, className, ...props }) => (
    <td className={cn('border border-line px-2 py-1', className)} {...props} />
  ),
  img: ({ node: _node, className, src, ...props }) => (
    <img
      {...props}
      loading="lazy"
      src={proxiedImageUrl(src)}
      className={cn('my-2 max-w-full rounded-(--radius-sm)', className)}
    />
  ),
  /**
   * `source` inside `<picture>`: `srcset` is the one URL-bearing attribute the
   * upstream URL transform does not cover, so it is re-filtered per candidate
   * and every surviving candidate is routed through the image proxy.
   */
  source: ({ node: _node, srcSet, ...props }) => <source {...props} srcSet={proxiedSrcSet(srcSet)} />,
  /**
   * `pre` is an unstyled passthrough: fenced blocks own their own surface via the
   * `code` renderer below, so wrapping them in a second styled box would double
   * the border.
   */
  pre: ({ children }) => <>{children}</>,
  code: ({ node: _node, className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className ?? '')
    const language = match?.[1]
    const isBlock = className?.includes('language-') ?? false

    if (isBlock && language === 'suggestion') {
      return <SuggestionBlock code={nodeText(children).replace(/\n$/, '')} />
    }

    if (isBlock) {
      const block = (
        <pre className="my-2 overflow-x-auto rounded-(--radius-sm) border border-line bg-raised p-2.5 font-mono text-code leading-relaxed text-ink">
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      )
      if (language === 'mermaid') {
        return <MermaidBlock source={nodeText(children).replace(/\n$/, '')} fallback={block} />
      }
      return block
    }

    return (
      <code
        className={cn(
          'rounded-(--radius-xs) bg-raised px-1 py-px font-mono text-[0.85em] text-ink',
          className,
        )}
        {...props}
      >
        {children}
      </code>
    )
  },
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={cn('font-sans text-sm text-ink', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA], sourceFallback(children)]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
Markdown.displayName = 'Markdown'

export interface SuggestionBlockProps {
  /** The proposed replacement lines. */
  code: string
  /** The lines being replaced, shown with del tint above the suggestion. */
  original?: string
}

/**
 * A proposed code change, styled like a mini diff: an optional block of original
 * lines under a del tint, then the suggested lines under an add tint, in the diff
 * monospace face. The header names it. Tints come straight from the diff CSS vars
 * so a suggestion reads in the same color language as the diff viewer.
 */
export function SuggestionBlock({ code, original }: SuggestionBlockProps) {
  const originalLines = original?.replace(/\n$/, '').split('\n') ?? []
  const suggestedLines = code.replace(/\n$/, '').split('\n')

  return (
    <div className="my-2 overflow-hidden rounded-(--radius-sm) border border-line">
      <div className="border-b border-line bg-panel px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-add">
        Suggested change
      </div>
      <div className="overflow-x-auto font-mono text-code leading-relaxed">
        {originalLines.map((line, i) => (
          <div
            key={`o-${i}`}
            className="flex whitespace-pre px-2.5 text-ink-mut"
            style={{ background: 'var(--diff-del-bg)' }}
          >
            <span className="mr-2 select-none text-del" aria-hidden>
              −
            </span>
            <span>{line || ' '}</span>
          </div>
        ))}
        {suggestedLines.map((line, i) => (
          <div
            key={`s-${i}`}
            className="flex whitespace-pre px-2.5 text-ink"
            style={{ background: 'var(--diff-add-bg)' }}
          >
            <span className="mr-2 select-none text-add" aria-hidden>
              +
            </span>
            <span>{line || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
SuggestionBlock.displayName = 'SuggestionBlock'
