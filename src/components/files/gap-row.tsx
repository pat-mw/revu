import { ArrowDown, ArrowUp, UnfoldVertical } from 'lucide-react'
import type { ExpandedRange, GapInfo } from '@/lib/diff'
import { GAP_STEP } from './use-flat-rows'
import { cn } from '@/lib/cn'

/**
 * A collapsed run of unchanged context. One 24px row carries up to three
 * targets: reveal the last 20 lines (grows the visible region upward from the
 * hunk below), reveal everything, or reveal the first 20 lines (grows downward
 * from the hunk above). Small gaps collapse to a single "expand n" target.
 *
 * Ranges are in NEW-file line numbers, matching `GapInfo`/`ExpandedRange`.
 * Expansion needs the head blob's text; until that query resolves the targets
 * are disabled (with the mock store this is a single local tick).
 */
export function GapRow({
  gap,
  canExpand,
  onExpand,
}: {
  gap: GapInfo
  canExpand: boolean
  onExpand(range: ExpandedRange): void
}) {
  const single = gap.count <= GAP_STEP
  const target =
    'inline-flex h-6 items-center gap-1 px-2 font-mono text-2xs text-ink-faint ' +
    'hover:text-ink disabled:pointer-events-none disabled:opacity-45'

  return (
    <div
      className={cn(
        'flex h-6 w-full select-none items-center bg-(--diff-hunk-bg) pl-[88px]',
        'hover:bg-raised',
      )}
    >
      {single ? (
        <button
          type="button"
          className={target}
          disabled={!canExpand}
          onClick={() => onExpand({ fromNew: gap.newStart, toNew: gap.newEnd })}
          aria-label={`Expand ${gap.count} hidden context ${gap.count === 1 ? 'line' : 'lines'}`}
        >
          <UnfoldVertical size={12} strokeWidth={1.5} aria-hidden />
          expand {gap.count} {gap.count === 1 ? 'line' : 'lines'}
        </button>
      ) : (
        <>
          <button
            type="button"
            className={target}
            disabled={!canExpand}
            onClick={() =>
              onExpand({
                fromNew: Math.max(gap.newStart, gap.newEnd - (GAP_STEP - 1)),
                toNew: gap.newEnd,
              })
            }
            aria-label={`Expand ${GAP_STEP} lines above the hunk below`}
          >
            <ArrowUp size={12} strokeWidth={1.5} aria-hidden />
            {GAP_STEP} more
          </button>
          <button
            type="button"
            className={target}
            disabled={!canExpand}
            onClick={() => onExpand({ fromNew: gap.newStart, toNew: gap.newEnd })}
            aria-label={`Expand all ${gap.count} hidden context lines`}
          >
            <UnfoldVertical size={12} strokeWidth={1.5} aria-hidden />
            expand all {gap.count} lines
          </button>
          <button
            type="button"
            className={target}
            disabled={!canExpand}
            onClick={() =>
              onExpand({
                fromNew: gap.newStart,
                toNew: Math.min(gap.newEnd, gap.newStart + (GAP_STEP - 1)),
              })
            }
            aria-label={`Expand ${GAP_STEP} lines below the hunk above`}
          >
            <ArrowDown size={12} strokeWidth={1.5} aria-hidden />
            {GAP_STEP} more
          </button>
        </>
      )}
    </div>
  )
}
GapRow.displayName = 'GapRow'
