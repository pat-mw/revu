import { Archive, ExternalLink } from 'lucide-react'
import { archivedPrUrl } from '@/lib/local-reviews'
import { supersededBannerCopy } from '@/lib/mode-copy'
import type { ReviewMode } from '@/lib/review-mode'
import { supersededBadgeShown } from '@/lib/review-mode'
import { useLocalReviewAnnotations } from '@/state/local-reviews'

/** Everything the banner's visibility turns on, as plain values. */
export interface SupersededVisibility {
  mode: ReviewMode
  /**
   * The pull request that came to cover this review's branch pair, `null`
   * while it is live, and `undefined` while nothing is known about it — which
   * is every review's state until the annotations behind it have been read,
   * and any review's state for good if that read never lands.
   */
  archivedPr: number | null | undefined
}

/**
 * Whether the banner has anything to say about this review, decided as a pure
 * function so the rule is assertable without a query client or a renderer.
 *
 * The same reading as the badge the inbox row draws, and deliberately the same
 * function: a review the list calls superseded and the header does not would
 * be two answers to one question, and the reader would have no way to tell
 * which is the true one.
 *
 * There is no branch for "not known yet". A review whose annotations have not
 * arrived takes exactly the path a live review takes and draws nothing —
 * anything else would put a supersession notice, or the gap where one goes,
 * under every local review on every load and then take it back.
 *
 * Written as a type predicate so that the one state it admits carries a number
 * for the rest of the component to render, rather than leaving a cast behind
 * that could outlive the check it came from.
 */
export function supersededBannerVisible(
  visibility: SupersededVisibility,
): visibility is SupersededVisibility & { archivedPr: number } {
  return supersededBadgeShown(visibility)
}

/** What the banner draws, once it has decided to draw. */
export interface SupersededBannerProps extends SupersededVisibility {
  /**
   * The repository this review's workspace records, from which the link to the
   * pull request is derived. `undefined` while unread — the notice still names
   * the number, because the number is the reader's way to find the work that
   * took over and it is true whether or not a link can be built.
   */
  repo: string | undefined
}

/**
 * The notice saying a review has been taken over by a pull request, rendered by
 * the review layout at the head of the stack under the header.
 *
 * First in that stack because it is the widest claim on the screen: everything
 * else the header says — what the review does not cover, what it is waiting on
 * — is said about a review that can still be written to, and this one says it
 * cannot.
 *
 * Props-only, and that is what makes it assertable: it decides its own
 * visibility from two plain values and renders nothing when it has none, so
 * every state it has — including the ones that draw no element — is a fact a
 * test reads off real markup rather than a promise about a branch buried in a
 * page.
 *
 * The link is present only when the repository identity can name a pull
 * request. A workspace with no remote records an absolute path as its identity,
 * and the alternative to omitting the link there is a plausible-looking link
 * into a stranger's namespace built out of the reader's own home directory. The
 * number stays either way; it is derived rather than stored, so the two
 * renderings cannot disagree about which pull request it is.
 *
 * The tint is on the mark alone, and it is the quiet one. This review ended the
 * way a review should end — the work moved on to a pull request — so the panel
 * is the same one every other banner uses and nothing here is coloured as an
 * alarm.
 */
export function SupersededBanner({ mode, archivedPr, repo }: SupersededBannerProps) {
  const visibility = { mode, archivedPr }
  if (!supersededBannerVisible(visibility)) return null
  const pr = visibility.archivedPr
  const copy = supersededBannerCopy(mode, pr)
  if (copy === null) return null
  const href = repo === undefined ? null : archivedPrUrl(repo, pr)
  const label = `#${pr}`
  return (
    <div className="flex items-start gap-2 rounded-(--radius-sm) border border-line bg-panel px-3 py-1.5 text-sm">
      <Archive
        size={14}
        strokeWidth={1.5}
        className="mt-0.5 flex-none text-ink-mut"
        aria-hidden
      />
      <p className="min-w-0 text-ink">
        {copy.title} <span className="text-ink-mut">{copy.hint}</span>{' '}
        {href === null ? (
          // No link to give, so the number is drawn as the plain text it is —
          // dimmed, because there is nothing here to click.
          <span className="whitespace-nowrap font-mono text-ink-faint">{label}</span>
        ) : (
          // Focus is drawn globally by `:focus-visible`, so nothing here
          // suppresses the outline and the anchor needs no ring of its own.
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-ink underline underline-offset-2 hover:text-ink-mut"
          >
            {label}
            <ExternalLink size={11} strokeWidth={1.5} aria-hidden />
          </a>
        )}
      </p>
    </div>
  )
}
SupersededBanner.displayName = 'SupersededBanner'

/**
 * The banner for one review, with the annotation read attached.
 *
 * The split is deliberate: this holds the hook and the component above holds
 * the decision. A component that reached for its own query could not be
 * rendered in a test at all, and the states in which this banner must draw
 * nothing are precisely the ones worth asserting.
 *
 * Which pull request superseded a review, and which repository it lives in,
 * are read from the per-review annotations and from nowhere else. The list a
 * review's row comes from carries neither, and it could not: it describes
 * reviews whose repository is the one they were fetched from. A review with no
 * annotation — the read has not landed, or this is not the kind of review that
 * has one — reads as `undefined`, which the decision above treats as "nothing
 * to say".
 */
export function ReviewSupersededBanner({
  prNumber,
  mode,
}: {
  prNumber: number
  mode: ReviewMode
}) {
  const annotations = useLocalReviewAnnotations()
  const summary = annotations.data?.find((s) => s.id === prNumber)
  return (
    <SupersededBanner mode={mode} archivedPr={summary?.archivedPr} repo={summary?.repo} />
  )
}
ReviewSupersededBanner.displayName = 'ReviewSupersededBanner'
