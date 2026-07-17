import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface EmptyStateProps {
  /** An optional lucide icon element, e.g. `<Inbox size={20} strokeWidth={1.5} />`. */
  icon?: ReactNode
  title: string
  /** A single line of guidance toward the next action. */
  hint?: string
  /** A primary action (usually a Button) that resolves the emptiness. */
  action?: ReactNode
  className?: string
}

/**
 * An empty state framed as an invitation, not a shrug. The title is in the
 * display face at `text-base`; a hint points at the next move and the optional
 * action makes it one click away. Kept compact — no oceanic vertical padding.
 */
export function EmptyState({ icon, title, hint, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        className,
      )}
    >
      {icon && (
        <span
          className="mb-1 inline-flex size-9 items-center justify-center rounded-full bg-raised text-ink-mut [&_svg]:size-5"
          aria-hidden
        >
          {icon}
        </span>
      )}
      <p className="font-display text-base font-medium text-ink">{title}</p>
      {hint && <p className="max-w-xs text-sm leading-relaxed text-ink-mut">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
EmptyState.displayName = 'EmptyState'
