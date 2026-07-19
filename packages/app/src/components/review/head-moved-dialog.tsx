import { useState } from 'react'
import type { ReconcileReport } from '@revu/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/components/ui/toast'
import { shortSha } from '@/lib/time'
import { useReconcile } from '@/state/drafts'
import { useSyncPull } from '@/state/queries'
import { describeApiError, HEAD_MOVED_TITLE } from './error-copy'

export interface HeadMovedDialogProps {
  prNumber: number
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Head SHA the review was submitted against (the local snapshot's head). */
  draftHeadSha: string
  /** Where the branch actually is now, per the refused submit. */
  currentHeadSha: string
  /** Commits that landed between the two SHAs. */
  newCommits: number
  pendingCount: number
  /** Fires with the reconcile report once re-sync + classification succeed. */
  onReconciled: (report: ReconcileReport) => void
}

/**
 * The fork in the road after a submit comes back `head_moved`: re-sync and
 * walk through reconcile, or keep reviewing against the old snapshot (in
 * which case the next submit will land right back here — that's honest, not
 * a bug). The draft is untouched either way; this dialog only reads.
 */
export function HeadMovedDialog({
  prNumber,
  open,
  onOpenChange,
  draftHeadSha,
  currentHeadSha,
  newCommits,
  pendingCount,
  onReconciled,
}: HeadMovedDialogProps) {
  const sync = useSyncPull(prNumber)
  const reconcile = useReconcile(prNumber)
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (busy) return
    setBusy(true)
    try {
      await sync.mutateAsync()
      const report = await reconcile.mutateAsync()
      onReconciled(report)
    } catch (error) {
      toast({
        kind: 'error',
        title: "Couldn't re-sync the snapshot",
        detail: describeApiError(error),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{HEAD_MOVED_TITLE}</DialogTitle>
          <DialogDescription>
            {newCommits} new {newCommits === 1 ? 'commit' : 'commits'} landed since your
            snapshot (<span className="font-mono text-xs">{shortSha(draftHeadSha)}</span> →{' '}
            <span className="font-mono text-xs">{shortSha(currentHeadSha)}</span>). Your{' '}
            {pendingCount} pending{' '}
            {pendingCount === 1 ? 'comment anchors' : 'comments anchor'} to the old code.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Keep reviewing on the old snapshot
          </Button>
          <Button variant="primary" size="sm" onClick={() => void run()} disabled={busy}>
            {busy && <Spinner size={12} label="Re-syncing" />}
            Re-sync &amp; reconcile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
HeadMovedDialog.displayName = 'HeadMovedDialog'
