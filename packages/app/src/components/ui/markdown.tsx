import { isValidElement } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/cn'

/**
 * Dense comment/prose markdown. Typography is tuned for review threads, not an
 * article: 13px body, tight lists, monospace inline code on the raised surface, a
 * hairline blockquote, and links in the add-teal accent. GFM tables/strikethrough/
 * task lists are on.
 *
 * One app-specific rule: a fenced code block tagged ```suggestion renders as a
 * `SuggestionBlock` (a proposed change), not as plain code — the same convention
 * GitHub uses for inline suggested edits.
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

const components: Components = {
  p: ({ className, ...props }) => (
    <p className={cn('my-1.5 leading-relaxed first:mt-0 last:mb-0', className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        'text-add underline decoration-add/40 underline-offset-2 hover:decoration-add',
        className,
      )}
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cn('my-1.5 ml-4 list-disc space-y-0.5 marker:text-ink-faint', className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn('my-1.5 ml-4 list-decimal space-y-0.5 marker:text-ink-faint', className)} {...props} />
  ),
  li: ({ className, ...props }) => (
    <li className={cn('leading-relaxed', className)} {...props} />
  ),
  h1: ({ className, ...props }) => (
    <h1 className={cn('mb-1.5 mt-3 font-display text-base font-semibold text-ink first:mt-0', className)} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 className={cn('mb-1 mt-3 font-display text-sm font-semibold text-ink first:mt-0', className)} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 className={cn('mb-1 mt-2 text-sm font-semibold text-ink first:mt-0', className)} {...props} />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn('my-1.5 border-l-2 border-line-strong pl-3 text-ink-mut', className)}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn('my-3 border-line', className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className={cn('w-full border-collapse text-xs', className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        'border border-line bg-raised px-2 py-1 text-left font-medium text-ink-mut',
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td className={cn('border border-line px-2 py-1', className)} {...props} />
  ),
  img: ({ className, ...props }) => (
    <img className={cn('my-2 max-w-full rounded-(--radius-sm)', className)} {...props} />
  ),
  /**
   * `pre` is an unstyled passthrough: fenced blocks own their own surface via the
   * `code` renderer below, so wrapping them in a second styled box would double
   * the border.
   */
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className ?? '')
    const language = match?.[1]
    const isBlock = className?.includes('language-') ?? false

    if (isBlock && language === 'suggestion') {
      return <SuggestionBlock code={nodeText(children).replace(/\n$/, '')} />
    }

    if (isBlock) {
      return (
        <pre className="my-2 overflow-x-auto rounded-(--radius-sm) border border-line bg-raised p-2.5 font-mono text-code leading-relaxed text-ink">
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      )
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
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
