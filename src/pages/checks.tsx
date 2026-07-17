import { useState } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ListChecks,
  Lock,
  XCircle,
} from 'lucide-react'
import type { CheckRun } from '@/api/types'
import { useSnapshot } from '@/state/queries'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/cn'
import { EmptyState } from '@/components/ui/empty-state'
import { Markdown } from '@/components/ui/markdown'
import { Skeleton } from '@/components/ui/skeleton'
import { SyncEmptyState } from './pr-layout'

/**
 * The Checks tab: check runs from the cached snapshot with a pass/fail/running
 * rollup, expandable output (failures open by default — they're why anyone
 * comes here), and an honest note in place of the usual "view logs" link:
 * `details_url` points at github.com, which this workspace cannot reach, so
 * rendering it as a link would be a dead end dressed up as an affordance.
 */

/** A completed run whose conclusion means the check did not pass. */
function isFailure(check: CheckRun): boolean {
  return (
    check.status === 'completed' &&
    (check.conclusion === 'failure' ||
      check.conclusion === 'timed_out' ||
      check.conclusion === 'cancelled')
  )
}

function hasOutput(check: CheckRun): boolean {
  return Boolean(check.output.title || check.output.summary || check.output.text)
}

/** "2m 14s"-style elapsed time between two ISO timestamps. */
function formatDuration(startedAt: string, completedAt: string): string {
  const seconds = Math.max(
    0,
    Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000),
  )
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * Status glyph for a run. Shape carries the state alongside color (check vs. x
 * vs. hollow circle), and the wrapper announces it to screen readers.
 */
function StatusIcon({ check }: { check: CheckRun }) {
  let label: string
  let icon: ReactNode
  if (check.status === 'in_progress') {
    label = 'in progress'
    icon = <Circle size={15} strokeWidth={1.5} className="animate-pulse text-stale" aria-hidden />
  } else if (check.status === 'queued') {
    label = 'queued'
    icon = <Circle size={15} strokeWidth={1.5} className="text-ink-faint" aria-hidden />
  } else if (check.conclusion === 'success') {
    label = 'passed'
    icon = <CheckCircle2 size={15} strokeWidth={1.5} className="text-add" aria-hidden />
  } else if (isFailure(check)) {
    label = check.conclusion === 'failure' ? 'failed' : (check.conclusion ?? 'failed')
    icon = <XCircle size={15} strokeWidth={1.5} className="text-danger" aria-hidden />
  } else {
    label = check.conclusion ?? 'completed'
    icon = <Circle size={15} strokeWidth={1.5} className="text-ink-faint" aria-hidden />
  }
  return (
    <span role="img" aria-label={label} className="inline-flex shrink-0">
      {icon}
    </span>
  )
}

export function ChecksPage() {
  const prNumber = Number(useParams<{ n: string }>().n)
  const snapshot = useSnapshot(prNumber).data
  // User toggles override the default open state (failures start open).
  const [overrides, setOverrides] = useState<Record<number, boolean>>({})

  if (snapshot === undefined) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-4">
          <Skeleton className="mb-3 h-4 w-56" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-5/6" />
          </div>
        </div>
      </div>
    )
  }

  if (snapshot === null) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-4">
          <SyncEmptyState
            prNumber={prNumber}
            icon={<ListChecks size={20} strokeWidth={1.5} />}
            title="Sync to see the checks"
            hint="Everything after sync is local."
          />
        </div>
      </div>
    )
  }

  const checks = snapshot.mutable.checks
  let passed = 0
  let failed = 0
  let running = 0
  for (const c of checks) {
    if (c.status !== 'completed') running++
    else if (c.conclusion === 'success') passed++
    else if (isFailure(c)) failed++
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-4">
        {checks.length === 0 ? (
          <EmptyState
            icon={<ListChecks size={20} strokeWidth={1.5} />}
            title="No checks on this snapshot"
            hint="CI hasn't reported anything for this head commit."
          />
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-mut">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-add" aria-hidden />
                {passed} passed
              </span>
              <span className="text-ink-faint" aria-hidden>
                ·
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-danger" aria-hidden />
                {failed} failed
              </span>
              <span className="text-ink-faint" aria-hidden>
                ·
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={cn(
                    'size-1.5 rounded-full bg-stale',
                    running > 0 && 'animate-pulse',
                  )}
                  aria-hidden
                />
                {running} running
              </span>
            </div>

            <ul>
              {checks.map((check) => {
                const expandable = hasOutput(check)
                const open = expandable && (overrides[check.id] ?? isFailure(check))
                return (
                  <li key={check.id} className="hairline-b">
                    <div className="flex min-w-0 items-center gap-2 py-2">
                      <StatusIcon check={check} />
                      {expandable ? (
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-label={`${open ? 'Hide' : 'Show'} output for ${check.name}`}
                          onClick={() =>
                            setOverrides((prev) => ({ ...prev, [check.id]: !open }))
                          }
                          className="inline-flex size-4 shrink-0 items-center justify-center rounded-(--radius-xs) text-ink-faint hover:bg-raised hover:text-ink"
                        >
                          {open ? (
                            <ChevronDown size={14} strokeWidth={1.5} aria-hidden />
                          ) : (
                            <ChevronRight size={14} strokeWidth={1.5} aria-hidden />
                          )}
                        </button>
                      ) : (
                        <span className="size-4 shrink-0" aria-hidden />
                      )}
                      <span
                        className="min-w-0 truncate font-mono text-sm text-ink"
                        title={check.name}
                      >
                        {check.name}
                      </span>
                      {check.completed_at && (
                        <span className="shrink-0 text-2xs text-ink-faint">
                          {formatDuration(check.started_at, check.completed_at)}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-2xs text-ink-mut">
                        {relativeTime(check.started_at)}
                      </span>
                    </div>
                    {open && (
                      <div className="mb-2 ml-10 space-y-1.5">
                        {check.output.title && (
                          <p className="text-sm text-ink">{check.output.title}</p>
                        )}
                        {check.output.summary && (
                          <Markdown className="text-xs text-ink-mut">
                            {check.output.summary}
                          </Markdown>
                        )}
                        {check.output.text && (
                          <pre className="max-h-64 overflow-auto rounded-(--radius-xs) border border-line bg-canvas p-2 font-mono text-2xs leading-relaxed text-ink-mut">
                            {check.output.text}
                          </pre>
                        )}
                        <p className="flex items-center gap-1.5 text-2xs text-ink-faint">
                          <Lock size={12} strokeWidth={1.5} aria-hidden />
                          logs live on github.com — not reachable from this workspace
                        </p>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
