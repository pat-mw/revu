import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpLeft, CheckCheck, ChevronDown, ChevronUp, X } from 'lucide-react'
import type { CommitInfo, ReviewThread } from '@/api/types'
import { ThreadCard } from '@/components/threads/thread-card'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Kbd } from '@/components/ui/kbd'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { parseCommentIdentity } from '@/lib/identity'
import { useShortcut } from '@/lib/keyboard'
import { useFilesView } from '@/state/files-view'
import { useSnapshot } from '@/state/queries'
import { useResolveThread, useThreads } from '@/state/threads'

/**
 * The walk order: unresolved threads only, current (non-outdated) ones first,
 * outdated-but-unresolved after them, each group sorted by file path and then
 * by anchor line (falling back to the original line for outdated threads).
 */
function orderQueue(threads: ReviewThread[]): ReviewThread[] {
  const anchorLine = (t: ReviewThread) => t.line ?? t.originalLine ?? 0
  return threads
    .filter((t) => !t.isResolved)
    .sort((a, b) => {
      if (a.isOutdated !== b.isOutdated) return a.isOutdated ? 1 : -1
      if (a.path !== b.path) return a.path < b.path ? -1 : 1
      return anchorLine(a) - anchorLine(b)
    })
}

/**
 * Commits that landed after a thread opened — dated against the thread's
 * first comment, counted over the snapshot's commit list. Flags feedback the
 * author may have already addressed with a later push.
 */
function countCommitsSince(commits: CommitInfo[], thread: ReviewThread): number {
  const first = thread.comments.length > 0 ? thread.comments[0] : null
  if (!first) return 0
  const openedAt = new Date(first.created_at).getTime()
  let count = 0
  for (const c of commits) {
    if (new Date(c.commit.author.date).getTime() > openedAt) count++
  }
  return count
}

/** One-line excerpt of a comment body for the minimap rows. */
function excerptOf(body: string, max = 72): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat
}

/**
 * The unresolved-thread queue: a right-docked panel on the files page that
 * walks review feedback one thread at a time instead of making the reader
 * hunt through the diff. The files page mounts it while its queue-open flag
 * is set; it is deliberately not gated on PR authorship — the author banner
 * is the author-mode entry, but any reviewer may walk unresolved threads.
 *
 * Selection is held by thread id, never by index. Resolving the current
 * thread (optimistically) drops it out of the queue, and the selection snaps
 * to the entry that sat after it in the previous ordering — or the one before
 * it when the departed thread was last — so "Resolve & next" is a single
 * motion and a mid-walk refetch can't silently retarget the reader.
 *
 * Keys owned here while mounted: j/n next, k/p previous. The files page
 * disables its own overlapping bindings while the queue is open, and the
 * focused ThreadCard carries r (reply) and x (resolve) itself.
 */
export function AuthorQueue({ prNumber }: { prNumber: number }) {
  const threads = useThreads(prNumber)
  const snapshot = useSnapshot(prNumber).data
  const filesView = useFilesView()
  const resolve = useResolveThread(prNumber)
  const { toast } = useToast()

  const [currentId, setCurrentId] = useState<string | null>(null)
  /** Ordering as of the previous commit — where a departed id used to sit. */
  const prevOrderRef = useRef<string[]>([])
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const queue = useMemo(() => orderQueue(threads ?? []), [threads])
  const queueIds = useMemo(() => queue.map((t) => t.id), [queue])

  /**
   * The id actually rendered this pass: the stored id while it is still
   * queued; otherwise the nearest survivor to where it used to sit (forward
   * first, then backward); otherwise the head of the queue.
   */
  const effectiveId = useMemo(() => {
    if (queueIds.length === 0) return null
    if (currentId !== null && queueIds.includes(currentId)) return currentId
    if (currentId !== null) {
      const prevOrder = prevOrderRef.current
      const departedAt = prevOrder.indexOf(currentId)
      if (departedAt !== -1) {
        for (let i = departedAt + 1; i < prevOrder.length; i++) {
          if (queueIds.includes(prevOrder[i])) return prevOrder[i]
        }
        for (let i = departedAt - 1; i >= 0; i--) {
          if (queueIds.includes(prevOrder[i])) return prevOrder[i]
        }
      }
    }
    return queueIds[0]
  }, [queueIds, currentId])

  // Commit the snap into state and remember this ordering for the next
  // departure. Runs after paint, so the fallback above already rendered.
  useEffect(() => {
    prevOrderRef.current = queueIds
    if (effectiveId !== currentId) setCurrentId(effectiveId)
  }, [queueIds, effectiveId, currentId])

  const pos = effectiveId === null ? -1 : queueIds.indexOf(effectiveId)
  const current = pos >= 0 ? queue[pos] : null

  const step = (delta: number) => {
    if (queue.length === 0) return
    const from = pos < 0 ? 0 : pos
    const next = Math.min(queue.length - 1, Math.max(0, from + delta))
    setCurrentId(queue[next].id)
  }

  const hasQueue = queue.length > 0
  useShortcut('j', () => step(1), { enabled: hasQueue })
  useShortcut('n', () => step(1), { enabled: hasQueue })
  useShortcut('k', () => step(-1), { enabled: hasQueue })
  useShortcut('p', () => step(-1), { enabled: hasQueue })

  // A fresh thread starts reading from its top.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [effectiveId])

  /**
   * The optimistic resolve removes the thread from the queue immediately,
   * and the id-based selection snaps to its successor — that snap IS the
   * advance. On failure the rollback puts the thread back (still unresolved)
   * and the toast names it.
   */
  const resolveAndNext = () => {
    if (!current) return
    resolve.mutate(
      { threadId: current.id, resolved: true },
      {
        onError: (error) => {
          toast({
            kind: 'error',
            title: "Couldn't resolve the thread",
            detail: `${error.message} The thread is back in the queue — try again.`,
          })
        },
      },
    )
  }

  const resolvedCount = useMemo(
    () => (threads ?? []).filter((t) => t.isResolved).length,
    [threads],
  )
  const commitsSinceCurrent =
    current && snapshot ? countCommitsSince(snapshot.immutable.commits, current) : 0

  return (
    <aside
      aria-label="Unresolved thread queue"
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-l border-line bg-canvas"
    >
      <header className="hairline-b flex h-9 flex-none items-center gap-1 px-3">
        <h2 className="min-w-0 truncate font-display text-sm text-ink">
          Unresolved · {hasQueue ? `${pos + 1} of ${queue.length}` : '0 of 0'}
        </h2>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Previous thread"
            disabled={pos <= 0}
            onClick={() => step(-1)}
          >
            <ChevronUp strokeWidth={1.5} aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Next thread"
            disabled={pos < 0 || pos >= queue.length - 1}
            onClick={() => step(1)}
          >
            <ChevronDown strokeWidth={1.5} aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Close queue"
            onClick={() => filesView?.setQueueOpen(false)}
          >
            <X strokeWidth={1.5} aria-hidden />
          </Button>
        </div>
      </header>

      {!hasQueue ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
          <EmptyState
            icon={<CheckCheck size={20} strokeWidth={1.5} />}
            title="Queue clear"
            hint={`${resolvedCount} thread${resolvedCount === 1 ? '' : 's'} resolved on this PR. New comments will land here.`}
            action={
              <Button size="sm" onClick={() => filesView?.setQueueOpen(false)}>
                Close queue
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto p-2">
            {current && (
              <>
                <div className="mb-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      filesView?.jumpTo({ path: current.path, threadId: current.id })
                    }
                  >
                    <ArrowUpLeft strokeWidth={1.5} aria-hidden />
                    Jump to code
                  </Button>
                </div>
                <ThreadCard
                  key={current.id}
                  prNumber={prNumber}
                  thread={current}
                  variant="queue"
                  defaultCollapsed={false}
                  showFileContext
                  focused
                  commitsSince={commitsSinceCurrent}
                />
              </>
            )}
          </div>

          <nav
            aria-label="All queued threads"
            className="hairline-t max-h-48 flex-none overflow-y-auto p-1"
          >
            {queue.map((t) => {
              const isCurrent = t.id === effectiveId
              const line = t.line ?? t.originalLine
              const first = t.comments.length > 0 ? t.comments[0] : null
              const excerpt = first
                ? excerptOf(parseCommentIdentity(first).body)
                : 'No comments'
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setCurrentId(t.id)}
                  aria-current={isCurrent || undefined}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-1.5 rounded-(--radius-xs) px-1.5 py-1 text-left transition-colors hover:bg-raised',
                    isCurrent && 'bg-raised',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      t.isOutdated ? 'bg-stale' : 'bg-ink',
                    )}
                    aria-hidden
                  />
                  <span className="max-w-[45%] shrink-0 truncate font-mono text-2xs text-ink-mut">
                    {t.path}
                    {line != null ? `:${line}` : ''}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-2xs text-ink-faint">
                    {excerpt}
                  </span>
                </button>
              )
            })}
          </nav>

          <footer className="hairline-t flex h-9 flex-none items-center gap-2 px-3">
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={!current || resolve.isPending}
              onClick={resolveAndNext}
            >
              Resolve & next
            </Button>
            <span className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-2xs text-ink-faint">
              <span className="flex items-center gap-1">
                <Kbd keys={['j']} />
                <Kbd keys={['k']} />
                next/prev
              </span>
              <span className="flex items-center gap-1">
                <Kbd keys={['r']} /> reply
              </span>
              <span className="flex items-center gap-1">
                <Kbd keys={['x']} /> resolve
              </span>
            </span>
          </footer>
        </>
      )}
    </aside>
  )
}
AuthorQueue.displayName = 'AuthorQueue'
