import { Fragment } from 'react'
import { cn } from '@/lib/cn'

export interface KbdProps {
  /** One chip per key, e.g. `['⌘', 'K']` or `['g', 'p']` for a chord. */
  keys: string[]
  className?: string
}

/**
 * Renders keyboard shortcut chips using the shared `.kbd` class from globals.css.
 * A multi-key sequence is chained with hairline `+` separators so a chord reads
 * as one gesture rather than a row of loose keys.
 */
export function Kbd({ keys, className }: KbdProps) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {keys.map((key, i) => (
        <Fragment key={`${key}-${i}`}>
          {i > 0 && <span className="text-2xs text-ink-faint">+</span>}
          <kbd className="kbd">{key}</kbd>
        </Fragment>
      ))}
    </span>
  )
}
Kbd.displayName = 'Kbd'
