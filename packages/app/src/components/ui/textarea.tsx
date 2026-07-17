import { forwardRef } from 'react'
import type { TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

/**
 * Multi-line input for comment and review-body composition. Sans by default so
 * prose reads naturally; callers that need a monospace field (raw diff snippets)
 * override via className. Autosizing is intentionally not built in — comment
 * composers own their own height policy.
 */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'min-h-[4.5rem] w-full resize-y rounded-(--radius-sm) border border-line bg-panel px-2 py-1.5 font-sans text-sm leading-relaxed text-ink',
      'placeholder:text-ink-faint',
      'hover:border-line-strong',
      'focus:border-line-strong',
      'disabled:pointer-events-none disabled:opacity-50',
      className,
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'
