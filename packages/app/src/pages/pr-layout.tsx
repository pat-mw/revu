import { useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router'
import { Download, Inbox, RefreshCw } from 'lucide-react'
import type {
  ApiError,
  CommentIdentity,
  PullDetail,
  PullSummary,
  Snapshot,
  StalenessInfo,
} from '@revu/shared'
import { identityName, parseCommentIdentity } from '@revu/shared'
import { usePullList, useSnapshot, useStaleness, useSyncPull } from '@/state/queries'
import { useSession } from '@/state/session'
import { countChecks } from '@/lib/checks-rollup'
import type { CheckCounts } from '@/lib/checks-rollup'
import { notFoundCopy, stateChipCopy, syncCostCopy } from '@/lib/mode-copy'
import type { ReviewState } from '@/lib/mode-copy'
import { reviewMode, reviewTabs } from '@/lib/review-mode'
import type { ReviewMode, ReviewTab } from '@/lib/review-mode'
import { minutesUntil, relativeTime, shortSha } from '@/lib/time'
import { useShortcut } from '@/lib/keyboard'
import { cn } from '@/lib/cn'
import { IdentityAvatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ReviewBar } from '@/components/review/review-bar'
import { ReviewDirtyBanner } from '@/components/review/dirty-banner'
import { AuthorBanner } from '@/components/author/author-banner'

/**
 * The PR shell: header (title row, meta row, snapshot seal + tab strip),
 * the routed tab body, and the review bar pinned to the bottom.
 *
 * The header's signature element is the snapshot seal — the offline-first
 * contract made visible. It is quiet when the local snapshot matches the
 * remote, gold with an action when time moved underneath it, and carries a
 * danger accent when a sync died partway.
 */

// ————————————————————————————————————————————————————————————————
// Sync action — shared by the seal here and by the per-tab sync gates.
// ————————————————————————————————————————————————————————————————

/** Honest failure copy for a sync that didn't land. Cached data is never touched. */
function syncFailureCopy(error: ApiError): { title: string; detail: string } {
  if (error.code === 'rate_limited' && error.resetAt) {
    return {
      title: `Rate limit exhausted. Resets in ${minutesUntil(error.resetAt)} minutes.`,
      detail: 'Cached data is untouched.',
    }
  }
  return { title: error.message, detail: 'Cached data is untouched.' }
}

/**
 * Runs the sync burst with the app's standard toasts: failures name the error
 * and reassure that the cache is intact; successes always carry the sync-stats
 * line ("N blobs fetched, M reused") — the visible proof that blobs are
 * content-addressed and a re-sync only pays for what actually changed.
 */
export function useSyncAction(prNumber: number): { run: () => void; isPending: boolean } {
  const { mutate, isPending } = useSyncPull(prNumber)
  const { toast } = useToast()
  const run = useCallback(() => {
    mutate(undefined, {
      onSuccess: (snapshot) => {
        const stats = snapshot.syncStats
        toast({
          kind: 'success',
          title: 'Snapshot updated',
          detail: stats
            ? `${stats.blobsFetched} blobs fetched, ${stats.blobsReused} reused (content-addressed)`
            : undefined,
        })
      },
      onError: (error) => {
        toast({ kind: 'error', ...syncFailureCopy(error) })
      },
    })
  }, [mutate, toast])
  return { run, isPending }
}

/**
 * The "never synced" gate the Conversation/Commits/Checks tabs show: an
 * invitation whose one action is the sync burst, with the standard toasts.
 */
export function SyncEmptyState({
  prNumber,
  title,
  hint,
  icon,
}: {
  prNumber: number
  title: string
  hint?: string
  icon?: ReactNode
}) {
  const { run, isPending } = useSyncAction(prNumber)
  return (
    <EmptyState
      icon={icon}
      title={title}
      hint={hint}
      action={
        <Button onClick={run} disabled={isPending}>
          {isPending ? (
            <Spinner size={12} label="Syncing" />
          ) : (
            <Download size={14} strokeWidth={1.5} aria-hidden />
          )}
          {isPending ? 'Syncing…' : 'Sync'}
        </Button>
      }
    />
  )
}

// ————————————————————————————————————————————————————————————————
// The snapshot seal
// ————————————————————————————————————————————————————————————————

function SnapshotSeal({
  mode,
  snapshot,
  loading,
  staleness,
  syncing,
  onSync,
}: {
  /** Which kind of review the seal is on — only the sync's cost differs by it. */
  mode: ReviewMode
  /** `undefined` while the snapshot query loads; `null` means never synced. */
  snapshot: Snapshot | null | undefined
  loading: boolean
  staleness: StalenessInfo | null
  syncing: boolean
  onSync: () => void
}) {
  if (syncing) {
    return (
      <span className="seal">
        <Spinner size={12} label="Syncing" />
        syncing…
      </span>
    )
  }
  if (loading) {
    return <Skeleton className="h-6 w-44" />
  }
  if (!snapshot) {
    return (
      <span className="seal">
        never synced
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" onClick={onSync}>
              <Download size={14} strokeWidth={1.5} aria-hidden />
              Sync
            </Button>
          </TooltipTrigger>
          <TooltipContent>{syncCostCopy(mode)}</TooltipContent>
        </Tooltip>
      </span>
    )
  }
  if (snapshot.partial) {
    const missing = snapshot.partial.missingBlobShas.length
    return (
      <span className="seal">
        <span className="text-danger">
          partial snapshot — {missing} blob{missing === 1 ? '' : 's'} missing
        </span>
        <Button size="sm" onClick={onSync}>
          Retry sync
        </Button>
      </span>
    )
  }
  if (staleness?.stale) {
    if (staleness.newCommits > 0) {
      return (
        <span className="seal" data-stale="true">
          ⧗ {staleness.newCommits} new commit{staleness.newCommits === 1 ? '' : 's'} since
          sync
          <Button size="sm" onClick={onSync}>
            Re-sync
          </Button>
        </span>
      )
    }
    if (staleness.baseMoved) {
      return (
        <span className="seal" data-stale="true">
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>⧗ base advanced — diff changed</span>
            </TooltipTrigger>
            <TooltipContent>
              The base branch moved, so the three-dot compare changed even though head
              didn't. The diff is keyed merge_base…head.
            </TooltipContent>
          </Tooltip>
          <Button size="sm" onClick={onSync}>
            Re-sync
          </Button>
        </span>
      )
    }
    // Stale with no commit delta and an unchanged-base rule out: the head was
    // rewritten in place (a force push). Still gold, still one action.
    return (
      <span className="seal" data-stale="true">
        ⧗ head moved since sync
        <Button size="sm" onClick={onSync}>
          Re-sync
        </Button>
      </span>
    )
  }
  return (
    <span className="seal">
      ⧗ {shortSha(snapshot.immutable.headSha)} · synced {relativeTime(snapshot.syncedAt)}
      <Button
        variant="ghost"
        className="-my-1 h-5 w-5 px-0 [&_svg]:size-[13px]"
        aria-label="Re-sync"
        onClick={onSync}
      >
        <RefreshCw size={13} strokeWidth={1.5} aria-hidden />
      </Button>
    </span>
  )
}

// ————————————————————————————————————————————————————————————————
// Tab strip — NavLinks styled like the underline TabsTrigger.
// ————————————————————————————————————————————————————————————————

/** What each section is called where a reader can see it. */
const TAB_LABELS: Record<ReviewTab, string> = {
  description: 'Description',
  conversation: 'Conversation',
  files: 'Files',
  commits: 'Commits',
  checks: 'Checks',
}

/**
 * The strip's accessible name. It is the header's only landmark, so it keeps
 * one in both kinds of review — a review of two local branches simply has no
 * pull request to name.
 */
const TAB_STRIP_LABEL: Record<ReviewMode, string> = {
  github: 'Pull request sections',
  local: 'Review sections',
}

function TabLink({ to, label, count }: { to: string; label: string; count?: number }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'inline-flex items-center gap-1.5 border-b-2 px-0.5 pb-1.5 pt-1 font-sans text-sm transition-colors',
          isActive ? 'border-ink text-ink' : 'border-transparent text-ink-mut hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          {label}
          {count !== undefined && (
            <span
              className={cn(
                'inline-flex min-w-4 items-center justify-center rounded-(--radius-xs) px-1 font-mono text-2xs leading-tight transition-colors',
                isActive ? 'bg-overlay text-ink-mut' : 'bg-raised text-ink-faint',
              )}
            >
              {count}
            </span>
          )}
        </>
      )}
    </NavLink>
  )
}

/**
 * The section tabs for one review.
 *
 * Props-only and exported on purpose: the layout around it needs a query
 * client, a session and a loaded pull list before it renders anything, while
 * the strip needs the mode and two counts — so which sections a review offers
 * is assertable against real markup rather than against a promise.
 *
 * Which tabs exist is read from `reviewTabs`, the same table the route guard
 * consults, so a section the strip omits and a section the router redirects
 * away from can never disagree.
 */
export function PrTabs({
  mode,
  changedFiles,
  unresolved,
}: {
  mode: ReviewMode
  /** Files in the diff, or `undefined` until the snapshot has been read. */
  changedFiles: number | undefined
  /** Threads still open. Zero draws no chip — a quiet tab is not a busy one. */
  unresolved: number
}) {
  const countFor = (tab: ReviewTab): number | undefined => {
    if (tab === 'files') return changedFiles
    if (tab === 'conversation') return unresolved > 0 ? unresolved : undefined
    return undefined
  }
  return (
    <nav className="-mb-px flex items-end gap-4" aria-label={TAB_STRIP_LABEL[mode]}>
      {reviewTabs(mode).map((tab) => (
        <TabLink key={tab} to={tab} label={TAB_LABELS[tab]} count={countFor(tab)} />
      ))}
    </nav>
  )
}
PrTabs.displayName = 'PrTabs'

// ————————————————————————————————————————————————————————————————
// Identity row — what the review is, at the top of the header.
// ————————————————————————————————————————————————————————————————

/** The chip's tint per state: the review is live, it landed, or it did not. */
const STATE_VARIANT: Record<ReviewState, 'add' | 'default' | 'danger'> = {
  open: 'add',
  merged: 'default',
  closed: 'danger',
}

/**
 * Which of the three states a review is in, read off the review itself. A
 * merge timestamp is the only evidence one landed — a merged pull request also
 * reports `state: 'closed'`, so the timestamp is checked first.
 */
function reviewState(pull: PullSummary): ReviewState {
  if (pull.merged_at) return 'merged'
  return pull.state === 'open' ? 'open' : 'closed'
}

/**
 * What a review is called, in the slot at the head of its identity row.
 *
 * A pull request is called by its number. A review of two local branches has
 * no pull request and so no number a reader could use — only a synthetic key
 * from a reserved band, which exists so every route and cache entry can stay a
 * plain integer and means nothing to anyone reading the screen. So it is
 * called by the branch pair it compares, and the key is never drawn.
 *
 * The pair is named as one thing rather than read out piecemeal: the arrow
 * carries the direction and an arrow has no spoken form, so the whole slot is
 * labelled as a sentence and its parts are left to the eye.
 */
function IdentitySlot({ mode, pull }: { mode: ReviewMode; pull: PullSummary }) {
  if (mode === 'github') {
    return <span className="shrink-0 font-mono text-ink-faint">#{pull.number}</span>
  }
  return (
    <span
      role="img"
      aria-label={`Local review of ${pull.head.ref} against ${pull.base.ref}`}
      className="flex max-w-64 shrink-0 items-center gap-1 font-mono text-ink-faint"
    >
      <span className="min-w-0 truncate">{pull.base.ref}</span>
      <span aria-hidden>←</span>
      <span className="min-w-0 truncate">{pull.head.ref}</span>
    </span>
  )
}

/**
 * Row 1 of the review header: the way back, what the review is, what it is
 * called, and what it claims about itself.
 *
 * Props-only and exported for the reason the tab strip is: the layout around
 * it needs a query client, a session and a loaded list before it renders a
 * single element, while this row needs only the mode and the review itself —
 * so "the synthetic key never reaches a screen" is a property assertable
 * against real markup rather than a promise about a branch buried in a page.
 *
 * The local marker is the quiet outline chip, not the seal one row below and
 * not the violet: where a review came from is a fact about its provenance,
 * while the seal reports that time moved underneath a snapshot and violet is
 * reserved for work that is still pending.
 */
export function PrIdentityRow({ mode, pull }: { mode: ReviewMode; pull: PullSummary }) {
  const state = reviewState(pull)
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Link to="/" className="shrink-0 text-2xs text-ink-faint hover:text-ink-mut">
        ← inbox
      </Link>
      <IdentitySlot mode={mode} pull={pull} />
      <h1 className="min-w-0 truncate text-base font-semibold text-ink" title={pull.title}>
        {pull.title}
      </h1>
      {mode === 'local' && (
        <Badge className="shrink-0" variant="outline">
          local
        </Badge>
      )}
      <Badge className="shrink-0" variant={STATE_VARIANT[state]}>
        {stateChipCopy(mode, state)}
      </Badge>
      {pull.draft && (
        <Badge className="shrink-0" variant="draft">
          draft
        </Badge>
      )}
    </div>
  )
}
PrIdentityRow.displayName = 'PrIdentityRow'

// ————————————————————————————————————————————————————————————————
// Meta row — who wrote it and how big it is, under the identity row.
// ————————————————————————————————————————————————————————————————

/**
 * The dot beside the check tally. Precedence is failure → still running →
 * success, because a red run matters even while others are still going.
 */
function checksDotClass(checks: CheckCounts): string {
  if (checks.failed > 0) return 'bg-danger'
  if (checks.running > 0) return 'animate-pulse bg-stale'
  return 'bg-add'
}

/**
 * Row 2 of the review header: who wrote it, which branches it compares, how it
 * merges, how its checks are doing and how big its diff is.
 *
 * Props-only and exported for the reason the tab strip and the identity row
 * are: the layout around it needs a query client, a session and a loaded pull
 * list before it renders a single element, while this row needs only the mode,
 * the review and what the snapshot said — so which of these facts a given kind
 * of review states is assertable against real markup rather than promised.
 *
 * The branch pair is drawn here ONLY for a pull request. A pull request is
 * called by its number one row above, so this is the only place it says which
 * branches it compares. A review of two local branches has no number and is
 * called by the pair itself, so the row above already carries it — repeating it
 * here would say the same thing twice in one header, and the row that says it
 * is the one the reader reads as the review's name.
 */
export function PrMetaRow({
  mode,
  pull,
  author,
  detail,
  checks,
}: {
  mode: ReviewMode
  pull: PullSummary
  /** Who wrote the review, already resolved against the session's write identity. */
  author: CommentIdentity
  /** The snapshot's fuller reading of the review, or `undefined` until it is read. */
  detail: PullDetail | undefined
  /** The snapshot's check runs bucketed, or `null` while there is no snapshot. */
  checks: CheckCounts | null
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-mut">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <IdentityAvatar identity={author} mode={mode} size="xs" />
        <span className="truncate">{identityName(author)}</span>
      </span>
      {mode === 'github' && (
        <span className="font-mono">
          {pull.base.ref} ← {pull.head.ref}
        </span>
      )}
      {detail?.mergeable === false ? (
        <Badge variant="danger">merge conflict</Badge>
      ) : detail?.mergeable_state === 'blocked' ? (
        <Badge variant="outline">review required</Badge>
      ) : null}
      {checks !== null && checks.total > 0 && (
        <Link
          to="checks"
          className="inline-flex items-center gap-1.5 text-ink-mut hover:text-ink"
        >
          <span className={cn('size-1.5 rounded-full', checksDotClass(checks))} aria-hidden />
          {checks.passed}/{checks.total} checks
        </Link>
      )}
      {detail && (
        <span className="inline-flex items-center gap-1.5 font-mono">
          {detail.changed_files} files
          <span className="text-add">+{detail.additions}</span>
          <span className="text-del">−{detail.deletions}</span>
        </span>
      )}
    </div>
  )
}
PrMetaRow.displayName = 'PrMetaRow'

// ————————————————————————————————————————————————————————————————
// Layout
// ————————————————————————————————————————————————————————————————

export function PrLayout() {
  const params = useParams<{ n: string }>()
  const prNumber = Number(params.n)
  // Derived once for the whole subtree and threaded down as a prop, so no two
  // surfaces inside one review can disagree about which kind it is.
  const mode = reviewMode(prNumber)

  const session = useSession()
  const list = usePullList()
  const snapshotQuery = useSnapshot(prNumber)
  const staleness = useStaleness(prNumber)
  const { run: runSync, isPending: syncing } = useSyncAction(prNumber)

  const item = useMemo(
    () => list.data?.items.find((i) => i.pull.number === prNumber),
    [list.data, prNumber],
  )

  const snapshot = snapshotQuery.data

  useShortcut('shift+r', () => runSync(), {
    enabled: snapshot != null && !syncing,
  })

  // List still on its first load: a header-shaped skeleton, nothing invented.
  if (!list.data) {
    if (list.isError && list.error) {
      const detail =
        list.error.code === 'rate_limited' && list.error.resetAt
          ? `Rate limit exhausted. Resets in ${minutesUntil(list.error.resetAt)} minutes.`
          : list.error.message
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="hairline-b px-4 py-2">
            <Link to="/" className="text-2xs text-ink-faint hover:text-ink-mut">
              ← inbox
            </Link>
          </div>
          <div className="flex flex-1 items-start justify-center p-6">
            <ErrorState
              className="w-full max-w-md"
              title="Couldn't load the PR list"
              detail={detail}
              retry={() => void list.refetch()}
            />
          </div>
        </div>
      )
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="hairline-b px-4 pb-2 pt-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-5 w-72 max-w-full" />
          </div>
          <div className="mt-2 flex items-center gap-3">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="mt-3 flex items-center justify-between gap-4">
            <Skeleton className="h-6 w-52" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
        </div>
        <div className="flex-1" />
      </div>
    )
  }

  // The list is loaded and this review genuinely isn't in it. Which sentence
  // explains that depends on the kind of review the path named, so the copy is
  // read from the mode rather than from the one kind that has an installation
  // behind it.
  if (!item) {
    const copy = notFoundCopy(mode, params.n ?? '')
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="hairline-b px-4 py-2">
          <Link to="/" className="text-2xs text-ink-faint hover:text-ink-mut">
            ← inbox
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Inbox size={20} strokeWidth={1.5} />}
            title={copy.title}
            hint={copy.hint}
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/">{copy.action}</Link>
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  const pull = item.pull
  const author = parseCommentIdentity(
    { user: pull.user, body: pull.body ?? '' },
    session.brokerLogin,
  )
  const detail = snapshot?.mutable.pull
  const rollup = snapshot ? countChecks(snapshot.mutable.checks) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="hairline-b px-4 pt-3">
        {/* Row 1 — identity of the review itself */}
        <PrIdentityRow mode={mode} pull={pull} />

        {/* Row 2 — meta: author, refs, mergeability, checks, diff size */}
        <PrMetaRow
          mode={mode}
          pull={pull}
          author={author.identity}
          detail={detail}
          checks={rollup}
        />

        {/* The header's banner stack. Each member decides its own visibility
            and renders nothing when it has none, so the slot collapses
            entirely when they all do and a member can be added without any of
            the others knowing about it.

            The order is fixed rather than incidental, from the widest claim
            about the review down to the narrowest: what has superseded it,
            then what it does not cover, then what it is waiting on. */}
        <div className="flex flex-col gap-2 py-2 empty:hidden">
          <ReviewDirtyBanner prNumber={prNumber} mode={mode} />
          <AuthorBanner prNumber={prNumber} mode={mode} />
        </div>

        {/* Row 3 — the seal on the left, section tabs on the right */}
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="pb-1.5">
            <SnapshotSeal
              mode={mode}
              snapshot={snapshot}
              loading={snapshotQuery.isPending}
              staleness={staleness}
              syncing={syncing}
              onSync={runSync}
            />
          </div>
          <PrTabs
            mode={mode}
            changedFiles={detail?.changed_files}
            unresolved={item.broker.unresolvedThreads}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>

      <ReviewBar prNumber={prNumber} />
    </div>
  )
}
