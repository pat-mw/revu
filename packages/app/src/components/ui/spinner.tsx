import { cn } from '@/lib/cn'

export interface SpinnerProps {
  /** Diameter in px; 12 for inline text, 16 for buttons and toolbars. */
  size?: 12 | 16
  className?: string
  /** Accessible label announced to screen readers. */
  label?: string
}

/**
 * A borderless ring spinner: a faint full circle with one brighter arc that
 * rotates. The spin animation respects the global reduced-motion rule, which
 * flattens it to a static ring for users who ask for less movement.
 */
export function Spinner({ size = 16, className, label = 'Loading' }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'inline-block shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-ink',
        className,
      )}
      style={{ width: size, height: size }}
    />
  )
}
Spinner.displayName = 'Spinner'
