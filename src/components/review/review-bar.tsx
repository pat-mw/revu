import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Lock } from 'lucide-react'
import type { PendingComment, ReconcileReport, ReviewDraft } from '@/api/types'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CommentComposer } from '@/components/threads/composer'
import { cn } from '@/lib/cn'
import { useShortcut } from '@/lib/keyboard'
import { relativeTime } from '@/lib/time'
import { useDraft, useDraftActions, useDraftDirty, useSubmitReview } from '@/state/drafts'
import { useFilesView } from '@/state/files-view'
import { usePullItem, useSnapshot } from '@/state/queries'
import { useTwoStepConfirm } from './discard-confirm'
import { describeApiError } from './error-copy'
import { HeadMovedDialog } from './head-moved-dialog'
import { firstBodyLine, PendingList } from './pending-list'
import { ReconcileDialog } from './reconcile-dialog'

/**
 * The persistent bottom strip of every PR view — the draft's home. Quiet
 * one-liner while no review is in progress; once a draft holds a comment or a
 * summary it grows the violet rail, the pending roster, the verdict picker,
 * the persistence whisper, and the atomic Submit. Submit routes its three
 * non-throwing outcomes explicitly: posted, forbidden (self-review), or
 * head-moved into the reconcile flow.
 *
 * Keyboard: `s` expands/focuses the summary composer; `mod+enter` submits
 * when pressed outside a text field (inside the composer, the composer's own
 * handler wins because the registry ignores text-entry targets).
 */
export function ReviewBar({ prNumber }: { prNumber: number }) {
  const navigate = useNavigate()
  const filesView = useFilesView()
  const snapshot = useSnapshot(prNumber).data ?? null
  const item = usePullItem(prNumber)
  const draft = useDraft(prNumber).data ?? null
  const actions = useDraftActions(prNumber)
  const dirty = useDraftDirty(prNumber)
  const submit = useSubmitReview(prNumber)
  const { toast } = useToast()
  const discardConfirm = useTwoStepConfirm()

  const [bodyExpanded, setBodyExpanded] = useState(false)
  const [focusSeq, setFocusSeq] = useState(0)
  const [pendingOpen, setPendingOpen] = useState(false)
  const [headMoved, setHeadMoved] = useState<{
    currentHeadSha: string
    newCommits: number
  } | null>(null)
  const [reconcileReport, setReconcileReport] = useState<ReconcileReport | null>(null)

  const canApprove = item?.broker.canApprove ?? false
  const pendingCount = draft?.comments.length ?? 0
  // A cached-but-empty draft (never typed into) does not count as a review in
  // progress; it is also never persisted, so nothing is at stake.
  const active = draft !== null && (draft.comments.length > 0 || draft.body !== '')
  const submittable = active && (pendingCount > 0 || (draft?.body.trim() ?? '') !== '')
  const dialogOpen = headMoved !== null || reconcileReport !== null

  const expandBody = () => {
    setBodyExpanded(true)
    // Remounting the composer re-runs its autoFocus, so `s` always lands the
    // caret in the summary even when the editor is already open.
    setFocusSeq((n) => n + 1)
  }

  const handleBodyChange = (value: string) => {
    if (!snapshot) return
    if (!draft) {
      // The draft is born on the first real keystroke, never on focus.
      if (value === '') return
      actions.ensureDraft({
        headSha: snapshot.immutable.headSha,
        compareKey: snapshot.immutable.compareKey,
      })
    }
    actions.setBody(value)
  }

  const jumpToPending = (comment: PendingComment) => {
    setPendingOpen(false)
    if (filesView) {
      filesView.jumpTo({ path: comment.path, pendingKey: comment.key })
    } else {
      navigate(`/pr/${prNumber}/files#comment-${comment.key}`)
    }
  }

  const handleSubmit = async () => {
    if (!snapshot || !draft || !submittable || submit.isPending) return
    try {
      await actions.flush()
      const result = await submit.mutateAsync({
        prNumber,
        expectedHeadSha: snapshot.immutable.headSha,
        event: draft.event,
        body: draft.body,
        comments: draft.comments,
      })
      if (result.status === 'ok') {
        setBodyExpanded(false)
        toast({
          kind: 'success',
          title: 'Review posted',
          detail:
            pendingCount === 0
              ? 'Summary posted in one API call.'
              : `${pendingCount} ${
                  pendingCount === 1 ? 'comment' : 'comments'
                } in one API call.`,
        })
      } else if (result.status === 'forbidden') {
        actions.setEvent('COMMENT')
        toast({ kind: 'error', title: result.reason })
      } else {
        setHeadMoved({
          currentHeadSha: result.currentHeadSha,
          newCommits: result.newCommits,
        })
      }
    } catch (error) {
      toast({
        kind: 'error',
        title: describeApiError(error),
        detail: 'Your draft is untouched on the broker — nothing was lost.',
      })
    }
  }

  const handleDiscard = () => {
    discardConfirm.trigger(() => {
      setBodyExpanded(false)
      actions
        .discard()
        .then(() => toast({ title: 'Draft discarded.' }))
        .catch((error) =>
          toast({
            kind: 'error',
            title: "Couldn't discard the draft",
            detail: describeApiError(error),
          }),
        )
    })
  }

  useShortcut('s', expandBody, { enabled: snapshot !== null && !dialogOpen })
  useShortcut('mod+enter', () => void handleSubmit(), {
    enabled: snapshot !== null && submittable && !submit.isPending && !dialogOpen,
  })

  if (!snapshot) return null

  const composer = (
    <div
      key={focusSeq}
      className="min-w-0 flex-1 py-1.5"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setBodyExpanded(false)
        }
      }}
    >
      <CommentComposer
        value={draft?.body ?? ''}
        onChange={handleBodyChange}
        onSubmit={() => setBodyExpanded(false)}
        onCancel={() => setBodyExpanded(false)}
        submitLabel="Save"
        placeholder="Add a summary comment…"
        suggestionSeed={null}
        autoFocus
        compact
      />
    </div>
  )

  return (
    <>
      <div
        className={cn(
          'hairline-t flex min-h-9 items-center gap-3 bg-panel px-3',
          active && 'draft-marker',
        )}
      >
        {active && draft !== null ? (
          <>
            <Popover open={pendingOpen} onOpenChange={setPendingOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="shrink-0 font-mono text-2xs">
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      pendingCount > 0 ? 'bg-draft' : 'bg-line-strong',
                    )}
                    aria-hidden
                  />
                  {pendingCount} pending
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" side="top" className="w-96 p-1">
                <PendingList
                  comments={draft.comments}
                  onJump={jumpToPending}
                  onRemove={(key) => actions.removeComment(key)}
                />
              </PopoverContent>
            </Popover>

            {bodyExpanded ? (
              composer
            ) : (
              <button
                type="button"
                onClick={expandBody}
                className="h-7 min-w-0 flex-1 truncate rounded-(--radius-sm) border border-line bg-canvas px-2 text-left text-sm hover:border-line-strong"
              >
                {draft.body.trim() !== '' ? (
                  <span className="text-ink">{firstBodyLine(draft.body)}</span>
                ) : (
                  <span className="text-ink-faint">Add a summary comment…</span>
                )}
              </button>
            )}

            <EventPicker
              value={draft.event}
              canApprove={canApprove}
              onChange={(event) => actions.setEvent(event)}
            />

            <div className="flex shrink-0 items-center gap-2">
              {dirty ? (
                <span className="text-2xs text-stale">not saved — retrying</span>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default text-2xs text-ink-faint" tabIndex={0}>
                      saved · broker
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-64">
                    Drafts live on the broker, keyed to you — invisible to GitHub and to
                    other contractors. They survive reloads, tomorrow, and a workspace
                    rebuild.
                  </TooltipContent>
                </Tooltip>
              )}
              <span className="hidden text-2xs text-ink-faint lg:inline">
                started {relativeTime(draft.createdAt)}
              </span>
              {discardConfirm.armed ? (
                <Button variant="danger" size="sm" onClick={handleDiscard}>
                  Discard{' '}
                  {pendingCount > 0
                    ? `${pendingCount} ${pendingCount === 1 ? 'comment' : 'comments'}`
                    : 'draft'}
                  ?
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={handleDiscard}>
                  Discard
                </Button>
              )}
              {submittable ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={submit.isPending}
                  onClick={() => void handleSubmit()}
                >
                  {submit.isPending && <Spinner size={12} label="Submitting review" />}
                  Submit review · {pendingCount}
                </Button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0}>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled
                        className="pointer-events-none"
                      >
                        Submit review · {pendingCount}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    A review needs at least a comment or a summary.
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </>
        ) : bodyExpanded ? (
          composer
        ) : (
          <>
            <p className="min-w-0 truncate text-2xs text-ink-faint">
              No review in progress — comment on any line (
              <span className="kbd">c</span>) or write a summary
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto shrink-0"
              onClick={expandBody}
            >
              Start review
            </Button>
          </>
        )}
      </div>

      {headMoved !== null && (
        <HeadMovedDialog
          prNumber={prNumber}
          open
          onOpenChange={(open) => {
            if (!open) setHeadMoved(null)
          }}
          draftHeadSha={snapshot.immutable.headSha}
          currentHeadSha={headMoved.currentHeadSha}
          newCommits={headMoved.newCommits}
          pendingCount={pendingCount}
          onReconciled={(report) => {
            setHeadMoved(null)
            setReconcileReport(report)
          }}
        />
      )}
      {reconcileReport !== null && (
        <ReconcileDialog
          prNumber={prNumber}
          report={reconcileReport}
          open
          onOpenChange={(open) => {
            if (!open) setReconcileReport(null)
          }}
        />
      )}
    </>
  )
}
ReviewBar.displayName = 'ReviewBar'

/**
 * Comment / Approve / Request changes as a segmented control. When the App
 * identity authored the PR, GitHub will refuse APPROVE and REQUEST_CHANGES —
 * those segments carry a lock and open an explanation with a way forward
 * instead of selecting, because a control that silently no-ops teaches
 * distrust.
 */
function EventPicker({
  value,
  canApprove,
  onChange,
}: {
  value: ReviewDraft['event']
  canApprove: boolean
  onChange: (event: ReviewDraft['event']) => void
}) {
  const [lockOpen, setLockOpen] = useState(false)

  const options: { value: ReviewDraft['event']; label: string }[] = [
    { value: 'COMMENT', label: 'Comment' },
    { value: 'APPROVE', label: 'Approve' },
    { value: 'REQUEST_CHANGES', label: 'Request changes' },
  ]

  return (
    <Popover open={lockOpen} onOpenChange={setLockOpen}>
      <PopoverAnchor asChild>
        <div
          role="radiogroup"
          aria-label="Review verdict"
          className="flex h-6 shrink-0 items-center overflow-hidden rounded-(--radius-sm) border border-line"
        >
          {options.map((option, index) => {
            const locked = option.value !== 'COMMENT' && !canApprove
            const selected = value === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => (locked ? setLockOpen(true) : onChange(option.value))}
                className={cn(
                  'flex h-full items-center gap-1 whitespace-nowrap px-2 text-2xs transition-colors',
                  index > 0 && 'border-l border-line',
                  selected ? 'bg-raised text-ink' : 'text-ink-mut hover:bg-raised/60 hover:text-ink',
                  locked && 'text-ink-faint hover:text-ink-mut',
                )}
              >
                {locked && <Lock size={11} strokeWidth={1.5} aria-hidden />}
                {option.label}
              </button>
            )
          })}
        </div>
      </PopoverAnchor>
      <PopoverContent align="end" side="top" className="w-72">
        <p className="text-sm font-medium text-ink">GitHub refuses self-review</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-mut">
          This PR was opened by the App identity every contractor shares, so it can't
          approve itself. Submit comments here — an org member (e.g. dkozlov) approves on
          github.com.
        </p>
        <Button
          variant="default"
          size="sm"
          className="mt-2"
          onClick={() => {
            onChange('COMMENT')
            setLockOpen(false)
          }}
        >
          Use Comment
        </Button>
      </PopoverContent>
    </Popover>
  )
}
