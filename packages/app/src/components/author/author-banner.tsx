import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { useFilesView } from '@/state/files-view'
import { usePullItem } from '@/state/queries'
import { useCurrentHuman } from '@/state/session'

/**
 * A key hint chip legible on the violet primary button: translucent canvas
 * fill instead of the raised `.kbd` treatment, so the chip reads as part of
 * the button rather than a control of its own.
 */
function HintChip({ label }: { label: string }) {
  return (
    <span className="flex h-4 min-w-4 items-center justify-center rounded-(--radius-xs) border border-canvas/20 bg-canvas/15 px-1 font-mono text-2xs font-normal leading-none">
      {label}
    </span>
  )
}

/**
 * Author-mode entry point, rendered by the PR layout under the header. The
 * banner decides its own visibility: it shows only when the session human is
 * the one who drove the shared App identity to open this PR (broker-side
 * attribution — GitHub itself only ever sees the bot) and the PR is still
 * open. For everyone else, and for closed/merged PRs, it renders nothing.
 *
 * With unresolved feedback waiting, the one action is "Walk threads": on the
 * files page it opens the docked queue directly; from any other tab it
 * navigates to `/pr/{n}/files?queue=1` and lets the files page open the queue
 * (or show its sync invitation first if the PR was never synced).
 */
export function AuthorBanner({ prNumber }: { prNumber: number }) {
  const item = usePullItem(prNumber)
  const human = useCurrentHuman()
  const filesView = useFilesView()
  const navigate = useNavigate()

  if (!item) return null
  if (item.broker.authorHumanId !== human.id || item.pull.state !== 'open') return null

  const unresolved = item.broker.unresolvedThreads

  const walkThreads = () => {
    if (filesView) {
      filesView.setQueueOpen(true)
    } else {
      navigate(`/pr/${prNumber}/files?queue=1`)
    }
  }

  return (
    <div className="my-2 flex items-center gap-3 rounded-(--radius-sm) border border-line bg-panel px-3 py-1.5 text-sm">
      <span className="shrink-0 text-ink">You authored this PR</span>
      {unresolved > 0 ? (
        <span className="min-w-0 truncate text-ink-mut">
          <span className="font-display font-bold text-ink">{unresolved}</span> unresolved{' '}
          thread{unresolved === 1 ? '' : 's'} waiting on you
        </span>
      ) : (
        <span className="min-w-0 truncate text-ink-faint">no unresolved threads — clear</span>
      )}
      {unresolved > 0 && (
        <Button
          variant="primary"
          size="sm"
          className="ml-auto shrink-0"
          onClick={walkThreads}
        >
          Walk threads
          <span className="flex items-center gap-0.5" aria-hidden>
            <HintChip label="j" />
            <HintChip label="k" />
          </span>
        </Button>
      )}
    </div>
  )
}
AuthorBanner.displayName = 'AuthorBanner'
