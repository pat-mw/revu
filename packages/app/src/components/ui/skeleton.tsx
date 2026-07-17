import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

/**
 * A loading placeholder built on the shared `.skeleton` class (raised fill,
 * shimmer that stills under reduced-motion via the global rule). Skeletons should
 * match the final layout's shape — size each instance to the block it stands in.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton', className)} {...props} />
}
Skeleton.displayName = 'Skeleton'
