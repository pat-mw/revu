import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

/**
 * A dense status chip. Semantic variants borrow the app palette but stay tinted
 * (alpha fills, not solid) so a row of badges never turns into a Christmas tree:
 * the loud, saturated versions of these hues are reserved for diff surfaces and
 * the draft rail. `draft` is the one violet badge — pending, GitHub-invisible work.
 */
const badgeVariants = cva(
  'inline-flex select-none items-center gap-1 whitespace-nowrap rounded-(--radius-xs) px-1.5 py-px font-sans text-2xs font-medium leading-tight',
  {
    variants: {
      variant: {
        default: 'bg-raised text-ink-mut',
        outline: 'border border-line text-ink-mut',
        add: 'bg-add/12 text-add',
        del: 'bg-del/12 text-del',
        draft: 'bg-draft/14 text-draft',
        stale: 'bg-stale/12 text-stale',
        danger: 'bg-danger/12 text-danger',
        resolved: 'bg-ink-mut/12 text-ink-mut line-through decoration-ink-faint',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  ),
)
Badge.displayName = 'Badge'

export { badgeVariants }
