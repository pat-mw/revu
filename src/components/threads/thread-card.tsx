import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Check, ChevronDown } from 'lucide-react'
import type { ReviewThread } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { identityName, parseCommentIdentity } from '@/lib/identity'
import { useShortcut } from '@/lib/keyboard'
import { useReplyToThread, useResolveThread } from '@/state/threads'
import { useFilesView } from '@/state/files-view'
import { CommentComposer } from './composer'
import { CommentView } from './comment-view'

export interface ThreadCardProps {
  prNumber: number
  thread: ReviewThread
  /**
   * Where the card sits: 'inline' floats inside the diff (offset past the
   * gutter, width-capped), 'conversation' fills the timeline column, 'queue'
   * fills the author queue dock with tighter paddings.
   */
  variant: 'inline' | 'conversation' | 'queue'
  /** Initial collapse; defaults to collapsed for resolved and outdated threads. */
  defaultCollapsed?: boolean
  /** Show a clickable path:line that jumps to the thread's anchor in the diff. */
  showFileContext?: boolean
  /** Caller-managed focus: draws a ring and arms the r / x shortcuts. */
  focused?: boolean
  /** Commits that landed after this thread opened — flagged on open threads. */
  commitsSince?: number
}

/** How many replies a chain may show before the middle collapses. */
const REPLY_COLLAPSE_THRESHOLD = 4

/** One-line excerpt of a comment body for the collapsed-resolved form. */
function excerptOf(body: string, max = 60): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat
}

/**
 * The first comment's diff_hunk, rendered as the code context an outdated
 * thread was anchored to before later commits changed the file. Each line is
 * tinted by its unified-diff marker.
 */
function OutdatedHunk({ hunk }: { hunk: string }) {
  return (
    <div className="mb-2">
      <div className="mb-1 text-2xs text-stale">
        original diff — this code changed since
      </div>
      <div className="max-h-56 overflow-auto rounded-(--radius-xs) border border-line bg-canvas py-0.5">
        {hunk.split('\n').map((line, i) => {
          const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : null
          const isHeader = line.startsWith('@@')
          return (
            <div
              key={i}
              data-kind={kind ?? undefined}
              className={cn(
                'diff-line px-2',
                isHeader ? 'text-ink-faint' : kind ? 'text-ink' : 'text-ink-mut',
              )}
            >
              {line.length > 0 ? line : ' '}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * A review thread: status header, comment chain, reply/resolve footer. The
 * card carries `id="thread-{id}"` so hash deep-links and jump targets can find
 * it; scrolling a focused card into view is the caller's job.
 *
 * Collapse behavior: resolved threads shrink to one quiet line, outdated
 * threads to their header. Reply is optimistic — the composer closes on
 * submit and reopens refilled if the write fails, so typed text survives.
 */
export function ThreadCard({
  prNumber,
  thread,
  variant,
  defaultCollapsed,
  showFileContext,
  focused,
  commitsSince,
}: ThreadCardProps) {
  const [collapsed, setCollapsed] = useState<boolean>(
    defaultCollapsed ?? (thread.isResolved || thread.isOutdated),
  )
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [showAllReplies, setShowAllReplies] = useState(false)

  const reply = useReplyToThread(prNumber)
  const resolve = useResolveThread(prNumber)
  const { toast } = useToast()
  const navigate = useNavigate()
  const filesView = useFilesView()

  const comments = thread.comments
  const first = comments.length > 0 ? comments[0] : null
  const replies = comments.slice(1)
  const firstParsed = first ? parseCommentIdentity(first) : null

  /** In-place jump on the files page; a hash navigation from anywhere else. */
  const jumpToThread = () => {
    if (filesView) {
      filesView.jumpTo({ path: thread.path, threadId: thread.id })
    } else {
      navigate(`/pr/${prNumber}/files#thread-${thread.id}`)
    }
  }

  const openReply = () => {
    setCollapsed(false)
    setReplyOpen(true)
  }

  const toggleResolve = () => {
    const next = !thread.isResolved
    resolve.mutate(
      { threadId: thread.id, resolved: next },
      {
        onError: (error) => {
          toast({
            kind: 'error',
            title: next ? "Couldn't resolve the thread" : "Couldn't unresolve the thread",
            detail: `${error.message} The thread was left as it was — try again.`,
          })
        },
      },
    )
  }

  const submitReply = () => {
    const body = replyText
    if (body.trim() === '') return
    // Optimistic: close and clear immediately; on failure the mutation context
    // carries the exact text back so nothing typed is ever lost.
    setReplyOpen(false)
    setReplyText('')
    reply.mutate(
      { threadId: thread.id, body },
      {
        onError: (error, _vars, ctx) => {
          setReplyText(ctx?.restoredText ?? body)
          setReplyOpen(true)
          toast({
            kind: 'error',
            title: 'Reply failed to post',
            detail: `${error.message} — your text is restored, nothing was lost.`,
          })
        },
      },
    )
  }

  // Focus-scoped keys. The registry's last-registered-wins rule means the
  // currently focused card (whose `enabled` flipped most recently) owns them.
  useShortcut('r', openReply, { enabled: !!focused })
  useShortcut('x', toggleResolve, { enabled: !!focused })

  const isQueue = variant === 'queue'
  const padX = isQueue ? 'px-1.5' : 'px-2'
  const variantClass = {
    inline: 'my-1 ml-[92px] max-w-3xl',
    conversation: 'w-full',
    queue: 'w-full text-sm',
  }[variant]

  // Deep reply chains middle-collapse: first two, a "show more" row, last one.
  const middleCollapsed = replies.length > REPLY_COLLAPSE_THRESHOLD && !showAllReplies
  const headReplies = middleCollapsed ? replies.slice(0, 2) : replies
  const tailReply = middleCollapsed ? replies[replies.length - 1] : null
  const hiddenReplyCount = replies.length - 3

  const resolveProminent = !thread.isResolved && (variant === 'queue' || variant === 'inline')
  const anchorLine = thread.line ?? thread.originalLine

  return (
    <section
      id={`thread-${thread.id}`}
      aria-label={`Review thread on ${thread.path}`}
      className={cn(
        'overflow-hidden rounded-(--radius-sm) border border-line bg-panel',
        focused && 'ring-1 ring-ink',
        variantClass,
      )}
    >
      {collapsed && thread.isResolved ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          className={cn(
            'flex h-7 w-full min-w-0 items-center gap-2 text-left text-2xs text-ink-faint transition-colors hover:bg-raised',
            padX,
          )}
        >
          <Check size={13} strokeWidth={1.5} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {firstParsed
              ? `${identityName(firstParsed.identity)}: ${excerptOf(firstParsed.body)}`
              : 'Resolved thread'}
          </span>
          <span className="shrink-0">
            {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
          </span>
        </button>
      ) : (
        <>
          <header className={cn('flex h-7 min-w-0 items-center gap-2 text-2xs', padX)}>
            {!thread.isResolved && !thread.isOutdated && (
              <span className="flex shrink-0 items-center gap-1.5 text-ink-mut">
                <span className="size-1.5 rounded-full bg-ink" aria-hidden />
                open
              </span>
            )}
            {thread.isResolved && (
              <Badge variant="resolved" className="shrink-0">
                resolved{thread.resolvedBy ? ` by ${thread.resolvedBy.login}` : ''}
              </Badge>
            )}
            {thread.isOutdated && (
              <Badge variant="stale" className="shrink-0">
                outdated
              </Badge>
            )}
            {showFileContext && (
              <button
                type="button"
                onClick={jumpToThread}
                title={`Jump to ${thread.path} in the diff`}
                className="min-w-0 truncate font-mono text-ink-mut transition-colors hover:text-ink"
              >
                {thread.path}
                {anchorLine != null ? `:${anchorLine}` : ''}
              </button>
            )}
            {(commitsSince ?? 0) > 0 && !thread.isResolved && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="stale" tabIndex={0} className="shrink-0">
                    +{commitsSince} commits since
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Commits landed after this thread opened — it may already be addressed.
                </TooltipContent>
              </Tooltip>
            )}
            <span className="ml-auto shrink-0 text-ink-faint">
              {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
            </span>
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand thread' : 'Collapse thread'}
              className="flex size-5 shrink-0 items-center justify-center rounded-(--radius-xs) text-ink-faint transition-colors hover:bg-raised hover:text-ink"
            >
              <ChevronDown
                size={14}
                strokeWidth={1.5}
                className={cn('transition-transform', collapsed && '-rotate-90')}
                aria-hidden
              />
            </button>
          </header>
          {!collapsed && (
            <>
              <div className={cn('border-t border-line', padX, isQueue ? 'py-1.5' : 'py-2')}>
                {thread.isOutdated && first && first.diff_hunk !== '' && (
                  <OutdatedHunk hunk={first.diff_hunk} />
                )}
                {first ? (
                  <CommentView prNumber={prNumber} comment={first} />
                ) : (
                  <p className="text-2xs text-ink-faint">This thread has no comments.</p>
                )}
                {replies.length > 0 && (
                  <div className="mt-2 space-y-3 border-l border-line pl-6">
                    {headReplies.map((c) => (
                      <CommentView key={c.id} prNumber={prNumber} comment={c} />
                    ))}
                    {middleCollapsed && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start text-2xs text-ink-faint"
                          onClick={() => setShowAllReplies(true)}
                        >
                          show {hiddenReplyCount} more replies
                        </Button>
                        {tailReply && (
                          <CommentView prNumber={prNumber} comment={tailReply} />
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
              <footer
                className={cn('border-t border-line', padX, isQueue ? 'py-1' : 'py-1.5')}
              >
                {replyOpen ? (
                  <CommentComposer
                    value={replyText}
                    onChange={setReplyText}
                    onSubmit={submitReply}
                    onCancel={() => setReplyOpen(false)}
                    submitLabel="Reply"
                    placeholder="Reply…"
                    autoFocus
                    compact
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={openReply}>
                      Reply
                    </Button>
                    <Button
                      variant={resolveProminent ? 'outline' : 'ghost'}
                      size="sm"
                      disabled={resolve.isPending}
                      onClick={toggleResolve}
                    >
                      {thread.isResolved ? 'Unresolve' : 'Resolve'}
                    </Button>
                  </div>
                )}
              </footer>
            </>
          )}
        </>
      )}
    </section>
  )
}
ThreadCard.displayName = 'ThreadCard'
