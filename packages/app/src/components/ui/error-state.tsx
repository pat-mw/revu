import { AlertTriangle } from 'lucide-react'
import { Button } from './button'
import { cn } from '@/lib/cn'

export interface ErrorStateProps {
  /** Names the failure in plain language, e.g. "Couldn't sync this PR". */
  title: string
  /**
   * The fix or cause. For a rate-limited error the caller formats a resetAt into
   * copy like "Shared GitHub budget is spent — resets in 4m." and passes it here;
   * this component does no error interpretation of its own.
   */
  detail?: string
  /** When present, renders a retry button that calls this. */
  retry?: () => void
  retryLabel?: string
  className?: string
}

/**
 * A compact, danger-tinted box that names a failure and the way out. It renders
 * exactly what it's given — title, optional detail, optional retry — and never
 * inspects an error itself; the caller owns turning an ApiError (rate_limited,
 * network, forbidden…) into honest copy.
 */
export function ErrorState({
  title,
  detail,
  retry,
  retryLabel = 'Retry',
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2.5 rounded-(--radius-sm) border border-danger/35 bg-danger/8 px-3 py-2.5',
        className,
      )}
    >
      <AlertTriangle
        size={15}
        strokeWidth={1.5}
        className="mt-0.5 shrink-0 text-danger"
        aria-hidden
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="text-sm font-medium text-ink">{title}</p>
        {detail && <p className="text-xs leading-relaxed text-ink-mut">{detail}</p>}
        {retry && (
          <div className="pt-0.5">
            <Button variant="outline" size="sm" onClick={retry}>
              {retryLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
ErrorState.displayName = 'ErrorState'
