import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

/**
 * The app's one button. Quiet by default: a raised chip that reads as a control
 * without competing with content. `primary` is violet because the primary
 * actions in this app are draft/submit actions, and violet is the app's reserved
 * pending-work accent — a violet button says "this commits your draft".
 *
 * Focus is handled globally by `:focus-visible`; variants never suppress the
 * outline. Density defaults to `h-7 px-2.5 text-sm` to match inputs and rows.
 */
const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-(--radius-sm) font-sans font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'border border-line bg-raised text-ink hover:border-line-strong hover:bg-overlay active:bg-raised',
        primary:
          'bg-draft text-canvas hover:bg-draft/90 active:bg-draft/80 [&_svg]:opacity-90',
        outline:
          'border border-line-strong bg-transparent text-ink hover:bg-raised active:bg-panel',
        ghost:
          'bg-transparent text-ink-mut hover:bg-raised hover:text-ink active:bg-panel',
        danger:
          'border border-transparent bg-danger/12 text-danger hover:bg-danger/20 active:bg-danger/25',
      },
      size: {
        sm: 'h-6 px-2 text-xs [&_svg]:size-3.5',
        default: 'h-7 px-2.5 text-sm [&_svg]:size-4',
        lg: 'h-8 px-3 text-sm [&_svg]:size-4',
        icon: 'h-7 w-7 px-0 [&_svg]:size-4',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render the single child as the button, forwarding classes and behavior. */
  asChild?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? 'button')}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { buttonVariants }
