import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef, ElementRef, HTMLAttributes } from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight, Circle } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * A dense context menu on the overlay surface. Rows are `h-7`, hairline-separated,
 * and highlight on the raised surface rather than a solid accent — the menu reads
 * as a quiet list of actions, not a colored palette.
 */
export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
export const DropdownMenuGroup = DropdownMenuPrimitive.Group
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal
export const DropdownMenuSub = DropdownMenuPrimitive.Sub
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

export const DropdownMenuSubTrigger = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean
  }
>(({ className, inset, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      'flex h-7 cursor-default select-none items-center rounded-(--radius-xs) px-2 text-sm text-ink outline-none',
      'focus:bg-raised data-[state=open]:bg-raised',
      inset && 'pl-7',
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight size={14} strokeWidth={1.5} className="ml-auto text-ink-faint" aria-hidden />
  </DropdownMenuPrimitive.SubTrigger>
))
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger'

export const DropdownMenuSubContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.SubContent
    ref={ref}
    className={cn(
      'z-50 min-w-[10rem] overflow-hidden rounded-(--radius-md) border border-line bg-overlay p-1 text-sm text-ink shadow-xl',
      className,
    )}
    {...props}
  />
))
DropdownMenuSubContent.displayName = 'DropdownMenuSubContent'

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-[10rem] overflow-hidden rounded-(--radius-md) border border-line bg-overlay p-1 text-sm text-ink shadow-xl',
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
DropdownMenuContent.displayName = 'DropdownMenuContent'

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean
    /** Tint the row and its icon danger-red for destructive actions. */
    destructive?: boolean
  }
>(({ className, inset, destructive, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      'flex h-7 cursor-default select-none items-center gap-2 rounded-(--radius-xs) px-2 text-sm outline-none transition-colors',
      'focus:bg-raised',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
      '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-faint',
      destructive
        ? 'text-danger focus:bg-danger/12 focus:text-danger [&_svg]:text-danger'
        : 'text-ink',
      inset && 'pl-7',
      className,
    )}
    {...props}
  />
))
DropdownMenuItem.displayName = 'DropdownMenuItem'

export const DropdownMenuCheckboxItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    checked={checked}
    className={cn(
      'relative flex h-7 cursor-default select-none items-center rounded-(--radius-xs) pl-7 pr-2 text-sm text-ink outline-none transition-colors',
      'focus:bg-raised',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check size={13} strokeWidth={2.25} className="text-draft" aria-hidden />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
))
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem'

export const DropdownMenuRadioItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      'relative flex h-7 cursor-default select-none items-center rounded-(--radius-xs) pl-7 pr-2 text-sm text-ink outline-none transition-colors',
      'focus:bg-raised',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Circle size={6} className="fill-draft text-draft" aria-hidden />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
))
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem'

export const DropdownMenuLabel = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Label>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(
      'px-2 py-1 font-sans text-2xs font-medium uppercase tracking-wide text-ink-faint',
      inset && 'pl-7',
      className,
    )}
    {...props}
  />
))
DropdownMenuLabel.displayName = 'DropdownMenuLabel'

export const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-line', className)}
    {...props}
  />
))
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator'

/** Right-aligned shortcut hint (e.g. ⌘K) inside a menu item. */
export function DropdownMenuShortcut({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('ml-auto font-mono text-2xs tracking-wide text-ink-faint', className)}
      {...props}
    />
  )
}
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut'
