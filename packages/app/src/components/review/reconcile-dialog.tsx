import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronRight, MoveVertical, Undo2, XCircle } from 'lucide-react'
import { api } from '@/api'
import type { AnchorResult, CommitInfo, PendingComment, ReconcileReport } from '@revu/shared'
import { selectAnchorBlobSha } from '@revu/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { blobLines } from '@/lib/diff'
import { relativeTime, shortSha } from '@/lib/time'
import { useDraft, useDraftActions, useReconcile, useSubmitReview } from '@/state/drafts'
import { qk, useBlob, useSnapshot, useSyncPull } from '@/state/queries'
import { describeApiError } from './error-copy'
import { firstBodyLine } from './pending-list'

/**
 * The per-comment verdict a human hands down in the reconcile dialog. Every
 * comment in the report must carry one before Apply enables:
 *
 * - `keep`     — clean rows, pre-decided: the anchor line is untouched.
 * - `accept`   — take the drifted anchor's suggested new line.
 * - `reanchor` — pin the comment to an explicitly chosen line on the new head.
 * - `drop`     — remove the comment from the draft (reversible until Apply).
 */
export type ReconcileDecision =
  | { kind: 'keep' }
  | { kind: 'accept' }
  | { kind: 'reanchor'; line: number }
  | { kind: 'drop' }

export interface ReconcileDialogProps {
  prNumber: number
  report: ReconcileReport
  open: boolean
  onOpenChange: (open: boolean) => void
}

type CleanResult = Extract<AnchorResult, { kind: 'clean' }>
type DriftedResult = Extract<AnchorResult, { kind: 'drifted' }>
type LostResult = Extract<AnchorResult, { kind: 'lost' }>

/** Clean rows need no human decision; everything else starts undecided. */
function initialDecisions(
  report: ReconcileReport,
): Record<string, ReconcileDecision | undefined> {
  const map: Record<string, ReconcileDecision | undefined> = {}
  for (const result of report.results) {
    if (result.kind === 'clean') map[result.comment.key] = { kind: 'keep' }
  }
  return map
}

/**
 * Re-capture an anchor at `line` (1-based) from blob content: the exact line
 * text plus up to three neighbors each side, in file order — the last element
 * of `contextBefore` is the line immediately above, the first element of
 * `contextAfter` is the line immediately below.
 */
function captureAnchor(lines: string[], line: number): PendingComment['anchor'] {
  return {
    lineText: lines[line - 1] ?? '',
    contextBefore: lines.slice(Math.max(0, line - 4), Math.max(0, line - 1)),
    contextAfter: lines.slice(line, line + 3),
  }
}

const LOST_REASON: Record<LostResult['reason'], string> = {
  'line-deleted': 'that line no longer exists',
  'file-deleted': 'the file was deleted',
  'file-renamed': 'the file was renamed',
  'file-added': 'that file is new — it has no base version to anchor to',
}

/**
 * The trust screen. After a re-sync, every pending comment is shown with its
 * captured anchor context and its classification against the new head —
 * clean, drifted, or lost — and nothing is mutated or dropped without an
 * explicit per-row decision. Cancel closes with the draft byte-identical;
 * Apply commits the decisions to the draft (re-captured anchors included),
 * flushes, and re-submits against the new head. A second head-move during
 * apply loops back through sync + reconcile into a fresh report instead of
 * failing.
 *
 * The backdrop is deliberately inert: a mis-click must not eat an
 * eleven-comment decision session. Closing requires the explicit Cancel, the
 * corner X, or Escape (blocked while a submit is in flight).
 */
export function ReconcileDialog({
  prNumber,
  report,
  open,
  onOpenChange,
}: ReconcileDialogProps) {
  const queryClient = useQueryClient()
  const snapshot = useSnapshot(prNumber).data ?? null
  const draft = useDraft(prNumber).data ?? null
  const actions = useDraftActions(prNumber)
  const submit = useSubmitReview(prNumber)
  const sync = useSyncPull(prNumber)
  const reconcile = useReconcile(prNumber)
  const { toast } = useToast()

  const [live, setLive] = useState<ReconcileReport>(report)
  const [decisions, setDecisions] = useState<Record<string, ReconcileDecision | undefined>>(
    () => initialDecisions(report),
  )
  const [busy, setBusy] = useState(false)
  const [commitsOpen, setCommitsOpen] = useState(false)

  // A new report prop (or a re-open) resets local state. The internal
  // moved-again loop replaces `live` directly and never touches the prop.
  useEffect(() => {
    if (!open) return
    setLive(report)
    setDecisions(initialDecisions(report))
  }, [open, report])

  const groups = useMemo(
    () => ({
      clean: live.results.filter((r): r is CleanResult => r.kind === 'clean'),
      drifted: live.results.filter((r): r is DriftedResult => r.kind === 'drifted'),
      lost: live.results.filter((r): r is LostResult => r.kind === 'lost'),
    }),
    [live],
  )

  const total = live.results.length
  const decidedCount = live.results.filter(
    (r) => decisions[r.comment.key] !== undefined,
  ).length
  const allDecided = decidedCount === total

  const decide = (key: string, decision: ReconcileDecision | undefined) => {
    setDecisions((prev) => ({ ...prev, [key]: decision }))
  }

  /**
   * The blob a comment's anchor text lives in on the freshly synced snapshot,
   * chosen through the shared side selector so the blob shown for re-anchor
   * matches the one the reconcile report classified against.
   */
  const blobShaFor = (comment: PendingComment): string | null =>
    selectAnchorBlobSha(snapshot?.immutable.blobIndex[comment.path], comment.side)

  const apply = async () => {
    if (!draft || !allDecided || busy) return
    setBusy(true)
    try {
      let kept = 0
      let dropped = 0
      const updated: PendingComment[] = []
      for (const comment of draft.comments) {
        const decision = decisions[comment.key]
        const result = live.results.find((r) => r.comment.key === comment.key)
        if (!decision || !result) {
          // Written after this report was generated — carried along untouched.
          updated.push(comment)
          kept++
          continue
        }
        if (decision.kind === 'drop') {
          actions.removeComment(comment.key)
          dropped++
          continue
        }
        if (decision.kind === 'keep') {
          updated.push(comment)
          kept++
          continue
        }
        const newLine =
          decision.kind === 'accept'
            ? result.kind === 'drifted'
              ? result.newLine
              : comment.line
            : decision.line
        const newStartLine =
          decision.kind === 'accept'
            ? result.kind === 'drifted'
              ? result.newStartLine
              : comment.start_line
            : comment.start_line !== null
              ? Math.max(1, comment.start_line + (decision.line - comment.line))
              : null
        const sha = blobShaFor(comment)
        const blob = sha
          ? await queryClient.fetchQuery({
              queryKey: qk.blob(sha),
              queryFn: () => api.getBlob(sha),
              staleTime: Infinity,
              gcTime: Infinity,
            })
          : null
        const lines = blob && !blob.binary ? blobLines(blob.content) : []
        const next: PendingComment = {
          ...comment,
          line: newLine,
          start_line: newStartLine,
          anchor: captureAnchor(lines, newLine),
          updatedAt: new Date().toISOString(),
        }
        actions.upsertComment(next)
        updated.push(next)
        kept++
      }
      await actions.flush()
      const outcome = await submit.mutateAsync({
        prNumber,
        expectedHeadSha: live.currentHeadSha,
        event: draft.event,
        body: draft.body,
        comments: updated,
      })
      if (outcome.status === 'ok') {
        toast({
          kind: 'success',
          title: 'Review posted after reconcile',
          detail: `${kept} kept, ${dropped} dropped — one API call.`,
        })
        onOpenChange(false)
      } else if (outcome.status === 'head_moved') {
        toast({
          title: 'It moved again — re-syncing.',
          detail: `${outcome.newCommits} more ${
            outcome.newCommits === 1 ? 'commit' : 'commits'
          } landed mid-reconcile.`,
        })
        await sync.mutateAsync()
        const fresh = await reconcile.mutateAsync()
        setLive(fresh)
        setDecisions(initialDecisions(fresh))
      } else {
        toast({ kind: 'error', title: outcome.reason })
      }
    } catch (error) {
      toast({
        kind: 'error',
        title: describeApiError(error),
        detail: 'Your reconciled draft is saved on the broker — nothing was lost.',
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
      <DialogContent
        className="max-w-2xl"
        aria-describedby={undefined}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Reconcile your review</DialogTitle>
          <div className="flex items-center gap-2 font-mono text-2xs text-ink-mut">
            <span>
              {shortSha(live.draftHeadSha)} → {shortSha(live.currentHeadSha)} ·{' '}
              {live.newCommits.length} new{' '}
              {live.newCommits.length === 1 ? 'commit' : 'commits'}
            </span>
            <button
              type="button"
              onClick={() => setCommitsOpen((o) => !o)}
              aria-expanded={commitsOpen}
              className="inline-flex items-center gap-0.5 text-ink-faint hover:text-ink"
            >
              <ChevronRight
                size={12}
                strokeWidth={1.5}
                className={cn('transition-transform', commitsOpen && 'rotate-90')}
                aria-hidden
              />
              {commitsOpen ? 'hide' : 'show'}
            </button>
          </div>
          {commitsOpen && <CommitList commits={live.newCommits} />}
        </DialogHeader>

        <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto pr-1">
          {groups.clean.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
                Anchors cleanly · {groups.clean.length}
              </h3>
              {groups.clean.map((result) => (
                <CleanRow key={result.comment.key} result={result} />
              ))}
            </section>
          )}
          {groups.drifted.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
                Drifted · {groups.drifted.length}
              </h3>
              {groups.drifted.map((result) => (
                <DriftedRow
                  key={result.comment.key}
                  result={result}
                  decision={decisions[result.comment.key]}
                  onDecide={(d) => decide(result.comment.key, d)}
                  blobSha={blobShaFor(result.comment)}
                />
              ))}
            </section>
          )}
          {groups.lost.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
                Lost · {groups.lost.length}
              </h3>
              {groups.lost.map((result) => (
                <LostRow
                  key={result.comment.key}
                  result={result}
                  decision={decisions[result.comment.key]}
                  onDecide={(d) => decide(result.comment.key, d)}
                  blobSha={blobShaFor(result.comment)}
                />
              ))}
            </section>
          )}
          {total === 0 && (
            <p className="py-2 text-center text-xs text-ink-faint">
              No pending comments to reconcile — Apply will submit the summary
              against the new head.
            </p>
          )}
        </div>

        <DialogFooter>
          <span className="mr-auto text-2xs text-ink-faint">
            {decidedCount}/{total} decided · Cancel keeps the draft untouched
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void apply()}
            disabled={!allDecided || busy || draft === null}
          >
            {busy && <Spinner size={12} label="Submitting" />}
            Apply &amp; submit review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
ReconcileDialog.displayName = 'ReconcileDialog'

function CommitList({ commits }: { commits: CommitInfo[] }) {
  if (commits.length === 0) {
    return (
      <p className="text-2xs text-ink-faint">
        The compare changed without new head commits — the base branch moved.
      </p>
    )
  }
  return (
    <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
      {commits.map((commit) => (
        <li key={commit.sha} className="flex items-baseline gap-2 text-2xs">
          <code className="shrink-0 font-mono text-ink-faint">{shortSha(commit.sha)}</code>
          <span className="min-w-0 truncate text-ink-mut">
            {commit.commit.message.split('\n')[0]}
          </span>
          <span className="ml-auto shrink-0 text-ink-faint">
            {relativeTime(commit.commit.author.date)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The captured anchor neighborhood: the anchor line in full ink between its
 * dimmed context lines, in the diff monospace on the canvas surface so it
 * reads as "the code you commented on", not UI chrome.
 */
function AnchorContext({ anchor }: { anchor: PendingComment['anchor'] }) {
  return (
    <div className="mt-1.5 overflow-hidden rounded-(--radius-xs) border border-line bg-canvas px-2 py-1 font-mono text-code leading-relaxed">
      {anchor.contextBefore.map((line, i) => (
        <div
          key={`before-${i}`}
          className="overflow-hidden text-ellipsis whitespace-pre text-ink-faint"
        >
          {line || ' '}
        </div>
      ))}
      <div className="overflow-hidden text-ellipsis whitespace-pre text-ink">
        {anchor.lineText || ' '}
      </div>
      {anchor.contextAfter.map((line, i) => (
        <div
          key={`after-${i}`}
          className="overflow-hidden text-ellipsis whitespace-pre text-ink-faint"
        >
          {line || ' '}
        </div>
      ))}
    </div>
  )
}

function CleanRow({ result }: { result: CleanResult }) {
  return (
    <div className="rounded-(--radius-sm) border border-line px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-2xs">
        <CheckCircle2 size={14} strokeWidth={1.5} className="shrink-0 text-add" aria-hidden />
        <span className="min-w-0 truncate font-mono text-ink-mut">{result.comment.path}</span>
        <span className="shrink-0 text-add">
          anchors cleanly at line {result.comment.line}
        </span>
      </div>
      <p className="mt-1 truncate text-xs text-ink">{firstBodyLine(result.comment.body)}</p>
      <AnchorContext anchor={result.comment.anchor} />
    </div>
  )
}

function DriftedRow({
  result,
  decision,
  onDecide,
  blobSha,
}: {
  result: DriftedResult
  decision: ReconcileDecision | undefined
  onDecide: (decision: ReconcileDecision | undefined) => void
  blobSha: string | null
}) {
  const blob = useBlob(blobSha)
  const lines = useMemo(
    () => (blob.data && !blob.data.binary ? blobLines(blob.data.content) : null),
    [blob.data],
  )
  const newLineText = lines !== null ? (lines[result.newLine - 1] ?? null) : null
  const struck = decision?.kind === 'drop'

  return (
    <div className={cn('rounded-(--radius-sm) border border-line px-2.5 py-2', struck && 'opacity-60')}>
      <div className="flex items-center gap-1.5 text-2xs">
        <MoveVertical size={14} strokeWidth={1.5} className="shrink-0 text-stale" aria-hidden />
        <span className="min-w-0 truncate font-mono text-ink-mut">{result.comment.path}</span>
        <span className="shrink-0 font-mono text-stale">
          line {result.comment.line} → {result.newLine} ({result.delta > 0 ? '+' : ''}
          {result.delta})
        </span>
      </div>
      <p className={cn('mt-1 truncate text-xs text-ink', struck && 'line-through')}>
        {firstBodyLine(result.comment.body)}
      </p>
      <AnchorContext anchor={result.comment.anchor} />
      <div className="mt-1.5 flex items-baseline gap-1.5 text-2xs">
        <span className="shrink-0 text-ink-faint">now at {result.newLine}:</span>
        {newLineText !== null ? (
          <code className="min-w-0 overflow-hidden text-ellipsis whitespace-pre font-mono text-code text-ink">
            {newLineText || ' '}
          </code>
        ) : blob.isLoading ? (
          <span className="skeleton inline-block h-3 w-40" aria-hidden />
        ) : (
          <span className="text-ink-faint">line text unavailable</span>
        )}
      </div>
      <DecisionActions
        decision={decision}
        onDecide={onDecide}
        lines={lines}
        comment={result.comment}
        acceptLabel="Accept new line"
      />
    </div>
  )
}

function LostRow({
  result,
  decision,
  onDecide,
  blobSha,
}: {
  result: LostResult
  decision: ReconcileDecision | undefined
  onDecide: (decision: ReconcileDecision | undefined) => void
  blobSha: string | null
}) {
  const blob = useBlob(blobSha)
  const lines = useMemo(
    () => (blob.data && !blob.data.binary ? blobLines(blob.data.content) : null),
    [blob.data],
  )
  const struck = decision?.kind === 'drop'

  return (
    <div className={cn('rounded-(--radius-sm) border border-line px-2.5 py-2', struck && 'opacity-60')}>
      <div className="flex items-center gap-1.5 text-2xs">
        <XCircle size={14} strokeWidth={1.5} className="shrink-0 text-danger" aria-hidden />
        <span className="min-w-0 truncate font-mono text-ink-mut">{result.comment.path}</span>
        <span className="shrink-0 text-danger">{LOST_REASON[result.reason]}</span>
      </div>
      <p className={cn('mt-1 truncate text-xs text-ink', struck && 'line-through')}>
        {firstBodyLine(result.comment.body)}
      </p>
      <AnchorContext anchor={result.comment.anchor} />
      <DecisionActions
        decision={decision}
        onDecide={onDecide}
        lines={lines}
        comment={result.comment}
      />
    </div>
  )
}

/**
 * The per-row decision strip. Drifted rows lead with the recommended
 * "Accept new line"; lost rows offer only re-anchor (when the file still has
 * content to anchor to) and drop. A dropped row shows an Undo — decisions are
 * reversible until Apply.
 */
function DecisionActions({
  decision,
  onDecide,
  lines,
  comment,
  acceptLabel,
}: {
  decision: ReconcileDecision | undefined
  onDecide: (decision: ReconcileDecision | undefined) => void
  lines: string[] | null
  comment: PendingComment
  /** Present only when an accept target exists (drifted rows). */
  acceptLabel?: string
}) {
  const [editorOpen, setEditorOpen] = useState(false)

  if (decision?.kind === 'drop') {
    return (
      <div className="mt-1.5 flex items-center gap-2 text-2xs">
        <span className="text-danger">will be dropped</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-2xs [&_svg]:size-3"
          onClick={() => onDecide(undefined)}
        >
          <Undo2 strokeWidth={1.5} aria-hidden />
          Undo
        </Button>
      </div>
    )
  }

  const acceptSelected = decision?.kind === 'accept'
  const reanchorSelected = decision?.kind === 'reanchor'
  const canReanchor = lines !== null && lines.length > 0

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label="Decide what happens to this comment"
      >
        {acceptLabel !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-5 px-1.5 text-2xs',
              acceptSelected
                ? 'border border-line-strong bg-raised text-ink'
                : decision === undefined
                  ? 'border border-line text-ink'
                  : 'text-ink-mut',
            )}
            aria-pressed={acceptSelected}
            onClick={() => {
              setEditorOpen(false)
              onDecide({ kind: 'accept' })
            }}
          >
            {acceptLabel}
          </Button>
        )}
        {canReanchor && (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-5 px-1.5 text-2xs',
              reanchorSelected && 'border border-line-strong bg-raised text-ink',
            )}
            aria-pressed={reanchorSelected}
            aria-expanded={editorOpen}
            onClick={() => setEditorOpen((o) => !o)}
          >
            {reanchorSelected ? `Re-anchored to ${decision.line}` : 'Re-anchor…'}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-2xs text-ink-mut hover:text-danger"
          onClick={() => {
            setEditorOpen(false)
            onDecide({ kind: 'drop' })
          }}
        >
          Drop
        </Button>
      </div>
      {editorOpen && lines !== null && (
        <ReanchorEditor
          lines={lines}
          initialLine={reanchorSelected ? decision.line : comment.line}
          onSet={(line) => {
            onDecide({ kind: 'reanchor', line })
            setEditorOpen(false)
          }}
        />
      )}
    </div>
  )
}

/** Line-number picker with a live preview of the chosen line's text. */
function ReanchorEditor({
  lines,
  initialLine,
  onSet,
}: {
  lines: string[]
  initialLine: number
  onSet: (line: number) => void
}) {
  const [value, setValue] = useState(() =>
    String(Math.min(Math.max(initialLine, 1), lines.length)),
  )
  const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= lines.length

  return (
    <div className="flex items-center gap-2">
      <label className="flex shrink-0 items-center gap-1.5 text-2xs text-ink-mut">
        line
        <Input
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          min={1}
          max={lines.length}
          className="h-6 w-20 font-mono text-xs"
          aria-label={`New line number, between 1 and ${lines.length}`}
        />
      </label>
      {valid ? (
        <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre font-mono text-code text-ink">
          {lines[parsed - 1] || ' '}
        </code>
      ) : (
        <span className="flex-1 text-2xs text-danger">no such line</span>
      )}
      <Button
        variant="default"
        size="sm"
        className="h-5 shrink-0 px-1.5 text-2xs"
        disabled={!valid}
        onClick={() => onSet(parsed)}
      >
        Set
      </Button>
    </div>
  )
}
