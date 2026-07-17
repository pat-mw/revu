import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef, ElementRef } from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * A 14px checkbox. Unchecked reads as a quiet hairline square; checked fills with
 * the violet draft accent (checkboxes in this app gate pending/selected work).
 * The indeterminate state renders a dash for partial file/thread selections.
 */
export const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex size-3.5 shrink-0 items-center justify-center rounded-(--radius-xs) border border-line-strong bg-panel transition-colors',
      'hover:border-ink-faint',
      'data-[state=checked]:border-draft data-[state=checked]:bg-draft data-[state=checked]:text-canvas',
      'data-[state=indeterminate]:border-draft data-[state=indeterminate]:bg-draft data-[state=indeterminate]:text-canvas',
      'disabled:pointer-events-none disabled:opacity-45',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      {props.checked === 'indeterminate' ? (
        <Minus size={11} strokeWidth={2.5} aria-hidden />
      ) : (
        <Check size={11} strokeWidth={2.5} aria-hidden />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = 'Checkbox'
