import { useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router'
import { Download, Inbox, RefreshCw } from 'lucide-react'
import type { ApiError, CheckRun, Snapshot, StalenessInfo } from '@revu/shared'
import { identityName, parseCommentIdentity } from '@revu/shared'
import { usePullList, useSnapshot, useStaleness, useSyncPull } from '@/state/queries'
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
  snapshot,
  loading,
  staleness,
  syncing,
  onSync,
}: {
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
          <TooltipContent>
            Pulls the whole PR down in one burst (~3 + 2 requests per changed file), then
            review is fully local.
          </TooltipContent>
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

// ————————————————————————————————————————————————————————————————
// Checks rollup for the header chip
// ————————————————————————————————————————————————————————————————

function checksRollup(checks: CheckRun[]): {
  passed: number
  failed: number
  running: number
  total: number
} {
  let passed = 0
  let failed = 0
  let running = 0
  for (const c of checks) {
    if (c.status !== 'completed') running++
    else if (c.conclusion === 'success') passed++
    else if (
      c.conclusion === 'failure' ||
      c.conclusion === 'timed_out' ||
      c.conclusion === 'cancelled'
    ) {
      failed++
    }
  }
  return { passed, failed, running, total: checks.length }
}

// ————————————————————————————————————————————————————————————————
// Layout
// ————————————————————————————————————————————————————————————————

export function PrLayout() {
  const params = useParams<{ n: string }>()
  const prNumber = Number(params.n)

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

  // The list is loaded and this PR genuinely isn't in it.
  if (!item) {
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
            title={`PR #${params.n} isn't in this installation`}
            hint="The broker only sees pull requests in repos this GitHub App is installed on."
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/">Back to inbox</Link>
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  const pull = item.pull
  const author = parseCommentIdentity({ user: pull.user, body: pull.body ?? '' })
  const detail = snapshot?.mutable.pull
  const rollup = snapshot ? checksRollup(snapshot.mutable.checks) : null
  const checksDot =
    rollup === null
      ? ''
      : rollup.failed > 0
        ? 'bg-danger'
        : rollup.running > 0
          ? 'animate-pulse bg-stale'
          : 'bg-add'
  const stateBadge = pull.merged_at
    ? { label: 'merged', variant: 'default' as const }
    : pull.state === 'open'
      ? { label: 'open', variant: 'add' as const }
      : { label: 'closed', variant: 'danger' as const }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="hairline-b px-4 pt-3">
        {/* Row 1 — identity of the PR itself */}
        <div className="flex min-w-0 items-center gap-2">
          <Link to="/" className="shrink-0 text-2xs text-ink-faint hover:text-ink-mut">
            ← inbox
          </Link>
          <span className="shrink-0 font-mono text-ink-faint">#{pull.number}</span>
          <h1
            className="min-w-0 truncate text-base font-semibold text-ink"
            title={pull.title}
          >
            {pull.title}
          </h1>
          <Badge className="shrink-0" variant={stateBadge.variant}>
            {stateBadge.label}
          </Badge>
          {pull.draft && (
            <Badge className="shrink-0" variant="draft">
              draft
            </Badge>
          )}
        </div>

        {/* Row 2 — meta: author, refs, mergeability, checks, diff size */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-mut">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <IdentityAvatar identity={author.identity} size="xs" />
            <span className="truncate">{identityName(author.identity)}</span>
          </span>
          <span className="font-mono">
            {pull.base.ref} ← {pull.head.ref}
          </span>
          {detail?.mergeable === false ? (
            <Badge variant="danger">merge conflict</Badge>
          ) : detail?.mergeable_state === 'blocked' ? (
            <Badge variant="outline">review required</Badge>
          ) : null}
          {rollup !== null && rollup.total > 0 && (
            <Link
              to="checks"
              className="inline-flex items-center gap-1.5 text-ink-mut hover:text-ink"
            >
              <span className={cn('size-1.5 rounded-full', checksDot)} aria-hidden />
              {rollup.passed}/{rollup.total} checks
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

        {/* PR-author banner: its own logic decides whether it shows anything. */}
        <div className="pt-2 empty:hidden">
          <AuthorBanner prNumber={prNumber} />
        </div>

        {/* Row 3 — the seal on the left, section tabs on the right */}
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="pb-1.5">
            <SnapshotSeal
              snapshot={snapshot}
              loading={snapshotQuery.isPending}
              staleness={staleness}
              syncing={syncing}
              onSync={runSync}
            />
          </div>
          <nav className="-mb-px flex items-end gap-4" aria-label="Pull request sections">
            <TabLink
              to="conversation"
              label="Conversation"
              count={
                item.broker.unresolvedThreads > 0
                  ? item.broker.unresolvedThreads
                  : undefined
              }
            />
            <TabLink to="files" label="Files" count={detail?.changed_files} />
            <TabLink to="commits" label="Commits" />
            <TabLink to="checks" label="Checks" />
          </nav>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>

      <ReviewBar prNumber={prNumber} />
    </div>
  )
}
