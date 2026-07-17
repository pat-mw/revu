import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef, ElementRef } from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/lib/cn'

/**
 * Underline tabs, not pills. The list is a hairline baseline; the active trigger
 * lifts to full ink text and grows a 2px ink underline that sits on the baseline.
 * This matches a code-review surface where tabs (Conversation / Files / Checks)
 * are structural sections, not a segmented control. A count belongs inline as a
 * child — `<TabsTrigger>Files<TabCount>42</TabCount></TabsTrigger>`.
 */
export const Tabs = TabsPrimitive.Root

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex h-8 items-stretch gap-3 border-b border-line',
      className,
    )}
    {...props}
  />
))
TabsList.displayName = 'TabsList'

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'group -mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-0.5 font-sans text-sm text-ink-mut transition-colors',
      'hover:text-ink',
      'data-[state=active]:border-ink data-[state=active]:text-ink',
      'disabled:pointer-events-none disabled:opacity-45',
      className,
    )}
    {...props}
  />
))
TabsTrigger.displayName = 'TabsTrigger'

/**
 * Numeric count chip for a trigger. Dims with its inactive trigger and brightens
 * when the tab is active, riding the `group` state set on `TabsTrigger`.
 */
export const TabCount = forwardRef<
  HTMLSpanElement,
  ComponentPropsWithoutRef<'span'>
>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    className={cn(
      'inline-flex min-w-4 items-center justify-center rounded-(--radius-xs) bg-raised px-1 font-mono text-2xs leading-tight text-ink-faint transition-colors',
      'group-data-[state=active]:bg-overlay group-data-[state=active]:text-ink-mut',
      className,
    )}
    {...props}
  />
))
TabCount.displayName = 'TabCount'

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn('mt-3 focus-visible:outline-none', className)}
    {...props}
  />
))
TabsContent.displayName = 'TabsContent'
