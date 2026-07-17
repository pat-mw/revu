import { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import type { PendingComment } from '@revu/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { CommentComposer } from '@/components/threads/composer'
import { cn } from '@/lib/cn'
import { relativeTime } from '@/lib/time'
import { useDraftActions } from '@/state/drafts'
import { useTwoStepConfirm } from './discard-confirm'

export interface PendingCommentCardProps {
  prNumber: number
  comment: PendingComment
  /**
   * Optional jump affordance for hosts outside the diff (queue, lists). When
   * present the header shows the path:line as a clickable target; inline in
   * the diff the anchor row above the card already gives that context.
   */
  onJump?: () => void
}

/**
 * A draft comment rendered at its anchor in the diff — violet-railed, marked
 * "only visible to you", and carrying its own edit/delete affordances. The
 * root element's id is the `#comment-{key}` deep-link target. Deletion is a
 * two-step confirm on the trash icon: the text disappears only after an
 * explicit second click, and edits round-trip through the shared composer so
 * nothing typed is ever lost by this component.
 */
export function PendingCommentCard({ prNumber, comment, onJump }: PendingCommentCardProps) {
  const actions = useDraftActions(prNumber)
  const deleteConfirm = useTwoStepConfirm()
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')

  const startEdit = () => {
    setEditValue(comment.body)
    setEditing(true)
  }

  const saveEdit = () => {
    actions.upsertComment({
      ...comment,
      body: editValue,
      updatedAt: new Date().toISOString(),
    })
    setEditing(false)
  }

  return (
    <div
      id={`comment-${comment.key}`}
      className="draft-marker rounded-(--radius-sm) border border-line bg-panel"
    >
      <div className="flex h-6 items-center gap-2 px-2 text-2xs">
        <Badge variant="draft">pending</Badge>
        <span className="shrink-0 text-ink-faint">only visible to you</span>
        {comment.start_line !== null && (
          <span className="shrink-0 font-mono text-ink-mut">
            lines {comment.start_line}–{comment.line}
          </span>
        )}
        {onJump && (
          <button
            type="button"
            onClick={onJump}
            className="min-w-0 truncate font-mono text-ink-mut hover:text-ink"
            title={`${comment.path}:${comment.line}`}
          >
            {comment.path}:{comment.line}
          </button>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span className="text-ink-faint">{relativeTime(comment.updatedAt)}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 px-0 [&_svg]:size-3"
            aria-label="Edit pending comment"
            onClick={startEdit}
            disabled={editing}
          >
            <Pencil strokeWidth={1.5} aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-5 w-5 px-0 [&_svg]:size-3',
              deleteConfirm.armed
                ? 'bg-danger/15 text-danger hover:bg-danger/25 hover:text-danger'
                : 'text-ink-faint hover:text-danger',
            )}
            aria-label={
              deleteConfirm.armed
                ? 'Click again to delete this pending comment'
                : 'Delete pending comment'
            }
            onClick={() =>
              deleteConfirm.trigger(() => actions.removeComment(comment.key))
            }
          >
            <Trash2 strokeWidth={1.5} aria-hidden />
          </Button>
        </div>
      </div>
      <div className="px-2 pb-2">
        {editing ? (
          <CommentComposer
            value={editValue}
            onChange={setEditValue}
            onSubmit={saveEdit}
            onCancel={() => setEditing(false)}
            submitLabel="Save"
            suggestionSeed={null}
            autoFocus
            compact
          />
        ) : (
          <Markdown>{comment.body}</Markdown>
        )}
      </div>
    </div>
  )
}
PendingCommentCard.displayName = 'PendingCommentCard'
