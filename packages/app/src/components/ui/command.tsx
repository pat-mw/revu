import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef, ElementRef, HTMLAttributes } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { Search } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Dialog, DialogContent } from './dialog'

/**
 * The command palette, cmdk retokened to the app's dense dark surface. Items are
 * `h-8`, group headings are uppercase micro-labels in the faintest ink, and the
 * whole thing lives on the overlay color. Used for the ⌘K jump-to-PR / actions
 * launcher and any inline filterable picker.
 */
export const Command = forwardRef<
  ElementRef<typeof CommandPrimitive>,
  ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      'flex h-full w-full flex-col overflow-hidden rounded-(--radius-md) bg-overlay text-ink',
      className,
    )}
    {...props}
  />
))
Command.displayName = 'Command'

/** A palette hosted in a modal dialog, sized for the ⌘K launcher. */
export function CommandDialog({
  children,
  ...props
}: ComponentPropsWithoutRef<typeof Dialog>) {
  return (
    <Dialog {...props}>
      <DialogContent className="max-w-lg overflow-hidden p-0">
        <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group]]:px-1 [&_[cmdk-input-wrapper]_svg]:size-4">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}
CommandDialog.displayName = 'CommandDialog'

export const CommandInput = forwardRef<
  ElementRef<typeof CommandPrimitive.Input>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex h-9 items-center gap-2 border-b border-line px-2.5" cmdk-input-wrapper="">
    <Search size={15} strokeWidth={1.5} className="shrink-0 text-ink-faint" aria-hidden />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        'flex h-full w-full bg-transparent font-sans text-sm text-ink outline-none placeholder:text-ink-faint disabled:opacity-50',
        className,
      )}
      {...props}
    />
  </div>
))
CommandInput.displayName = 'CommandInput'

export const CommandList = forwardRef<
  ElementRef<typeof CommandPrimitive.List>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn('max-h-72 overflow-y-auto overflow-x-hidden p-1', className)}
    {...props}
  />
))
CommandList.displayName = 'CommandList'

export const CommandEmpty = forwardRef<
  ElementRef<typeof CommandPrimitive.Empty>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className={cn('py-6 text-center text-sm text-ink-mut', className)}
    {...props}
  />
))
CommandEmpty.displayName = 'CommandEmpty'

export const CommandGroup = forwardRef<
  ElementRef<typeof CommandPrimitive.Group>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden text-ink [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:font-sans [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-ink-faint',
      className,
    )}
    {...props}
  />
))
CommandGroup.displayName = 'CommandGroup'

export const CommandSeparator = forwardRef<
  ElementRef<typeof CommandPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-line', className)}
    {...props}
  />
))
CommandSeparator.displayName = 'CommandSeparator'

export const CommandItem = forwardRef<
  ElementRef<typeof CommandPrimitive.Item>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex h-8 cursor-default select-none items-center gap-2 rounded-(--radius-xs) px-2 text-sm text-ink outline-none',
      'data-[selected=true]:bg-raised data-[selected=true]:text-ink',
      'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45',
      '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-faint',
      className,
    )}
    {...props}
  />
))
CommandItem.displayName = 'CommandItem'

/** Right-aligned shortcut hint inside a command row. */
export function CommandShortcut({
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
CommandShortcut.displayName = 'CommandShortcut'
