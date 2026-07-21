import { useMemo } from 'react'
import { Link, useParams } from 'react-router'
import { MessageSquare } from 'lucide-react'
import type { IssueComment, ReviewComment, ReviewSummary, ReviewThread } from '@revu/shared'
import { identityName, parseCommentIdentity } from '@revu/shared'
import type { CommentIdentity } from '@revu/shared'
import { useSnapshot } from '@/state/queries'
import { useThreads } from '@/state/threads'
import { useSession } from '@/state/session'
import { relativeTime } from '@/lib/time'
import { IdentityAvatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Markdown } from '@/components/ui/markdown'
import { Skeleton } from '@/components/ui/skeleton'
import { CommentView } from '@/components/threads/comment-view'
import { ThreadCard } from '@/components/threads/thread-card'
import { SyncEmptyState } from './pr-layout'

/**
 * The Conversation tab: the PR description, then issue comments and submitted
 * reviews merged into one chronological timeline, then review threads grouped
 * by file path. Everything renders from the cached snapshot — this page never
 * touches the network, which is why an unsynced PR shows a sync gate instead.
 */

// ————————————————————————————————————————————————————————————————
// Submitted-review rows
// ————————————————————————————————————————————————————————————————

const REVIEW_STATE_META: Record<
  ReviewSummary['state'],
  { label: string; variant: 'outline' | 'add' | 'del' | 'default' | 'draft' }
> = {
  COMMENTED: { label: 'commented', variant: 'outline' },
  APPROVED: { label: 'approved', variant: 'add' },
  CHANGES_REQUESTED: { label: 'changes requested', variant: 'del' },
  DISMISSED: { label: 'dismissed', variant: 'default' },
  PENDING: { label: 'pending', variant: 'draft' },
}

/**
 * A compact timeline row for a submitted review. Broker-authored review bodies
 * carry the smuggled human prefix, so identity parsing recovers who actually
 * approved/commented and yields the clean body to render.
 *
 * A review submitted as line comments alone has an empty body, and therefore
 * no prefix to recover the author from — it would otherwise show as the bare
 * bot. `attributedTo` supplies the identity its own line comments resolved to,
 * so the row names the reviewer even when the review itself says nothing.
 */
function ReviewRow({
  review,
  attributedTo,
  commentCount,
}: {
  review: ReviewSummary
  attributedTo?: CommentIdentity
  commentCount: number
}) {
  const session = useSession()
  const parsed = parseCommentIdentity({ user: review.user, body: review.body }, session.brokerLogin)
  const meta = REVIEW_STATE_META[review.state]
  const body = parsed.body.trim()
  // Only a body-less broker review needs the fallback: anything the prefix
  // resolved, or any genuine GitHub author, already names the right person.
  const identity =
    parsed.identity.kind === 'bot' && attributedTo !== undefined
      ? attributedTo
      : parsed.identity
  return (
    <article className="rounded-(--radius-sm) border border-line bg-panel px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <IdentityAvatar identity={identity} size="xs" />
        <span className="truncate text-sm font-medium text-ink">
          {identityName(identity)}
        </span>
        <Badge className="shrink-0" variant={meta.variant}>
          {meta.label}
        </Badge>
        {/* A review with no body is an envelope around its line comments, not
            a remark in its own right. Naming the count says what happened
            instead of leaving a row that reads as an empty message. */}
        {body === '' && commentCount > 0 && (
          <span className="shrink-0 text-2xs text-ink-faint">
            {commentCount} {commentCount === 1 ? 'comment' : 'comments'} on the diff
          </span>
        )}
        <span className="ml-auto shrink-0 text-2xs text-ink-faint">
          {relativeTime(review.submitted_at)}
        </span>
      </div>
      {body !== '' && (
        <div className="mt-1.5">
          <Markdown>{body}</Markdown>
        </div>
      )}
    </article>
  )
}

// ————————————————————————————————————————————————————————————————
// Timeline assembly
// ————————————————————————————————————————————————————————————————

type TimelineItem =
  | { kind: 'comment'; at: string; comment: IssueComment }
  | { kind: 'review'; at: string; review: ReviewSummary }

/**
 * Bridge an issue-level comment into the review-comment shape `CommentView`
 * accepts. The component reads only the vocabulary the two shapes share —
 * identity (user + body), timestamps, id, reactions — so the diff-anchor
 * fields are inert placeholders here; reaction writes go through the real
 * comment id, which the snapshot cache resolves for issue comments too.
 */
function asReviewCommentShape(comment: IssueComment): ReviewComment {
  return {
    id: comment.id,
    node_id: comment.node_id,
    pull_request_review_id: null,
    path: '',
    diff_hunk: '',
    commit_id: '',
    original_commit_id: '',
    line: null,
    original_line: null,
    start_line: null,
    original_start_line: null,
    side: 'RIGHT',
    start_side: null,
    subject_type: 'line',
    user: comment.user,
    body: comment.body,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    reactions: comment.reactions,
    html_url: '',
  }
}

/** Sort key for threads within a path group: open work first, history last. */
function threadRank(t: ReviewThread): number {
  if (t.isOutdated) return 2
  if (t.isResolved) return 1
  return 0
}

export function ConversationPage() {
  const prNumber = Number(useParams<{ n: string }>().n)
  const session = useSession()
  const snapshot = useSnapshot(prNumber).data
  const threads = useThreads(prNumber)

  const timeline = useMemo<TimelineItem[]>(() => {
    if (!snapshot) return []
    const items: TimelineItem[] = [
      ...snapshot.mutable.issueComments.map((comment) => ({
        kind: 'comment' as const,
        at: comment.created_at,
        comment,
      })),
      ...snapshot.mutable.reviews
        .filter((r) => r.state !== 'PENDING')
        .map((review) => ({ kind: 'review' as const, at: review.submitted_at, review })),
    ]
    return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  }, [snapshot])

  /**
   * Who each review is really from, and how much it carried, derived from its
   * own line comments. A review submitted as comments alone has an empty body
   * and so no smuggled prefix to read; its comments do carry one, and every
   * comment names the review it belongs to. Only unanimous attribution is
   * used — a review whose comments disagree is left to its literal author
   * rather than guessing.
   */
  const reviewAttribution = useMemo(() => {
    const byReview = new Map<number, { identity?: CommentIdentity; count: number }>()
    for (const thread of threads ?? []) {
      for (const comment of thread.comments) {
        const reviewId = comment.pull_request_review_id
        if (reviewId === null) continue
        const entry = byReview.get(reviewId) ?? { count: 0 }
        entry.count += 1
        const { identity } = parseCommentIdentity(comment, session.brokerLogin)
        if (entry.count === 1) entry.identity = identity
        else if (
          entry.identity !== undefined &&
          identityName(entry.identity) !== identityName(identity)
        ) {
          entry.identity = undefined
        }
        byReview.set(reviewId, entry)
      }
    }
    return byReview
  }, [threads, session.brokerLogin])

  const threadGroups = useMemo(() => {
    if (!threads) return []
    const byPath = new Map<string, ReviewThread[]>()
    for (const t of threads) {
      const group = byPath.get(t.path)
      if (group) group.push(t)
      else byPath.set(t.path, [t])
    }
    for (const group of byPath.values()) {
      group.sort((a, b) => threadRank(a) - threadRank(b))
    }
    return [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [threads])

  if (snapshot === undefined) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-3 px-4 py-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-5/6" />
          <Skeleton className="h-16 w-full" />
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
            icon={<MessageSquare size={20} strokeWidth={1.5} />}
            title="Sync to read the conversation"
            hint="Everything after sync is local."
          />
        </div>
      </div>
    )
  }

  const pull = snapshot.mutable.pull
  const description = parseCommentIdentity(
    { user: pull.user, body: pull.body ?? '' },
    session.brokerLogin,
  )
  const descriptionBody = description.body.trim()
  const isEmpty = timeline.length === 0 && (threads?.length ?? 0) === 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-4">
        <article className="rounded-(--radius-sm) border border-line bg-panel">
          <header className="hairline-b flex min-w-0 items-center gap-2 px-3 py-2">
            <IdentityAvatar identity={description.identity} size="xs" />
            <span className="truncate text-sm font-medium text-ink">
              {identityName(description.identity)}
            </span>
            <span className="shrink-0 text-2xs text-ink-mut">
              opened this pull request
            </span>
            <span className="ml-auto shrink-0 text-2xs text-ink-faint">
              {relativeTime(pull.created_at)}
            </span>
          </header>
          <div className="px-3 py-2">
            {descriptionBody !== '' ? (
              <Markdown>{descriptionBody}</Markdown>
            ) : (
              <p className="text-sm italic text-ink-faint">No description provided.</p>
            )}
          </div>
        </article>

        {isEmpty ? (
          <EmptyState
            className="mt-2"
            title="No discussion yet"
            hint="Open Files and leave the first comment (c on any line)."
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="../files">Open files</Link>
              </Button>
            }
          />
        ) : (
          <>
            {timeline.length > 0 && (
              <div className="mt-3 space-y-2">
                {timeline.map((entry) =>
                  entry.kind === 'comment' ? (
                    <div
                      key={`comment-${entry.comment.id}`}
                      className="rounded-(--radius-sm) border border-line bg-panel px-3 py-2"
                    >
                      <CommentView
                        prNumber={prNumber}
                        comment={asReviewCommentShape(entry.comment)}
                      />
                    </div>
                  ) : (
                    <ReviewRow
                      key={`review-${entry.review.id}`}
                      review={entry.review}
                      attributedTo={reviewAttribution.get(entry.review.id)?.identity}
                      commentCount={reviewAttribution.get(entry.review.id)?.count ?? 0}
                    />
                  ),
                )}
              </div>
            )}

            {threadGroups.length > 0 && (
              <section className="mt-4" aria-label="Review threads">
                <h2 className="hairline-b pb-1 font-display text-xs font-semibold uppercase tracking-wide text-ink-mut">
                  Review threads
                </h2>
                {threadGroups.map(([path, group]) => (
                  <div key={path} className="mt-3">
                    <h3
                      className="mb-1.5 truncate font-mono text-xs text-ink-mut"
                      title={path}
                    >
                      {path}
                    </h3>
                    <div className="space-y-2">
                      {group.map((thread) => (
                        <ThreadCard
                          key={thread.id}
                          prNumber={prNumber}
                          thread={thread}
                          variant="conversation"
                          showFileContext
                          defaultCollapsed={thread.isResolved || thread.isOutdated}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
