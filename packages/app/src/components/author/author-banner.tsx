import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { useFilesView } from '@/state/files-view'
import { usePullItem } from '@/state/queries'
import { useCurrentHuman } from '@/state/session'
import { authorBannerCopy } from '@/lib/mode-copy'
import type { ReviewState } from '@/lib/mode-copy'
import type { ReviewMode } from '@/lib/review-mode'

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

/** Everything the banner's visibility turns on, as plain values. */
export interface AuthorBannerVisibility {
  mode: ReviewMode
  /** Which human drove the shared identity to open the pull request; null if nobody did. */
  authorHumanId: string | null
  /** The human reading. */
  humanId: string
  state: ReviewState
  /** Threads still open on the review. */
  unresolved: number
}

/**
 * Whether the banner has anything to say about this review, decided as a pure
 * function so the rule is assertable without a query client, a session or a
 * router.
 *
 * The two kinds of review reach the same banner for different reasons.
 *
 * On a pull request it is an attribution: the work was opened by one shared
 * identity on behalf of a human, GitHub itself only ever sees the bot, and the
 * broker's record of which human drove it is the only place that fact exists.
 * So it shows to that human and to nobody else, whether or not anything is
 * waiting — an author with an empty queue is being told their queue is empty.
 *
 * A review of two local branches has no such record, because nothing was
 * opened anywhere. What survives is the trip the banner offers: it is the only
 * entry to the thread queue in the whole header, and walking feedback on your
 * own branch is the flow this kind of review exists for. So it is warranted by
 * having somewhere to go — threads still open — rather than by an attribution
 * that would be a claim about a pull request that does not exist.
 *
 * Both stop at a review that has stopped taking comments: there is nothing to
 * resolve on one, and the queue is a place to answer feedback rather than to
 * read it back.
 */
export function authorBannerVisible({
  mode,
  authorHumanId,
  humanId,
  state,
  unresolved,
}: AuthorBannerVisibility): boolean {
  if (state !== 'open') return false
  if (mode === 'local') return unresolved > 0
  return authorHumanId === humanId
}

/**
 * The entry into the thread queue, rendered by the review layout under the
 * header. The banner decides its own visibility and renders nothing when it
 * has none, so it can be stacked with the header's other banners without any
 * of them knowing about the others.
 *
 * The one action is "Walk threads": on the files page it opens the docked
 * queue directly; from any other tab it navigates to `/pr/{n}/files?queue=1`
 * and lets the files page open the queue (or show its sync invitation first if
 * the review was never synced).
 *
 * `mode` is required rather than derived here. Every surface inside a review
 * is handed the mode the layout derived once, so no two of them can disagree
 * about the same review — and a call site that forgets to pass it fails the
 * build instead of quietly rendering the wrong kind of review.
 */
export function AuthorBanner({ prNumber, mode }: { prNumber: number; mode: ReviewMode }) {
  const item = usePullItem(prNumber)
  const human = useCurrentHuman()
  const filesView = useFilesView()
  const navigate = useNavigate()

  if (!item) return null

  const unresolved = item.broker.unresolvedThreads
  const visible = authorBannerVisible({
    mode,
    authorHumanId: item.broker.authorHumanId,
    humanId: human.id,
    state: item.pull.state,
    unresolved,
  })
  if (!visible) return null

  const copy = authorBannerCopy(mode, unresolved)

  const walkThreads = () => {
    if (filesView) {
      filesView.setQueueOpen(true)
    } else {
      navigate(`/pr/${prNumber}/files?queue=1`)
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-(--radius-sm) border border-line bg-panel px-3 py-1.5 text-sm">
      {copy.lead !== undefined && (
        <span className="shrink-0 text-ink">{copy.lead}</span>
      )}
      {unresolved > 0 ? (
        <span className="min-w-0 truncate text-ink-mut">
          <span className="font-display font-bold text-ink">{unresolved}</span>{' '}
          {copy.waiting}
        </span>
      ) : (
        <span className="min-w-0 truncate text-ink-faint">{copy.waiting}</span>
      )}
      {unresolved > 0 && (
        <Button
          variant="primary"
          size="sm"
          className="ml-auto shrink-0"
          onClick={walkThreads}
        >
          {copy.action}
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
