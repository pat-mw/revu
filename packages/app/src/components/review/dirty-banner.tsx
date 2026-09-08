import { AlertTriangle } from 'lucide-react'
import { dirtyWorktreeCopy } from '@/lib/mode-copy'
import type { ReviewMode } from '@/lib/review-mode'
import { useLocalReviewAnnotations } from '@/state/local-reviews'

/** Everything the banner's visibility turns on, as plain values. */
export interface DirtyWorktreeVisibility {
  mode: ReviewMode
  /**
   * Whether the working tree held uncommitted changes when this review was last
   * read, or `undefined` while nothing is known about it — which is every
   * review's state until the annotations behind it have been read, and any
   * review's state for good if that read never lands.
   */
  dirty: boolean | undefined
}

/**
 * Whether the banner has anything to say about this review, decided as a pure
 * function so the rule is assertable without a query client or a renderer.
 *
 * An affirmative reading is the entire condition, and the shape is the point.
 * There is no branch for "not known yet": a review whose annotations have not
 * arrived takes exactly the path a review with a clean working tree takes, and
 * draws nothing. Anything else — a skeleton, an optimistic "clean" line, an
 * empty box holding the space — would put an uncommitted-changes claim, or the
 * gap where one goes, under the header of every review on every load and then
 * take it back a moment later. A banner that arrives late is a smaller failure
 * than one that flickers a false claim at everyone, and with no loading branch
 * in the function the flicker cannot be reintroduced by accident.
 *
 * A review with a pull request behind it is built from what was pushed, so no
 * working tree on this machine bears on what it contains, whatever the flag
 * says.
 */
export function dirtyWorktreeBannerVisible({ mode, dirty }: DirtyWorktreeVisibility): boolean {
  return mode === 'local' && dirty === true
}

/**
 * The banner saying a review does not cover everything on disk, rendered by the
 * review layout in the stack under the header.
 *
 * Props-only, and that is what makes it assertable: it decides its own
 * visibility from two plain values and renders nothing when it has none, so
 * every state it has — including the three that draw no element — is a fact a
 * test can read off real markup rather than a promise about a branch buried in
 * a page. It also lets the banner join the header's stack without any other
 * member knowing about it: the slot collapses when all of them return null, and
 * the spacing between them belongs to the slot rather than to any one banner.
 *
 * The tint is on the mark alone. Gold reads as "the thing you are looking at is
 * behind something else", which is exactly the fact here, while the surface
 * stays the quiet panel every other banner uses so this one cannot be mistaken
 * for the snapshot seal one row below — that one reports time moving under the
 * review, and this one reports content that never entered it.
 */
export function DirtyWorktreeBanner({ mode, dirty }: DirtyWorktreeVisibility) {
  const copy = dirtyWorktreeBannerVisible({ mode, dirty }) ? dirtyWorktreeCopy(mode) : null
  if (copy === null) return null
  return (
    <div className="flex items-start gap-2 rounded-(--radius-sm) border border-line bg-panel px-3 py-1.5 text-sm">
      <AlertTriangle
        size={14}
        strokeWidth={1.5}
        className="mt-0.5 flex-none text-stale"
        aria-hidden
      />
      <p className="min-w-0 text-ink">
        {copy.title} <span className="text-ink-mut">{copy.hint}</span>
      </p>
    </div>
  )
}
DirtyWorktreeBanner.displayName = 'DirtyWorktreeBanner'

/**
 * The banner for one review, with the annotation read attached.
 *
 * The split is deliberate: this holds the hook and the component above holds
 * the decision. A component that reached for its own query could not be
 * rendered in a test at all, and the three states in which this banner must
 * draw nothing are precisely the states worth asserting.
 *
 * Whether the working tree was dirty is read from the per-review annotations
 * and from nowhere else. The list a review's row comes from carries no such
 * field, and it could not: it describes reviews that have no working tree
 * behind them at all. A review with no annotation — the read has not landed, or
 * this is not the kind of review that has one — reads as `undefined`, which the
 * decision above treats as "nothing to say".
 */
export function ReviewDirtyBanner({
  prNumber,
  mode,
}: {
  prNumber: number
  mode: ReviewMode
}) {
  const annotations = useLocalReviewAnnotations()
  const dirty = annotations.data?.find((summary) => summary.id === prNumber)?.dirty
  return <DirtyWorktreeBanner mode={mode} dirty={dirty} />
}
ReviewDirtyBanner.displayName = 'ReviewDirtyBanner'
