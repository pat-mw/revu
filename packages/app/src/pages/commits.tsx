import { useMemo, useState } from 'react'
import { useParams } from 'react-router'
import { ChevronDown, ChevronRight, GitCommitHorizontal } from 'lucide-react'
import { useSnapshot, useStaleness } from '@/state/queries'
import { relativeTime, shortSha } from '@/lib/time'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { SyncEmptyState, useSyncAction } from './pr-layout'

/**
 * The Commits tab: the snapshot's commit list, newest first. The list is a
 * point-in-time copy — when the live PR list says the remote has moved on, a
 * stale-gold banner names how many commits this snapshot is missing and offers
 * the one action that fixes it. Author names come from the git identity
 * (`commit.author.name`): commits carry the real human even though every API
 * write shows up as the shared App bot.
 */
export function CommitsPage() {
  const prNumber = Number(useParams<{ n: string }>().n)
  const snapshot = useSnapshot(prNumber).data
  const staleness = useStaleness(prNumber)
  const { run: runSync, isPending: syncing } = useSyncAction(prNumber)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const commits = useMemo(() => {
    if (!snapshot) return []
    return [...snapshot.immutable.commits].sort(
      (a, b) => Date.parse(b.commit.author.date) - Date.parse(a.commit.author.date),
    )
  }, [snapshot])

  if (snapshot === undefined) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-2 px-4 py-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-5/6" />
          <Skeleton className="h-9 w-full" />
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
            icon={<GitCommitHorizontal size={20} strokeWidth={1.5} />}
            title="Sync to see the commits"
            hint="Everything after sync is local."
          />
        </div>
      </div>
    )
  }

  const missing = staleness?.newCommits ?? 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-4">
        {missing > 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-(--radius-sm) border border-stale/35 bg-stale/10 px-3 py-2">
            <p className="text-sm text-stale">
              ⧗{' '}
              {missing === 1
                ? `1 newer commit isn't in this snapshot`
                : `${missing} newer commits aren't in this snapshot`}
            </p>
            <Button size="sm" onClick={runSync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Re-sync'}
            </Button>
          </div>
        )}

        {commits.length === 0 ? (
          <EmptyState
            icon={<GitCommitHorizontal size={20} strokeWidth={1.5} />}
            title="No commits in this snapshot"
            hint="Re-sync to pull the latest history."
            action={
              <Button size="sm" onClick={runSync} disabled={syncing}>
                {syncing ? 'Syncing…' : 'Re-sync'}
              </Button>
            }
          />
        ) : (
          <ul>
            {commits.map((c) => {
              const [subject, ...rest] = c.commit.message.split('\n')
              const body = rest.join('\n').trim()
              const open = expanded[c.sha] ?? false
              return (
                <li key={c.sha} className="hairline-b py-2">
                  <div className="flex items-start gap-2">
                    <span className="mt-px shrink-0 rounded-(--radius-xs) bg-raised px-1.5 py-px font-mono text-2xs text-ink-mut">
                      {shortSha(c.sha)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1">
                        {body !== '' && (
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-label={
                              open ? 'Hide full commit message' : 'Show full commit message'
                            }
                            onClick={() =>
                              setExpanded((prev) => ({ ...prev, [c.sha]: !open }))
                            }
                            className="-ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded-(--radius-xs) text-ink-faint hover:bg-raised hover:text-ink"
                          >
                            {open ? (
                              <ChevronDown size={14} strokeWidth={1.5} aria-hidden />
                            ) : (
                              <ChevronRight size={14} strokeWidth={1.5} aria-hidden />
                            )}
                          </button>
                        )}
                        <p className="min-w-0 truncate text-sm text-ink" title={subject}>
                          {subject}
                        </p>
                      </div>
                      {body !== '' && open && (
                        <pre className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-mut">
                          {body}
                        </pre>
                      )}
                    </div>
                    <span className="ml-2 flex shrink-0 items-center gap-2 text-2xs text-ink-mut">
                      {c.commit.author.name}
                      <span className="text-ink-faint">
                        {relativeTime(c.commit.author.date)}
                      </span>
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
