import { useMemo } from 'react'
import { Pencil, X } from 'lucide-react'
import type { PendingComment } from '@/api/types'
import { Button } from '@/components/ui/button'

/** First non-empty line of a markdown body, for one-line summaries. */
export function firstBodyLine(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return '(empty comment)'
}

export interface PendingListProps {
  comments: PendingComment[]
  /** Scroll the diff to a pending comment's inline card. */
  onJump: (comment: PendingComment) => void
  /**
   * Remove a pending comment immediately — no confirmation here, because the
   * in-diff card (where careful editing lives) is one jump away and holds the
   * guarded delete.
   */
  onRemove: (key: string) => void
}

/**
 * The compact roster of a draft's pending comments, shown in the review bar's
 * popover. Rows are ordered by file then line so the list reads like the diff;
 * the row body jumps to the inline card, the pencil jumps too (editing happens
 * on the card), and the X removes on the spot.
 */
export function PendingList({ comments, onJump, onRemove }: PendingListProps) {
  const sorted = useMemo(
    () =>
      [...comments].sort((a, b) =>
        a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1,
      ),
    [comments],
  )

  if (sorted.length === 0) {
    return (
      <p className="px-2 py-3 text-center text-xs text-ink-faint">
        No pending comments yet — press <span className="kbd">c</span> on any diff line.
      </p>
    )
  }

  return (
    <ul className="flex max-h-80 flex-col overflow-y-auto">
      {sorted.map((comment) => (
        <li
          key={comment.key}
          className="flex items-center gap-1 rounded-(--radius-xs) pl-1.5 pr-1 hover:bg-raised"
        >
          <button
            type="button"
            onClick={() => onJump(comment)}
            className="flex min-w-0 flex-1 flex-col items-start py-1.5 text-left"
          >
            <span className="max-w-full truncate font-mono text-2xs text-ink-mut">
              {comment.path}:{comment.line}
            </span>
            <span className="max-w-full truncate text-xs text-ink">
              {firstBodyLine(comment.body)}
            </span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 shrink-0 px-0 [&_svg]:size-3"
            aria-label={`Edit the comment on ${comment.path} line ${comment.line} in the diff`}
            onClick={() => onJump(comment)}
          >
            <Pencil strokeWidth={1.5} aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 shrink-0 px-0 text-ink-faint hover:text-danger [&_svg]:size-3"
            aria-label={`Delete the pending comment on ${comment.path} line ${comment.line}`}
            onClick={() => onRemove(comment.key)}
          >
            <X strokeWidth={1.5} aria-hidden />
          </Button>
        </li>
      ))}
    </ul>
  )
}
PendingList.displayName = 'PendingList'
