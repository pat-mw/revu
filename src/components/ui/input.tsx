import { forwardRef } from 'react'
import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

/**
 * The app's single-line input. Height matches buttons and menu rows (`h-7`) so a
 * search field sits flush in a dense toolbar. Sans by default; pass a `font-mono`
 * className for fields that hold code-shaped values (SHAs, paths).
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type ?? 'text'}
      className={cn(
        'h-7 w-full rounded-(--radius-sm) border border-line bg-panel px-2 font-sans text-sm text-ink',
        'placeholder:text-ink-faint',
        'hover:border-line-strong',
        'focus:border-line-strong',
        'disabled:pointer-events-none disabled:opacity-50',
        'file:mr-2 file:border-0 file:bg-transparent file:text-sm file:text-ink-mut',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
