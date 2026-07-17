import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef, ElementRef } from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/cn'

/**
 * Small delayed hints for icon-only controls and truncated labels. A 300ms open
 * delay keeps them from flashing during dense pointer travel; the surface is the
 * overlay color at `text-xs`. Wrap the app (or a subtree) in `TooltipProvider`.
 */
export const TooltipProvider = ({
  delayDuration = 300,
  ...props
}: ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) => (
  <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
)
TooltipProvider.displayName = 'TooltipProvider'

export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 5, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 max-w-xs rounded-(--radius-sm) border border-line bg-overlay px-2 py-1 font-sans text-xs leading-snug text-ink shadow-lg',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = 'TooltipContent'
