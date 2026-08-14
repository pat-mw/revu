import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQueries } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  CircleDot,
  CircleX,
  GitBranch,
  Inbox,
} from 'lucide-react'

import { api } from '@/api'
import { qk, usePullList, useRateLimit } from '@/state/queries'
import { hasAnyLocalReview, useLocalReviewAnnotations } from '@/state/local-reviews'
import { usePreferences, useSetPreferences } from '@/state/preferences'
import { useSession } from '@/state/session'
import type { PullListItem, ReviewDraft } from '@revu/shared'
import { parseCommentIdentity } from '@revu/shared'
import { IdentityAvatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useShortcut } from '@/lib/keyboard'
import { relativeTime, minutesUntil } from '@/lib/time'
import { cn } from '@/lib/cn'
import { buildPullTree, flattenPullTree } from '@/lib/pull-tree'
import { buildPullTooltip } from '@/lib/pull-tooltip'
import type { PullTooltip } from '@/lib/pull-tooltip'
import {
  buildInboxSections,
  enterTarget,
  matchesFilter,
  nextFocusIndex,
} from '@/lib/inbox-sections'
import type { InboxRow } from '@/lib/inbox-sections'
import { isLocalReviewItem, rowIdentity } from '@/lib/local-reviews'
import { useCreateLocalReviewControl } from '@/components/create-local-review'
import { Button } from '@/components/ui/button'

/**
 * The inbox is a workspace tool for someone with a job today, not a generic PR
 * list. It sorts every open PR into four intent-ordered buckets — what's waiting
 * on you, what you owe a review, what you've left half-written, and everything
 * else — and makes the one number that matters (unresolved comments on your own
 * PRs) the loudest thing on the screen. Reviews of a branch pair with no pull
 * request behind them get a section of their own, because they answer to
 * nobody's attention but the reader's.
 *
 * The PR list is the app's single live surface: it polls on a schedule, so the
 * whisper under the title states liveness and freshness quietly rather than
 * spinning a loader. How the transport keeps that polling cheap is its own
 * concern and stays out of the copy — the only budget the reader can act on is
 * the one the rate chip shows.
 */

export function InboxPage() {
  const navigate = useNavigate()
  const session = useSession()
  const human = session.human
  const pulls = usePullList()
  const rate = useRateLimit()

  const items = useMemo(() => pulls.data?.items ?? [], [pulls.data])

  // Drafts are broker-local reads keyed by the human — they cost nothing against
  // the shared GitHub bucket, so every listed PR can be probed for one at once.
  const draftQueries = useQueries({
    queries: items.map((it) => ({
      queryKey: qk.draft(it.pull.number),
      queryFn: () => api.getDraft(it.pull.number),
      staleTime: Infinity,
    })),
  })

  // Map PR number → its draft (only drafts with pending comments count as
  // "in progress" — an empty draft shell is not work someone left unfinished).
  const draftByNumber = useMemo(() => {
    const map = new Map<number, ReviewDraft>()
    items.forEach((it, i) => {
      const draft = draftQueries[i]?.data
      if (draft && draft.comments.length > 0) map.set(it.pull.number, draft)
    })
    return map
  }, [items, draftQueries])

  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()

  const authoredOpen = useMemo(
    () =>
      items.filter(
        (it) =>
          it.pull.state === 'open' && it.broker.authorHumanId === human.id,
      ),
    [items, human.id],
  )

  // What only a local review has, and what the list row cannot carry: whether
  // its worktree is dirty, and whether the reader holds any local review at
  // all. Its own read on purpose, and one that must stay eager — the list's
  // ETag is a function of the reviews' compare keys, so a worktree picking up
  // uncommitted changes does not move it and no amount of polling the list
  // would ever reveal one.
  const annotations = useLocalReviewAnnotations()
  const localAnnotations = annotations.data
  const hasLocalReviews = hasAnyLocalReview(localAnnotations)
  const dirtyReviews = useMemo(
    () => new Set((localAnnotations ?? []).filter((s) => s.dirty).map((s) => s.id)),
    [localAnnotations],
  )

  const sections = useMemo(
    () =>
      buildInboxSections({
        items,
        needle,
        humanId: human.id,
        botLogin: session.brokerLogin,
        draftByNumber,
        hasLocalReviews,
      }),
    [items, needle, human.id, draftByNumber, session.brokerLogin, hasLocalReviews],
  )

  // How the inbox is arranged is a per-human preference, persisted behind the
  // adapter like the diff layout, so it survives a reload and a rebuild.
  const setPreferences = useSetPreferences()
  const setPreferencesMutate = setPreferences.mutate
  const view = usePreferences().data?.inboxView ?? 'list'
  const setView = useCallback(
    (v: 'list' | 'tree') => {
      if (v !== view) setPreferencesMutate({ inboxView: v })
    },
    [view, setPreferencesMutate],
  )

  // The same open PRs the sections draw from, arranged by what they are stacked
  // on. Built from the list already in hand — a stack's shape is implied by
  // every PR's base ref, so this costs no request.
  const treeRoots = useMemo(() => {
    const open = items.filter((it) => it.pull.state === 'open')
    const filtered = open.filter((it) => matchesFilter(it, needle, session.brokerLogin))
    return buildPullTree(filtered)
  }, [items, needle, session.brokerLogin])

  // A single flat list of every visible row, in section order, so keyboard
  // navigation crosses section boundaries as one continuous column.
  const flatRows = useMemo(
    () =>
      view === 'tree'
        ? flattenPullTree(treeRoots).map((n) => ({
            item: n.item,
            draft: draftByNumber.get(n.item.pull.number) ?? null,
          }))
        : sections.flatMap((s) => s.rows),
    [view, treeRoots, sections, draftByNumber],
  )

  // Starting a review is offered from two places on this screen, and both raise
  // the shell's single dialog. While it is up the inbox is covered, so its bare
  // keys must decide nothing — the guard that makes shortcuts inert while
  // typing exempts text fields only, and the focus inside a modal is usually on
  // a button.
  const create = useCreateLocalReviewControl()
  const blocked = create.isOpen

  const [focusIndex, setFocusIndex] = useState(0)
  const rowRefs = useRef<Array<HTMLAnchorElement | null>>([])

  // Keep the focused index inside the current row count as sections re-derive.
  useEffect(() => {
    setFocusIndex((i) => {
      if (flatRows.length === 0) return 0
      return Math.min(i, flatRows.length - 1)
    })
  }, [flatRows.length])

  const moveFocus = useCallback(
    (delta: number) => {
      setFocusIndex((i) => {
        const next = nextFocusIndex(i, delta, flatRows.length, { blocked })
        // Only when it actually moved: the column is scrolled to follow the
        // cursor, and a cursor that stayed put has nothing to follow.
        if (next !== i) rowRefs.current[next]?.scrollIntoView({ block: 'nearest' })
        return next
      })
    },
    [flatRows.length, blocked],
  )

  // Two layers, deliberately. The `enabled` option keeps the handlers from
  // firing at all while the create dialog is up; the same flag reaches the
  // decision itself, so the column stays inert even if that option is ever
  // dropped.
  useShortcut('j', () => moveFocus(1), { enabled: !blocked })
  useShortcut('k', () => moveFocus(-1), { enabled: !blocked })
  useShortcut(
    'enter',
    () => {
      const to = enterTarget(flatRows, focusIndex, { blocked })
      if (to) navigate(to)
    },
    { enabled: !blocked },
  )

  // ——— loading ———
  if (pulls.isLoading) {
    return <InboxSkeleton />
  }

  // ——— error ———
  if (pulls.isError) {
    const err = pulls.error
    const detail =
      err.code === 'rate_limited'
        ? `Rate limit exhausted. Resets in ${
            err.resetAt ? minutesUntil(err.resetAt) : 0
          } minutes.`
        : 'The broker holds the live PR list; it dropped the connection. Retry the poll.'
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-4">
          <InboxHeader
            dataUpdatedAt={pulls.dataUpdatedAt}
            filter={filter}
            onFilter={setFilter}
            view={view}
            onView={setView}
            onCreate={create.open}
          />
          <ErrorState
            className="mt-4"
            title="The broker didn't answer"
            detail={detail}
            retry={() => void pulls.refetch()}
          />
        </div>
      </div>
    )
  }

  const totalOpen = items.filter((it) => it.pull.state === 'open').length

  // ——— nothing at all ———
  if (totalOpen === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-4">
          <InboxHeader
            dataUpdatedAt={pulls.dataUpdatedAt}
            filter={filter}
            onFilter={setFilter}
            rateResetAt={rate.data?.remaining === 0 ? rate.data.reset : undefined}
            view={view}
            onView={setView}
            onCreate={create.open}
          />
          <InboxZeroState onCreate={create.open} />
        </div>
      </div>
    )
  }

  // Section 1 is shown even when empty *if* the human has open authored PRs —
  // "nothing waiting on you" is itself the reassurance the tool exists to give.
  // With no authored PRs at all, the section is omitted entirely.
  const hasAuthored = authoredOpen.length > 0

  let runningIndex = 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-4">
        <InboxHeader
          dataUpdatedAt={pulls.dataUpdatedAt}
          filter={filter}
          onFilter={setFilter}
          view={view}
          onView={setView}
          onCreate={create.open}
        />

        <div className="mt-3 flex flex-col gap-5">
          {view === 'tree' &&
            treeRoots.map((root) => {
              const nodes = flattenPullTree([root])
              return (
                <section key={root.branch}>
                  <SectionHeader title={root.branch} count={root.total} />
                  <div className="hairline-t">
                    {nodes.map((node) => {
                      const index = runningIndex
                      runningIndex += 1
                      return (
                        <InboxRowView
                          key={node.item.pull.number}
                          ref={(el) => {
                            rowRefs.current[index] = el
                          }}
                          row={{
                            item: node.item,
                            draft: draftByNumber.get(node.item.pull.number) ?? null,
                          }}
                          showUnresolvedNumber={false}
                          dirty={dirtyReviews.has(node.item.pull.number)}
                          focused={index === focusIndex}
                          onFocus={() => setFocusIndex(index)}
                          depth={node.depth}
                        />
                      )
                    })}
                  </div>
                </section>
              )
            })}
          {view === 'tree' && treeRoots.length === 0 && (
            <p className="px-1 py-2 text-sm text-ink-mut">
              No open pull requests match the filter.
            </p>
          )}
          {view === 'list' &&
            sections.map((section) => {
            const isWaiting = section.id === 'waiting'
            // Empty sections are omitted — except "Waiting on you", which stays
            // as a quiet reassurance when the human has authored open PRs, and
            // "Local reviews", which the derivation only includes when there
            // are some to account for and which then says where they went.
            if (section.rows.length === 0) {
              if (isWaiting && hasAuthored) {
                return (
                  <section key={section.id}>
                    <SectionHeader title={section.title} count={0} />
                    <p className="px-1 py-2 text-sm text-ink-mut">
                      Nothing waiting on you — no unresolved comments on your PRs.
                    </p>
                  </section>
                )
              }
              if (section.id === 'local') {
                return (
                  <section key={section.id}>
                    <SectionHeader title={section.title} count={0} />
                    <p className="px-1 py-2 text-sm text-ink-mut">
                      Nothing open here — every local review you have is either closed or
                      filtered out.
                    </p>
                  </section>
                )
              }
              return null
            }

            return (
              <section key={section.id}>
                <SectionHeader title={section.title} count={section.rows.length} />
                <div className="hairline-t">
                  {section.rows.map((row) => {
                    const index = runningIndex
                    runningIndex += 1
                    return (
                      <InboxRowView
                        key={row.item.pull.number}
                        ref={(el) => {
                          rowRefs.current[index] = el
                        }}
                        row={row}
                        showUnresolvedNumber={isWaiting}
                        dirty={dirtyReviews.has(row.item.pull.number)}
                        focused={index === focusIndex}
                        onFocus={() => setFocusIndex(index)}
                      />
                    )
                  })}
                </div>
                </section>
              )
            })}
        </div>
      </div>
    </div>
  )
}

/**
 * The title row: name of the surface, the live-ness whisper, the way to start a
 * review of two branches, the arrangement control, and the filter.
 */
function InboxHeader({
  dataUpdatedAt,
  filter,
  onFilter,
  rateResetAt,
  view,
  onView,
  onCreate,
}: {
  dataUpdatedAt: number
  filter: string
  onFilter: (v: string) => void
  rateResetAt?: string
  view: 'list' | 'tree'
  onView: (v: 'list' | 'tree') => void
  /** Raise the shared create-review dialog. */
  onCreate: () => void
}) {
  const updated = dataUpdatedAt
    ? relativeTime(new Date(dataUpdatedAt).toISOString())
    : 'just now'
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="font-display text-base font-semibold text-ink">Inbox</h1>
        <span className="truncate font-mono text-2xs text-ink-faint">
          {rateResetAt
            ? `budget spent · resets in ${minutesUntil(rateResetAt)}m`
            : `live · updated ${updated}`}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* Reviewing is what this screen is for, so the way to start one that
            needs no pull request sits in the row rather than behind the
            palette. Quiet rather than violet: violet means pending work. */}
        <Button
          size="sm"
          onClick={onCreate}
          title="Compare two branches in this workspace — nothing is pushed"
        >
          <GitBranch strokeWidth={1.5} aria-hidden />
          New local review
        </Button>
        {/* List groups by what each PR needs from you; tree groups by what each
            PR is stacked on. Neither is a filter — both show the same PRs. */}
        <div
          className="flex flex-none items-center rounded-(--radius-sm) border border-line p-px"
          role="group"
          aria-label="Inbox arrangement"
        >
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-5 px-1.5 text-2xs', view === 'list' && 'bg-raised text-ink')}
            aria-pressed={view === 'list'}
            title="Group by what needs your attention"
            onClick={() => onView('list')}
          >
            List
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-5 gap-1 px-1.5 text-2xs', view === 'tree' && 'bg-raised text-ink')}
            aria-pressed={view === 'tree'}
            title="Group by what each PR is stacked on"
            onClick={() => onView('tree')}
          >
            <GitBranch size={11} strokeWidth={1.5} aria-hidden />
            Tree
          </Button>
        </div>
        <Input
          className="w-56"
          type="search"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="filter by title, number, author…"
          aria-label="Filter pull requests"
        />
        <span className="hidden items-center gap-1 text-2xs text-ink-faint sm:inline-flex">
          <Kbd keys={['j']} />
          <Kbd keys={['k']} />
          to move
        </span>
      </div>
    </div>
  )
}

/**
 * What a row is called, in the narrow slot at its left edge.
 *
 * A pull request is called by its number. A local review has no pull request
 * and no GitHub number — only a synthetic key from a reserved band, which
 * exists so routes and cache keys can stay plain integers and means nothing to
 * anyone reading the screen. So a local row is called by the branch pair it
 * compares, and the key is never drawn.
 *
 * The slot routes entirely through one pure reading of the row. That is what
 * makes "the synthetic key is never on screen" something a test can hold,
 * rather than a branch inside a component that a later edit can quietly widen.
 */
export function RowIdentity({ item }: { item: PullListItem }) {
  const identity = rowIdentity(item)
  if (identity.kind === 'github') {
    return (
      <span className="w-12 shrink-0 font-mono text-xs text-ink-faint">
        {identity.text}
      </span>
    )
  }
  // Named as one thing rather than read out piecemeal: the arrow carries the
  // direction, and an arrow has no spoken form, so the pair is labelled as a
  // sentence and its parts are left to the eye.
  return (
    <span
      role="img"
      aria-label={`Local review of ${identity.head} against ${identity.base}`}
      className="flex w-40 shrink-0 items-center gap-1 font-mono text-xs text-ink-faint"
    >
      <span className="min-w-0 truncate">{identity.base}</span>
      <ArrowLeft size={11} strokeWidth={1.5} className="shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{identity.head}</span>
    </span>
  )
}

/**
 * The inbox with nothing open in it.
 *
 * The reason there is nothing open is not always that nobody has pushed yet:
 * a workspace may have no remote at all, and promising that a branch will
 * "land here" describes an arrival that is never coming. So the copy names
 * what this workspace can do on its own, and offers it.
 *
 * The action is required rather than optional. This is the screen where it
 * matters most — an empty inbox is the first thing a new workspace shows — so
 * a call site that has no way to honour it should not be rendering the
 * invitation at all, and cannot quietly drop it.
 */
export function InboxZeroState({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      className="mt-6"
      icon={<Inbox strokeWidth={1.5} />}
      title="Nothing open right now"
      hint="No open pull requests — a review can compare any two branches in this workspace, with or without one."
      action={
        <Button onClick={onCreate}>
          <GitBranch size={14} strokeWidth={1.5} aria-hidden />
          New local review
        </Button>
      }
    />
  )
}

/** Uppercase section label with a live count of the rows beneath it. */
function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-baseline gap-2 px-1 pb-1">
      <h2 className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
        {title}
      </h2>
      <span className="font-mono text-2xs text-ink-faint">{count}</span>
    </div>
  )
}

/**
 * One PR row. The whole row is a link into the PR; a focus highlight (violet-free
 * neutral panel + ring) tracks the keyboard cursor, and the section-1 rows carry
 * the big unresolved number that is the point of the whole screen.
 *
 * Hovering (or tabbing to) a row opens a hover card with everything the single
 * dense line had to leave out. Both arrangements render through here, so the
 * card is attached once and appears in each of them.
 */
const InboxRowView = forwardRef<
  HTMLAnchorElement,
  {
    row: InboxRow
    showUnresolvedNumber: boolean
    /**
     * The workspace had uncommitted changes when this local review last synced,
     * so what it shows is behind what is on disk. Read from the local-review
     * annotations rather than from the row: the list payload is frozen and
     * carries no such field, and its ETag would not move when a worktree
     * changed anyway.
     */
    dirty?: boolean
    focused: boolean
    onFocus: () => void
    /**
     * How deep this sits in its stack, in the tree arrangement. Indents the row
     * so a stack reads as one, and is absent in the list arrangement where
     * every row is a peer.
     */
    depth?: number
  }
>(({ row, showUnresolvedNumber, dirty = false, focused, onFocus, depth = 0 }, ref) => {
  const session = useSession()
  const { pull, broker } = row.item
  const parsed = parseCommentIdentity(
    { user: pull.user, body: pull.body ?? '' },
    session.brokerLogin,
  )
  const authorName =
    parsed.identity.kind === 'human' ? parsed.identity.name : pull.user.login
  const labels = pull.labels.slice(0, 2)
  const hasDraft = !!row.draft
  const isLocal = isLocalReviewItem(row.item)
  const unresolved = broker.unresolvedThreads
  const tip = useMemo(() => buildPullTooltip(row.item), [row.item])

  return (
    // A longer delay than the app default: this card is a paragraph, not a
    // one-line hint, and at the app default it flashes open on every row the
    // pointer merely crosses on its way down the column.
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <Link
          ref={ref}
          to={`/pr/${pull.number}`}
          onMouseEnter={onFocus}
          onFocus={onFocus}
          className={cn(
            'group flex min-h-10 items-center gap-2.5 px-1 py-1.5 hairline-b transition-colors',
            'hover:bg-panel',
            focused && 'bg-panel ring-1 ring-line-strong',
            hasDraft && 'draft-marker pl-2',
          )}
          // Indent by nesting depth so a stack reads as one shape. Inline rather
          // than a class because the depth is data, not one of a fixed few steps.
          style={depth > 0 ? { paddingLeft: `${depth * 1.15 + 0.25}rem` } : undefined}
        >
          {depth > 0 && (
            <span
              className="shrink-0 select-none font-mono text-xs text-ink-faint"
              aria-hidden
            >
              └
            </span>
          )}
          <RowIdentity item={row.item} />

          <IdentityAvatar identity={parsed.identity} size="sm" />

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm text-ink">{pull.title}</span>
              {labels.map((label) => (
                <Badge key={label.id} variant="outline" className="shrink-0">
                  {label.name}
                </Badge>
              ))}
            </div>
            <div className="flex items-center gap-1.5 text-2xs text-ink-faint">
              <span className="truncate">{authorName}</span>
              <span aria-hidden>·</span>
              <span className="truncate font-mono">{pull.head.ref}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0">updated {relativeTime(pull.updated_at)}</span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            {hasDraft && row.draft && (
              <Badge variant="draft" className="shrink-0">
                {row.draft.comments.length} pending · {relativeTime(row.draft.updatedAt)}
              </Badge>
            )}

            {/* Where this review came from, not what it is waiting for — so a
                quiet outline rather than the violet that means pending work. */}
            {isLocal && (
              <Badge variant="outline" className="shrink-0">
                local
              </Badge>
            )}

            {dirty && (
              <Badge
                variant="stale"
                className="shrink-0"
                title="The worktree had uncommitted changes at the last sync — they are not in this review."
              >
                worktree dirty
              </Badge>
            )}

            {/* Approvability is a statement about a pull request in an
                organization. There is no pull request behind a local review and
                no organization saw the branch, so the claim is not made. */}
            {!isLocal && broker.canApprove && (
              <Badge variant="outline" className="shrink-0">
                org PR — approvable
              </Badge>
            )}

            {showUnresolvedNumber ? (
              <div className="flex w-16 shrink-0 flex-col items-end leading-none">
                <span className="font-display text-xl font-bold text-ink">
                  {unresolved}
                </span>
                <span className="text-2xs text-ink-faint">unresolved</span>
              </div>
            ) : (
              unresolved > 0 && (
                <span className="shrink-0 text-xs text-ink-mut">
                  {unresolved} unresolved
                </span>
              )
            )}
          </div>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-sm px-2.5 py-2">
        <PullHoverCard tip={tip} />
      </TooltipContent>
    </Tooltip>
  )
})
InboxRowView.displayName = 'InboxRowView'

/**
 * The hover card's contents: the full title the row had to truncate, what the
 * description says, where the work comes from and goes, and how CI feels about
 * it. Every line is optional except the title and the branch pair — a body with
 * no prose and a pull request nothing has reported on both render a shorter
 * card rather than a placeholder.
 */
function PullHoverCard({ tip }: { tip: PullTooltip }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-sans text-sm leading-snug text-ink">{tip.title}</p>

      {tip.snippet !== null && (
        <p className="text-xs leading-snug text-ink-mut">{tip.snippet}</p>
      )}

      <div className="flex min-w-0 items-center gap-1.5 font-mono text-2xs text-ink-faint">
        <GitBranch size={11} strokeWidth={1.5} className="shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{tip.branches.head}</span>
        <ArrowRight size={11} strokeWidth={1.5} className="shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{tip.branches.base}</span>
        {tip.branches.crossRepo && (
          <Badge variant="outline" className="shrink-0">
            fork
          </Badge>
        )}
      </div>

      {tip.checks !== null && <ChecksLine checks={tip.checks} />}
    </div>
  )
}

/**
 * The CI line. Each state carries its own glyph as well as its own hue so the
 * verdict survives without color. Work still in flight stays neutral: violet
 * belongs to drafts and gold to staleness, and a run that has not finished is
 * neither — it is simply nothing to act on yet.
 */
function ChecksLine({ checks }: { checks: NonNullable<PullTooltip['checks']> }) {
  const { Icon, tone } =
    checks.state === 'success'
      ? { Icon: CircleCheck, tone: 'text-add' }
      : checks.state === 'failure'
        ? { Icon: CircleX, tone: 'text-danger' }
        : { Icon: CircleDot, tone: 'text-ink-mut' }
  return (
    <div className={cn('flex items-center gap-1.5 text-2xs', tone)}>
      <Icon size={11} strokeWidth={1.5} className="shrink-0" aria-hidden />
      <span>{checks.text}</span>
    </div>
  )
}

/** Loading placeholder: section headers with rows shaped like the final list. */
function InboxSkeleton() {
  const groups = [
    { rows: 3 },
    { rows: 4 },
    { rows: 5 },
  ]
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-2.5">
            <h1 className="font-display text-base font-semibold text-ink">Inbox</h1>
            <Skeleton className="h-3 w-48" />
          </div>
          {/* One placeholder per header control, at its size. The header is the
              one part of this screen that does not change between loading and
              loaded, so a placeholder short of a control makes the whole row
              shift sideways the moment the list arrives. */}
          <div className="flex shrink-0 items-center gap-2">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-7 w-56" />
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-5">
          {groups.map((group, gi) => (
            <section key={gi}>
              <div className="px-1 pb-1">
                <Skeleton className="h-3 w-32" />
              </div>
              <div className="hairline-t">
                {Array.from({ length: group.rows }).map((_, ri) => (
                  <div
                    key={ri}
                    className="flex min-h-10 items-center gap-2.5 px-1 py-1.5 hairline-b"
                  >
                    <Skeleton className="h-3 w-9" />
                    <Skeleton className="size-5 rounded-full" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <Skeleton className="h-3.5 w-2/3" />
                      <Skeleton className="h-2.5 w-2/5" />
                    </div>
                    <Skeleton className="h-3 w-14" />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
