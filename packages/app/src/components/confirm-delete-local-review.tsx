import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ErrorState } from '@/components/ui/error-state'
import { Spinner } from '@/components/ui/spinner'
import type { RowIdentity } from '@/lib/local-reviews'
import { deleteLocalReviewCopy, deleteLocalReviewRefusedCopy } from '@/lib/mode-copy'
import type { DeleteDraftSummary } from '@/lib/mode-copy'

/**
 * The confirmation asked before a review of two local branches is deleted.
 *
 * ## What this dialog is, and what it is not
 *
 * It is NOT what protects an unsubmitted draft. A delete is refused where the
 * review is held, for as long as any human's draft on it holds text, and no
 * flag on the request can force it through. A script that never draws a dialog
 * cannot destroy a draft either — which is precisely why the protection lives
 * there and not here.
 *
 * What this exists for is the two things a refusal alone cannot do. It explains
 * a refusal the reader would otherwise meet as a bare error; and it offers the
 * discard as a deliberate SECOND act, named on the button, so that text the
 * reader wrote leaves only by a choice they made with the consequence in front
 * of them. The copy says the draft is discarded and its text not kept, because
 * that is what happens — it must never suggest the characters survive somewhere.
 *
 * ## Why this file is two exports and not one component
 *
 * A dialog's content renders through a portal, and a portal has no target
 * during static rendering, so the shell serialises to the empty string and any
 * assertion written against it would pass forever over any regression. So the
 * observable part is separated from the shell that cannot be observed:
 *
 * - `ConfirmDeleteLocalReviewBody` is the portal-free body. It owns no query
 *   and no mutation — the identity, the draft summary, the pending flag and any
 *   refusal all arrive as props — so its markup is a pure function of them.
 * - `ConfirmDeleteLocalReviewDialog` is the shell around it, thin enough that
 *   what it adds is a title and a modal.
 *
 * The heading lives on the shell because a modal has to name itself to a screen
 * reader through the dialog primitive's own title element, which cannot exist
 * outside it. Its wording is pinned where it is decided, beside every other
 * sentence here.
 */

export interface ConfirmDeleteLocalReviewBodyProps {
  /**
   * What the review is called. A local review is named by its branch pair; the
   * synthetic key it is routed by is an internal key and reaches no screen.
   */
  identity: RowIdentity
  /** The reader's own unsubmitted draft, or `null` when it holds no text. */
  draft: DeleteDraftSummary | null
  /** A delete is in flight, so neither control decides anything more. */
  pending: boolean
  /**
   * The refusal exactly as the workspace worded it, or `null`. Rendered
   * verbatim: only that side knows which review and whose draft is in the way.
   */
  refusal: string | null
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The confirmation's body, with no portal anywhere in it — which is what makes
 * it assertable as markup, and is why the shell is a separate component.
 *
 * The destructive control is NOT the default focus. The cancel is, so the
 * reflex Enter on a dialog that appeared unexpectedly keeps the review; reaching
 * the delete takes a deliberate second key or a click.
 *
 * Renders nothing for a review that is not a branch pair. Nothing in this app
 * deletes a mediated review, so there is no honest confirmation to draw for
 * one — and the copy module answers that reading with no sentences at all.
 */
export function ConfirmDeleteLocalReviewBody({
  identity,
  draft,
  pending,
  refusal,
  onConfirm,
  onCancel,
}: ConfirmDeleteLocalReviewBodyProps) {
  if (identity.kind !== 'local') return null
  const copy = deleteLocalReviewCopy('local', draft)
  if (copy === null) return null
  const frame = deleteLocalReviewRefusedCopy('local')

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-xs text-ink-mut">
        {identity.base}
        <span className="text-ink-faint"> ← </span>
        {identity.head}
      </p>

      <p className="text-sm leading-relaxed text-ink-mut">{copy.body}</p>

      {refusal !== null && frame !== null && <ErrorState title={frame} detail={refusal} />}

      <div className="flex items-center justify-end gap-2 pt-1">
        {/* Focused on open, and first in the tab order, so the way out is what
            a keystroke aimed at nothing in particular reaches. */}
        <Button autoFocus variant="ghost" onClick={onCancel} disabled={pending}>
          {copy.cancel}
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={pending}>
          {pending ? (
            <Spinner size={12} label="Deleting the review" />
          ) : (
            <Trash2 strokeWidth={1.5} aria-hidden />
          )}
          {copy.confirm}
        </Button>
      </div>
    </div>
  )
}
ConfirmDeleteLocalReviewBody.displayName = 'ConfirmDeleteLocalReviewBody'

export interface ConfirmDeleteLocalReviewDialogProps
  extends ConfirmDeleteLocalReviewBodyProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The body in a modal.
 *
 * Dismissal is blocked while a delete is in flight — the request cannot be
 * recalled, and a dialog that vanished mid-delete would leave the reader unsure
 * whether the review is going. Everything else the shell does is structural.
 */
export function ConfirmDeleteLocalReviewDialog({
  open,
  onOpenChange,
  ...bodyProps
}: ConfirmDeleteLocalReviewDialogProps) {
  const copy = deleteLocalReviewCopy(
    bodyProps.identity.kind === 'local' ? 'local' : 'github',
    bodyProps.draft,
  )
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && bodyProps.pending) return
        onOpenChange(next)
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{copy?.title ?? ''}</DialogTitle>
        </DialogHeader>
        <ConfirmDeleteLocalReviewBody {...bodyProps} />
      </DialogContent>
    </Dialog>
  )
}
ConfirmDeleteLocalReviewDialog.displayName = 'ConfirmDeleteLocalReviewDialog'
