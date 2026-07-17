import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef, ElementRef } from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '@/lib/cn'

/**
 * A small 28×16 toggle. Off is a quiet raised track; on fills with the violet
 * draft accent (toggles here gate pending state: draft mode, show-only-mine).
 */
export const Switch = forwardRef<
  ElementRef<typeof SwitchPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-line-strong bg-raised transition-colors',
      'data-[state=checked]:border-draft data-[state=checked]:bg-draft',
      'disabled:pointer-events-none disabled:opacity-45',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block size-3 rounded-full bg-ink shadow-sm transition-transform',
        'translate-x-0.5 data-[state=checked]:translate-x-[13px] data-[state=checked]:bg-canvas',
      )}
    />
  </SwitchPrimitive.Root>
))
Switch.displayName = 'Switch'
