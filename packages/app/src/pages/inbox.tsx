import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQueries } from '@tanstack/react-query'
import {
  ArrowRight,
  CircleCheck,
  CircleDot,
  CircleX,
  GitBranch,
  Inbox,
} from 'lucide-react'

import { api } from '@/api'
import { qk, usePullList, useRateLimit } from '@/state/queries'
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
import { Button } from '@/components/ui/button'

/**
 * The inbox is a workspace tool for someone with a job today, not a generic PR
 * list. It sorts every open PR into four intent-ordered buckets — what's waiting
 * on you, what you owe a review, what you've left half-written, and everything
 * else — and makes the one number that matters (unresolved comments on your own
 * PRs) the loudest thing on the screen.
 *
 * The PR list is the app's single live surface: it polls on a schedule, so the
 * whisper under the title states liveness and freshness quietly rather than
 * spinning a loader. How the transport keeps that polling cheap is its own
 * concern and stays out of the copy — the only budget the reader can act on is
 * the one the rate chip shows.
 */

/** A row as it will render, carrying the section it belongs to and any draft. */
interface InboxRow {
  item: PullListItem
  draft?: ReviewDraft | null
}

interface Section {
  id: SectionId
  title: string
  rows: InboxRow[]
}

type SectionId = 'waiting' | 'review' | 'drafts' | 'everything'

/** Case-insensitive match over a PR's title, number, and author display name. */
function matchesFilter(item: PullListItem, needle: string, botLogin: string): boolean {
  if (!needle) return true
  const { identity } = parseCommentIdentity(
    {
      user: item.pull.user,
      body: item.pull.body ?? '',
    },
    botLogin,
  )
  const authorName =
    identity.kind === 'human' ? identity.name : item.pull.user.login
  const haystack = `${item.pull.title} #${item.pull.number} ${authorName}`.toLowerCase()
  return haystack.includes(needle)
}

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

  const sections = useMemo<Section[]>(() => {
    const open = items.filter((it) => it.pull.state === 'open')
    const filtered = open.filter((it) => matchesFilter(it, needle, session.brokerLogin))

    const waiting = filtered.filter(
      (it) =>
        it.broker.authorHumanId === human.id && it.broker.unresolvedThreads > 0,
    )
    const toReview = filtered.filter(
      (it) =>
        it.broker.authorHumanId !== human.id &&
        it.broker.assignedReviewerHumanIds.includes(human.id),
    )
    const drafts = filtered.filter((it) => draftByNumber.has(it.pull.number))

    // "Everything else" is what none of the intent buckets claimed. A PR can be
    // both a draft-in-progress and something you owe a review; it appears in
    // every bucket it qualifies for but is excluded from the catch-all once any
    // earlier bucket named it.
    const claimed = new Set<number>()
    for (const it of [...waiting, ...toReview, ...drafts]) {
      claimed.add(it.pull.number)
    }
    const everything = filtered.filter((it) => !claimed.has(it.pull.number))

    const toRow = (it: PullListItem): InboxRow => ({
      item: it,
      draft: draftByNumber.get(it.pull.number) ?? null,
    })

    return [
      { id: 'waiting' as const, title: 'Waiting on you', rows: waiting.map(toRow) },
      { id: 'review' as const, title: 'To review', rows: toReview.map(toRow) },
      { id: 'drafts' as const, title: 'Drafts in progress', rows: drafts.map(toRow) },
      { id: 'everything' as const, title: 'Everything else', rows: everything.map(toRow) },
    ]
  }, [items, needle, human.id, draftByNumber, session.brokerLogin])

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
        if (flatRows.length === 0) return 0
        const next = Math.max(0, Math.min(flatRows.length - 1, i + delta))
        rowRefs.current[next]?.scrollIntoView({ block: 'nearest' })
        return next
      })
    },
    [flatRows.length],
  )

  useShortcut('j', () => moveFocus(1))
  useShortcut('k', () => moveFocus(-1))
  useShortcut('enter', () => {
    const row = flatRows[focusIndex]
    if (row) navigate(`/pr/${row.item.pull.number}`)
  })

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
          />
          <EmptyState
            className="mt-6"
            icon={<Inbox strokeWidth={1.5} />}
            title="Nothing open right now"
            hint="No open pull requests — when a contractor pushes a branch, it lands here."
          />
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
            // as a quiet reassurance when the human has authored open PRs.
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

/** The title row: name of the surface, the live-ness whisper, and the filter. */
function InboxHeader({
  dataUpdatedAt,
  filter,
  onFilter,
  rateResetAt,
  view,
  onView,
}: {
  dataUpdatedAt: number
  filter: string
  onFilter: (v: string) => void
  rateResetAt?: string
  view: 'list' | 'tree'
  onView: (v: 'list' | 'tree') => void
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
    focused: boolean
    onFocus: () => void
    /**
     * How deep this sits in its stack, in the tree arrangement. Indents the row
     * so a stack reads as one, and is absent in the list arrangement where
     * every row is a peer.
     */
    depth?: number
  }
>(({ row, showUnresolvedNumber, focused, onFocus, depth = 0 }, ref) => {
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
          <span className="w-12 shrink-0 font-mono text-xs text-ink-faint">
            #{pull.number}
          </span>

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

            {broker.canApprove && (
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
          <Skeleton className="h-7 w-56" />
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
